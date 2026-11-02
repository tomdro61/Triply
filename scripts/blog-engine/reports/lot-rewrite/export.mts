// Pick the top-N ATL posts (by GSC impressions) that name an unsellable ATL lot; export block-level HTML.
import fs from 'fs'
import { findPublishedPostBySlug, getAllPublishedPosts } from '../../src/payload.js'
import { fetchAllBlogPagePerf } from '../../src/gsc.js'
import { lexicalToHtml } from '../../src/lexical-to-html.js'
const A = process.argv[2] || 'ATL', N = Number(process.argv[3] || 10), BATCH = process.argv[4] || 'batch1', FULL = process.argv[5] === 'full', DIR = `reports/lot-rewrite/${A.toLowerCase()}`
fs.mkdirSync(DIR, { recursive: true })
const air = JSON.parse(fs.readFileSync(`data/airports/${A}.json`, 'utf8'))
const fact = JSON.parse(fs.readFileSync(`${DIR}/factsheet.json`, 'utf8'))
const bad: string[] = fact.notSellableOnTriply.map((n: string) => n.replace(/\s*\(.*?\)\s*/g, ' ').trim())

const brand = (n: string) => n.replace(/^the\s+/i, '').split(/\s+/).slice(0, 2).join(' ')
const pats = [...new Set(bad.flatMap((n: string) => [n, brand(n)]))].map(s => new RegExp(s.replace(/[.*+?^${}()|[\]\&]/g, '.?'), 'i'))
// full: every published post of the airport (CMS airportCode), ranked by 28-day GSC impressions (all pages, paged).
// default: the old GSC report's top-10 pages per airport.
let pages: any[]
if (FULL) {
  const perf = (await fetchAllBlogPagePerf(28)).pages, posts = await getAllPublishedPosts(A)
  pages = posts.map(p => ({ slug: p.slug, impressions: perf.get(p.slug)?.impressions || 0 })).sort((a, b) => b.impressions - a.impressions)
  console.log(`${posts.length} published ${A} posts, ${pages.filter(p => p.impressions).length} with impressions`)
} else {
  const gsc = JSON.parse(fs.readFileSync('reports/gsc-report-2026-09-05-to-2026-10-03.json', 'utf8'))
  pages = (gsc.airportClusters.find((c: any) => c.airportCode === A)?.topPages || []).sort((a: any, b: any) => b.impressions - a.impressions)
}
// Old prices of not-sellable lots (factsheet stalePrices) count as a hit even without the lot name.
const staleRe = fact.stalePrices?.length ? new RegExp('\\$(' + fact.stalePrices.map((p: string) => p.replace('.', '\\.')).join('|') + ')\\b') : null
const RIVAL = new RegExp(bad.map((b: string) => brand(b).toLowerCase().replace(/[^a-z0-9]+/g, '-')).join('|'))
const picked: any[] = []
for (const p of pages) {
  if (picked.length >= N) break
  if (RIVAL.test(p.slug)) continue
  if (fs.existsSync(`${DIR}/${p.slug}.edits.json`)) continue
  const post = await findPublishedPostBySlug(p.slug); if (!post?.content) continue
  const blocks = post.content.root.children.map((b: any, i: number) => ({ i, type: b.type, html: b.type === 'upload' ? '[IMAGE — do not edit]' : lexicalToHtml({ root: { children: [b] } } as any) }))
  const hits = blocks.filter((b: any) => pats.some(r => r.test(b.html)) || (staleRe && staleRe.test(b.html))).length
  if (!hits) continue
  fs.writeFileSync(`${DIR}/${p.slug}.preedit.json`, JSON.stringify(post))
  fs.writeFileSync(`${DIR}/${p.slug}.blocks.json`, JSON.stringify({ id: post.id, slug: p.slug, title: post.title, seo: post.seo, excerpt: post.excerpt, faqItems: post.faqItems, impressions: p.impressions, blocks }, null, 1))
  picked.push({ slug: p.slug, id: post.id, impressions: p.impressions, blocks: blocks.length, blocksNamingBadLots: hits })
}
console.table(picked); fs.writeFileSync(`${DIR}/${BATCH}.json`, JSON.stringify(picked, null, 1))
