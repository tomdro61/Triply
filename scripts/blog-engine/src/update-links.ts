/**
 * update-links.ts — Inject parent→child internal links into published hub/sub-pillar articles.
 *
 * After children (sub-pillars/spokes) are published, their parent articles should
 * link to them. This command finds parents missing links and uses Claude to
 * surgically insert contextual links into the existing HTML content.
 *
 * Usage:
 *   npm run update-links -- -a JFK
 *   npm run update-links -- -a JFK --dry-run
 *   npm run update-links -- -a JFK --hub-only
 *
 * Second mode — booking-page CTA links (deterministic, no LLM, no cost):
 *   npm run update-links -- -a JFK --booking-links --dry-run
 *   npm run update-links -- -a ALL --booking-links --dry-run
 *   npm run update-links -- -a ALL --booking-links --apply
 * See booking-links.ts. It appends ONE CTA paragraph pointing at the airport's
 * /<slug>/airport-parking booking page to any published post that lacks one.
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import Anthropic from '@anthropic-ai/sdk'
import { Command } from 'commander'
import { env, CLAUDE_MODEL, BLOG_BASE_URL } from './config.js'
import { getAllPublishedSlugs, updatePost } from './payload.js'
import { lexicalToHtml, countNodesOfType } from './lexical-to-html.js'
import { htmlToLexical } from './html-to-lexical.js'
import { runBookingLinks } from './booking-links.js'
import { pingIndexNow, postUrlFor } from './indexnow.js'

const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })
const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Write Claude's HTML to reports/ for a skipped save; a failed dump is a warning, never an abort. */
function dumpForDiagnosis(slug: string, kind: 'link-loss' | 'image-loss', html: string): void {
  const dir = path.join(ENGINE_ROOT, 'reports')
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `${kind}-${slug}.html`), html)
  } catch (e) {
    console.log(`     ⚠ could not write dump: ${e}`)
  }
}

interface PublishedPostFull {
  id: string
  slug: string
  title: string
  articleType: string
  airportCode: string
  parentSlug?: string
  hubSlug?: string
  content: unknown
}

async function fetchPublishedPosts(airportCode: string): Promise<PublishedPostFull[]> {
  // Paginate through ALL published posts. A single capped pull (e.g. limit 200)
  // silently drops rows once a cluster exceeds the cap — and because Payload
  // returns newest-first, the dropped rows are the OLDEST, which are exactly the
  // hub + sub-pillars (created before their spokes) that this tool needs as
  // parents. LAS (240 posts) was the first cluster to trip this.
  const all: PublishedPostFull[] = []
  let page = 1
  while (true) {
    const params = new URLSearchParams({
      'where[status][equals]': 'published',
      'where[airportCode][equals]': airportCode.toUpperCase(),
      limit: '200',
      page: String(page),
    })

    const url = `${env.PAYLOAD_CMS_URL}/api/posts?${params.toString()}`
    const res = await fetch(url, {
      headers: { Authorization: `users API-Key ${env.PAYLOAD_API_KEY}` },
    })

    if (!res.ok) {
      throw new Error(`Failed to fetch posts: ${res.status} ${await res.text()}`)
    }

    const data = await res.json()
    for (const doc of (data.docs || []) as Record<string, unknown>[]) {
      all.push({
        id: doc.id as string,
        slug: doc.slug as string,
        title: doc.title as string,
        articleType: (doc.articleType as string) || 'spoke',
        airportCode: (doc.airportCode as string) || '',
        parentSlug: (doc.parentSlug as string) || undefined,
        hubSlug: (doc.hubSlug as string) || undefined,
        content: doc.content,
      })
    }

    if (!data.hasNextPage) break
    page++
  }
  return all
}

function findMissingChildLinks(
  parent: PublishedPostFull,
  allPosts: PublishedPostFull[],
  html: string
): PublishedPostFull[] {
  // Find children of this parent
  const children = allPosts.filter((p) => {
    if (parent.articleType === 'hub') {
      return p.articleType === 'sub-pillar' && p.hubSlug === parent.slug
    }
    if (parent.articleType === 'sub-pillar') {
      return p.articleType === 'spoke' && p.parentSlug === parent.slug
    }
    return false
  })

  // Filter to only children not already linked
  return children.filter((child) => {
    const linkPattern = `${BLOG_BASE_URL}/${child.slug}`
    return !html.includes(linkPattern)
  })
}

