/**
 * One-time migration: convert native Lexical table nodes to bullet lists.
 *
 * Fixes CMS "Minified Lexical error #17" caused by table/tablerow/tablecell
 * nodes that the Payload CMS editor doesn't have registered.
 *
 * Usage:
 *   npx tsx src/migrate-tables.ts              # dry-run scan all posts
 *   npx tsx src/migrate-tables.ts --apply      # apply to all posts with tables
 *   npx tsx src/migrate-tables.ts --id 20      # dry-run post #20 only
 *   npx tsx src/migrate-tables.ts --id 20 --apply  # fix post #20
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
// Lexical node factories (mirrors html-to-lexical.ts)
// ---------------------------------------------------------------------------

interface LexNode {
  type: string
  [key: string]: unknown
}

const FORMAT_BOLD = 1

function makeTextNode(text: string, format = 0): LexNode {
  return { type: 'text', text, format, detail: 0, mode: 'normal', style: '', version: 1 }
}

function makeListItemNode(children: LexNode[], value: number): LexNode {
  return {
    type: 'listitem',
    checked: false,
    value,
    children,
    direction: 'ltr',
    format: '',
    indent: 0,
    version: 1,
  }
}

function makeListNode(children: LexNode[]): LexNode {
  return {
    type: 'list',
    listType: 'bullet',
    tag: 'ul',
    start: 1,
    children,
    direction: 'ltr',
    format: '',
    indent: 0,
    version: 1,
  }
}

// ---------------------------------------------------------------------------
// Tree walker: find & convert table nodes
// ---------------------------------------------------------------------------

function extractText(node: LexNode): string {
  if (node.type === 'text') return (node.text as string) || ''
  const children = node.children as LexNode[] | undefined
  if (Array.isArray(children)) {
    return children.map(extractText).join('')
  }
  return ''
}

function convertTableNode(table: LexNode): LexNode {
  const rows = ((table as { children?: LexNode[] }).children || []).filter(
    (n) => n.type === 'tablerow'
  )
  if (rows.length === 0) return makeListNode([makeListItemNode([makeTextNode('')], 1)])

  // Detect header row: first row whose cells all have headerState === 1
  const firstRowCells = ((rows[0] as { children?: LexNode[] }).children || []).filter(
    (n) => n.type === 'tablecell'
  )
  const headers: string[] = []
  let dataStartIndex = 0

  const allHeaders = firstRowCells.length > 0 && firstRowCells.every(
    (c) => (c as { headerState?: number }).headerState === 1
  )
  if (allHeaders) {
    for (const cell of firstRowCells) {
      headers.push(extractText(cell).trim())
    }
    dataStartIndex = 1
  }

  const items: LexNode[] = []
  let itemIndex = 1

  for (let i = dataStartIndex; i < rows.length; i++) {
    const cells = ((rows[i] as { children?: LexNode[] }).children || []).filter(
      (n) => n.type === 'tablecell'
    )
    const cellTexts = cells.map((c) => extractText(c).trim())
    if (cellTexts.length === 0) continue

    const inlineNodes: LexNode[] = []
    for (let c = 0; c < cellTexts.length; c++) {
      if (c > 0) inlineNodes.push(makeTextNode(' | '))
      if (headers.length > 0 && c < headers.length) {
        inlineNodes.push(makeTextNode(`${headers[c]}: `, FORMAT_BOLD))
        inlineNodes.push(makeTextNode(cellTexts[c]))
      } else {
        inlineNodes.push(makeTextNode(cellTexts[c]))
      }
    }

    items.push(makeListItemNode(inlineNodes, itemIndex))
    itemIndex++
  }

  if (items.length === 0) return makeListNode([makeListItemNode([makeTextNode('')], 1)])
  return makeListNode(items)
}

/**
 * Recursively walk a Lexical tree. Replace any `table` node with a bullet list.
 * Returns true if any replacement was made.
 */
function walkAndReplace(node: LexNode): boolean {
  const children = (node as { children?: LexNode[] }).children
  if (!Array.isArray(children)) return false

  let changed = false
  for (let i = 0; i < children.length; i++) {
    if (children[i].type === 'table') {
      children[i] = convertTableNode(children[i])
      changed = true
    } else {
      if (walkAndReplace(children[i])) changed = true
    }
  }
  return changed
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
  let posts: { id: string; title?: string; content?: unknown }[]

  if (targetId) {
    const post = await payloadFetch(`/posts/${targetId}`)
    posts = [post]
  } else {
    // Paginate through all posts
    posts = []
    let page = 1
    let hasMore = true
    while (hasMore) {
      const result = await payloadFetch(`/posts?limit=100&page=${page}`)
      posts.push(...(result.docs || []))
      hasMore = result.hasNextPage === true
      page++
    }
  }

  console.log(`Fetched ${posts.length} post(s)\n`)

  let patchedCount = 0

  for (const post of posts) {
    const content = post.content as LexNode | undefined
    if (!content || content.type !== 'root') continue

    const changed = walkAndReplace(content)
    if (!changed) continue

    const title = (post as { title?: string }).title || `ID ${post.id}`
    console.log(`  [TABLE FOUND] Post #${post.id}: ${title}`)

    if (apply) {
      await payloadFetch(`/posts/${post.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ content }),
      })
      console.log(`    -> PATCHED`)
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
