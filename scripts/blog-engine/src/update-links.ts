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
 */

import Anthropic from '@anthropic-ai/sdk'
import { Command } from 'commander'
import { env, CLAUDE_MODEL, BLOG_BASE_URL } from './config.js'
import { getAllPublishedSlugs, updatePost } from './payload.js'
import { lexicalToHtml } from './lexical-to-html.js'
import { htmlToLexical } from './html-to-lexical.js'

const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })

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
  const params = new URLSearchParams({
    'where[status][equals]': 'published',
    'where[airportCode][equals]': airportCode.toUpperCase(),
    limit: '200',
  })

  const url = `${env.PAYLOAD_CMS_URL}/api/posts?${params.toString()}`
  const res = await fetch(url, {
    headers: { Authorization: `users API-Key ${env.PAYLOAD_API_KEY}` },
  })

  if (!res.ok) {
    throw new Error(`Failed to fetch posts: ${res.status} ${await res.text()}`)
  }

  const data = await res.json()
  return (data.docs || []).map((doc: Record<string, unknown>) => ({
    id: doc.id as string,
    slug: doc.slug as string,
    title: doc.title as string,
    articleType: (doc.articleType as string) || 'spoke',
    airportCode: (doc.airportCode as string) || '',
    parentSlug: (doc.parentSlug as string) || undefined,
    hubSlug: (doc.hubSlug as string) || undefined,
    content: doc.content,
  }))
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
  .requiredOption('-a, --airport <code>', 'Airport code (e.g., JFK)')
  .option('--dry-run', 'Preview what would be updated without saving')
  .option('--hub-only', 'Only update hub articles (skip sub-pillars)')
  .action(async (options) => {
    try {
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

        // Use Claude to inject links
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

        // Convert back to Lexical and save
        const lexicalContent = htmlToLexical(updatedHtml)
        await updatePost(parent.id, { content: lexicalContent })

        console.log(`     ✓ Saved — ${verification.found.length} link(s) added\n`)
        updated++
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