function extractJsonString(text: string): string {
  let jsonStr = text.trim()
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*)```\s*$/)
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim()
  }
  if (!jsonStr.startsWith('{') && !jsonStr.startsWith('[')) {
    const start = jsonStr.indexOf('{')
    const end = jsonStr.lastIndexOf('}')
    if (start !== -1 && end !== -1 && end > start) {
      jsonStr = jsonStr.slice(start, end + 1)
    }
  }
  return jsonStr
}

async function injectLinks(
  html: string,
  parent: PublishedPostFull,
  missingChildren: PublishedPostFull[]
): Promise<string> {
  const childList = missingChildren
    .map((c) => `- "${c.title}" → ${BLOG_BASE_URL}/${c.slug} (${c.articleType})`)
    .join('\n')

  const prompt = `You are editing an existing blog article to add internal links to newly published child articles.

**Parent article:** "${parent.title}" (${parent.articleType})
**Parent slug:** ${parent.slug}

**Child articles that need links added:**
${childList}

**Current HTML content:**
${html}

**Instructions:**
1. For each child article, find the most contextually relevant section in the HTML
2. Insert a natural-sounding link within existing text, OR add a short sentence with the link
3. Do NOT rewrite or restructure the existing content — make minimal, surgical edits
4. Links should use format: <a href="${BLOG_BASE_URL}/[slug]">anchor text</a>
5. Anchor text should be descriptive and natural (not "click here")
6. For hub articles, links to sub-pillars often fit in section introductions
7. For sub-pillars, links to spokes fit as "for more on X, see our guide" patterns

