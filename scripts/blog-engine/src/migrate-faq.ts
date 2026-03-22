/**
 * One-time migration: strip inline FAQ sections from Lexical content.
 *
 * FAQs are stored as structured faqItems and rendered by FaqAccordion.
 * Some posts also have an FAQ section in the article body, causing
 * duplicate rendering. This script removes the inline FAQ section.
 *
 * Usage:
 *   npx tsx src/migrate-faq.ts              # dry-run scan all posts
 *   npx tsx src/migrate-faq.ts --apply      # apply to all posts with inline FAQs
 *   npx tsx src/migrate-faq.ts --id 20      # dry-run post #20 only
 *   npx tsx src/migrate-faq.ts --id 20 --apply  # fix post #20
 */

import { config } from 'dotenv'
import { z } from 'zod'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
config({ path: path.resolve(__dirname, '..', '.env') })

const envSchema = z.object({
  PAYLOAD_CMS_URL: z.string().url().default('http://localhost:3001'),
  PAYLOAD_API_KEY: z.string().min(1, 'PAYLOAD_API_KEY is required'),
})

const parsed = envSchema.safeParse(process.env)
if (!parsed.success) {
  console.error('Missing environment variables:')
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join('.')}: ${issue.message}`)
  }
  process.exit(1)
}
const env = parsed.data

// ---------------------------------------------------------------------------
// Payload API helpers
// ---------------------------------------------------------------------------

const headers = {
  'Content-Type': 'application/json',
  Authorization: `users API-Key ${env.PAYLOAD_API_KEY}`,
}

async function payloadFetch(path: string, options: RequestInit = {}) {
  const url = `${env.PAYLOAD_CMS_URL}/api${path}`
  const res = await fetch(url, { ...options, headers: { ...headers, ...options.headers } })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Payload API error ${res.status} on ${path}: ${body}`)
  }
  return res.json()
}

// ---------------------------------------------------------------------------
// Lexical tree walker: find & remove FAQ heading sections
// ---------------------------------------------------------------------------

interface LexNode {
  type: string
  tag?: string
  text?: string
  children?: LexNode[]
  [key: string]: unknown
}

function extractText(node: LexNode): string {
  if (node.type === 'text') return node.text || ''
  if (Array.isArray(node.children)) {
    return node.children.map(extractText).join('')
  }
  return ''
}

const FAQ_PATTERN = /^(?:frequently\s+asked\s+questions|faqs?)\b/i

/**
 * Walk the root's children array. If an H2 heading matches the FAQ pattern,
 * remove it and all subsequent siblings until the next H2 (or end).
 * Returns true if any nodes were removed.
 */
function stripFaqFromLexical(root: LexNode): boolean {
  const children = root.children
  if (!Array.isArray(children)) return false

  let faqIndex = -1

  // Find the FAQ heading
  for (let i = 0; i < children.length; i++) {
    const node = children[i]
    if (node.type === 'heading' && node.tag === 'h2') {
      const text = extractText(node).trim()
      if (FAQ_PATTERN.test(text)) {
        faqIndex = i
        break
      }
    }
  }

  if (faqIndex === -1) return false

  // Find end: next H2 or end of array
  let endIndex = children.length
  for (let i = faqIndex + 1; i < children.length; i++) {
    if (children[i].type === 'heading' && children[i].tag === 'h2') {
      endIndex = i
      break
    }
  }

  const removedCount = endIndex - faqIndex
  children.splice(faqIndex, removedCount)
  return true
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2)
  const apply = args.includes('--apply')
  const idFlag = args.indexOf('--id')
  const targetId = idFlag !== -1 ? args[idFlag + 1] : null

  console.log(`Mode: ${apply ? 'APPLY (will patch posts)' : 'DRY RUN (read-only)'}`)
  if (targetId) console.log(`Target: post #${targetId}`)

  // Fetch posts
  let posts: { id: string; title?: string; slug?: string; content?: unknown; faqItems?: unknown[] }[]

  if (targetId) {
    const post = await payloadFetch(`/posts/${targetId}?depth=0`)
    posts = [post]
  } else {
    posts = []
    let page = 1
    let hasMore = true
    while (hasMore) {
      const result = await payloadFetch(`/posts?limit=100&page=${page}&depth=0`)
      posts.push(...(result.docs || []))
      hasMore = result.hasNextPage === true
      page++
    }
  }

  console.log(`Fetched ${posts.length} post(s)\n`)

  let patchedCount = 0

  for (const post of posts) {
    const contentWrapper = post.content as { root?: LexNode } | LexNode | undefined
    if (!contentWrapper) continue
    // Payload Lexical stores content as { root: { type: 'root', children: [...] } }
    const content = ('root' in contentWrapper && contentWrapper.root) ? contentWrapper.root as LexNode : contentWrapper as LexNode
    if (!content || content.type !== 'root') continue

    const changed = stripFaqFromLexical(content)
    if (!changed) continue

    const title = post.title || `ID ${post.id}`
    const hasFaqItems = Array.isArray(post.faqItems) && post.faqItems.length > 0
    console.log(`  [FAQ IN BODY] Post #${post.id}: ${title}`)
    console.log(`    faqItems field: ${hasFaqItems ? `${post.faqItems!.length} items (will render via accordion)` : 'EMPTY — FAQ content will be lost!'}`)

    if (!hasFaqItems) {
      console.log(`    ⚠ WARNING: This post has no faqItems — removing inline FAQ will lose the content entirely.`)
      console.log(`    Skipping this post. Manually add faqItems before running with --apply.`)
      continue
    }

    if (apply) {
      // Payload expects content as { root: { type: 'root', children: [...] } }
      const patchContent = ('root' in contentWrapper! && contentWrapper!.root) ? { root: content } : content
      await payloadFetch(`/posts/${post.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ content: patchContent }),
      })
      console.log(`    -> PATCHED (inline FAQ removed, ${post.faqItems!.length} faqItems remain)`)
      patchedCount++
    } else {
      console.log(`    -> Would patch (use --apply to write)`)
    }
  }

  console.log(`\nDone. ${apply ? `Patched ${patchedCount} post(s).` : 'Dry run complete — no changes made.'}`)
}

main().catch((err) => {
  console.error('Migration failed:', err)
  process.exit(1)
})
