// One-off (29 Oct 2026): publish the Thanksgiving price index (notes/price-index-2026-11) to the CMS.
// No LLM, no SerpAPI. Default = dry run (writes HTML previews); --apply creates the post.
import fs from 'fs'
import path from 'path'
import { marked } from 'marked'
import { htmlToLexical } from '../src/html-to-lexical.js'
import { lexicalToHtml } from '../src/lexical-to-html.js'
import { createPost, findPostBySlug, getApiUser } from '../src/payload.js'
import { pingIndexNow, postUrlFor } from '../src/indexnow.js'

const APPLY = process.argv.includes('--apply')
// Source markdown lives outside the repo; pass it with PRICE_INDEX_MD=<path>.
const SRC = process.env.PRICE_INDEX_MD || ''
if (!SRC) throw new Error('set PRICE_INDEX_MD=<path to PRICE-INDEX-THANKSGIVING-2026.md>')
const OUT = path.resolve('reports/price-index-preview')
fs.mkdirSync(OUT, { recursive: true })
const CATEGORY_ID = 1 // "Airport Parking"

const slug = 'thanksgiving-airport-parking-price-index-2026'
const title = 'Thanksgiving Airport Parking Price Index 2026'
const metaTitle = 'Thanksgiving Airport Parking Price Index 2026: 25 Airports'
const metaDescription =
  'Terminal garages cost a median $111 more than off-airport lots over Thanksgiving 2026. Prices at 25 U.S. airports, checked 28 October.'
if (metaTitle.length > 60 || metaDescription.length > 160) throw new Error(`seo field too long ${metaTitle.length}/${metaDescription.length}`)

let md = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n')
md = md.replace(/^# [^\n]*\n/m, '') // H1 = post title, rendered by the page
md = md.replace(/ Full links are in garage-verify-2026-10-28\.md\./, '') // internal file, not for readers
md = md.replace(
  /\n## Tips for Thanksgiving travelers\n/,
  '\nCompare every lot at your airport, with the full price up front, at [triplypro.com](/).\n\n## Tips for Thanksgiving travelers\n',
)
if (/\.md\b/.test(md)) throw new Error('leftover .md reference')

const html = (marked.parse(md, { async: false }) as string).trim().replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&')
const lexical = htmlToLexical(html)
const round = lexicalToHtml(lexical)
const hrefsIn = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1])
const lost = hrefsIn.filter((h) => !round.includes(`href="${h}"`))
const tableRows = (round.match(/<tr/g) || []).length

fs.writeFileSync(path.join(OUT, `${slug}.html`), html)
fs.writeFileSync(path.join(OUT, `${slug}.roundtrip.html`), round)

const row: Record<string, unknown> = { slug, blocks: lexical.root.children.length, hrefs: hrefsIn, lost, tableRows }
if (APPLY) {
  if (lost.length) throw new Error(`links lost in conversion: ${lost.join(', ')}`)
  if (tableRows < 26) throw new Error(`table lost rows in conversion: ${tableRows}`)
  const existing = await findPostBySlug(slug)
  if (existing) throw new Error(`slug already exists (ID ${existing.id}) — refusing to touch it`)
  const apiUser = await getApiUser()
  const now = new Date().toISOString()
  const res = await createPost({
    title,
    slug,
    excerpt: metaDescription,
    content: lexical,
    category: CATEGORY_ID,
    author: apiUser.id,
    status: 'published',
    publishedAt: now, // new post: contentUpdatedAt stays unset until a real fact update (W1.7)
    seo: { metaTitle, metaDescription },
  })
  row.id = res.doc?.id || res.id
  await pingIndexNow([postUrlFor(slug)])
}
console.log(JSON.stringify(row, null, 1))