Respond with ONLY valid JSON:
{
  "html": "the full updated HTML with links injected",
  "linksAdded": [
    {"slug": "child-slug", "anchorText": "text used for link", "location": "brief description of where inserted"}
  ]
}`

  const response = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 16384,
    messages: [{ role: 'user', content: prompt }],
  })

  const text = response.content[0].type === 'text' ? response.content[0].text : ''
  const jsonStr = extractJsonString(text)
  const result = JSON.parse(jsonStr)

  return result.html
}

function verifyLinksInjected(html: string, children: PublishedPostFull[]): { found: string[]; missing: string[] } {
  const found: string[] = []
  const missing: string[] = []

  for (const child of children) {
    const linkPattern = `${BLOG_BASE_URL}/${child.slug}`
    if (html.includes(linkPattern)) {
      found.push(child.slug)
    } else {
      missing.push(child.slug)
    }
  }

  return { found, missing }
}

const program = new Command()
  .name('update-links')
  .description('Inject internal links from parent articles to their published children')
  .requiredOption('-a, --airport <code>', 'Airport code (e.g., JFK), or ALL with --booking-links')
  .option('--dry-run', 'Preview what would be updated without saving')
  .option('--hub-only', 'Only update hub articles (skip sub-pillars)')
  .option('--booking-links', 'Booking-page CTA mode: append one CTA linking each published post to its airport booking page (deterministic, no LLM)')
  .option('--apply', '--booking-links only: actually PATCH content (default is dry run)')
  .option('--limit <n>', '--booking-links only: cap posts changed per airport', (v: string) => parseInt(v, 10))
  .option('--verbose', '--booking-links only: also log posts that are skipped')
  .action(async (options) => {
    try {
      // ── Mode 2: booking-page CTA links. Deterministic, no Claude call.
      // Dry run unless --apply is passed explicitly.
      if (options.bookingLinks) {
        await runBookingLinks({
          airport: options.airport,
          // --dry-run always wins over --apply, so a stray --apply on a command
          // that was meant to be a preview cannot write to 3,700 live posts.
          apply: Boolean(options.apply) && !options.dryRun,
          verbose: Boolean(options.verbose),
          limit: options.limit,
        })
        return
      }

      const code = options.airport.toUpperCase()
      console.log(`\n🔗 Triply Blog Engine — Update Links\n`)
      console.log(`Airport: ${code}${options.dryRun ? ' (DRY RUN)' : ''}${options.hubOnly ? ' (hub only)' : ''}\n`)

      // Fetch all published posts for this airport
      const posts = await fetchPublishedPosts(code)
      console.log(`Found ${posts.length} published post(s) for ${code}\n`)

      if (posts.length === 0) return

      // Find parent articles (hubs and sub-pillars)
      let parents = posts.filter((p) => p.articleType === 'hub' || p.articleType === 'sub-pillar')
      if (options.hubOnly) {
        parents = parents.filter((p) => p.articleType === 'hub')
      }

      let updated = 0
      let skipped = 0

      for (const parent of parents) {
        // Convert Lexical content to HTML
        const html = parent.content ? lexicalToHtml(parent.content as Parameters<typeof lexicalToHtml>[0]) : ''
        if (!html) {
          console.log(`  ⏭ ${parent.slug} — no content, skipping`)
          skipped++
          continue
        }

        // Find missing child links
        const missingChildren = findMissingChildLinks(parent, posts, html)
        if (missingChildren.length === 0) {
          console.log(`  ✓ ${parent.slug} — all child links present`)
          skipped++
          continue
        }

        console.log(`  📝 ${parent.slug} — missing ${missingChildren.length} link(s):`)
        for (const child of missingChildren) {
          console.log(`     → ${child.slug} ("${child.title}")`)
        }

        if (options.dryRun) {
          console.log(`     [DRY RUN] Would inject links\n`)
          continue
        }

        // Use Claude to inject links. Wrap per-parent so one bad response
        // (e.g. Claude returns malformed JSON that JSON.parse can't handle)
        // skips just this parent instead of aborting the whole link pass.
        try {
          console.log(`     Injecting links with Claude...`)
          const updatedHtml = await injectLinks(html, parent, missingChildren)

          // Verify links were actually injected
          const verification = verifyLinksInjected(updatedHtml, missingChildren)
          if (verification.found.length === 0) {
            console.log(`     ⚠ Claude did not inject any links — skipping save`)
            skipped++
            continue
          }

          if (verification.missing.length > 0) {
            console.log(`     ⚠ ${verification.missing.length} link(s) not injected: ${verification.missing.join(', ')}`)
          }

          // Convert back to Lexical, then verify AGAIN on the round-tripped
          // HTML — the LLM sometimes places anchors where htmlToLexical drops
          // them (found 2026-09-18: "Saved — 10 links" with 0 persisted).
          const lexicalContent = htmlToLexical(updatedHtml)
          const persisted = verifyLinksInjected(lexicalToHtml(lexicalContent), missingChildren)
          if (persisted.found.length === 0) {
            dumpForDiagnosis(parent.slug, 'link-loss', updatedHtml)
            console.log(`     ⚠ links present in Claude's HTML but lost in HTML→Lexical — skipping save`)
            skipped++
            continue
          }
          // Only the links Claude DID inject that then vanished — not the ones
          // it never wrote (those were reported above).
          const lost = verification.found.filter((slug) => persisted.missing.includes(slug))
          if (lost.length > 0) {
            console.log(`     ⚠ ${lost.length} link(s) lost in HTML→Lexical: ${lost.join(', ')}`)
          }

          // Images are the other thing a round trip can silently eat. Every
          // inline infographic is an `upload` node; if the round-tripped doc has
          // fewer than the original, saving would delete images from a live post
          // while reporting success. Never save a lossy round trip.
          const uploadsBefore = countNodesOfType(parent.content as Parameters<typeof lexicalToHtml>[0], 'upload')
          const uploadsAfter = countNodesOfType(lexicalContent as Parameters<typeof lexicalToHtml>[0], 'upload')
          if (uploadsAfter < uploadsBefore) {
            dumpForDiagnosis(parent.slug, 'image-loss', updatedHtml)
            console.log(`     ⚠ ${uploadsBefore - uploadsAfter} of ${uploadsBefore} image(s) would be lost in HTML→Lexical — skipping save`)
            skipped++
            continue
          }
          await updatePost(parent.id, { content: lexicalContent })
          await pingIndexNow([postUrlFor(parent.slug)])

          console.log(`     ✓ Saved — ${persisted.found.length} link(s) added\n`)
          updated++
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          console.log(`     ✗ ${parent.slug} — link injection failed, skipping: ${msg.slice(0, 160)}\n`)
          skipped++
          continue
        }
      }

      console.log(`\n━━━ Summary ━━━`)
      console.log(`  Updated: ${updated}`)
      console.log(`  Skipped: ${skipped}`)
      console.log('')
    } catch (err) {
      console.error('Error:', err)
      process.exit(1)
    }
  })

program.parse()
