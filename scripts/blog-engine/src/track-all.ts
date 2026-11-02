/**
 * track-all.ts — snapshot EVERY published article into the improvement engine.
 *
 * The perf/maintain loop only creates a record (reports/articles/<slug>.json) for
 * articles it has processed — so the dashboard/loop can miss most of the corpus.
 * This backfills a snapshot for every published post CHEAPLY: one bulk GSC query
 * for all blog pages + the paginated post list (which already carries the content
 * and SEO), scored locally. ~40 network calls for the whole corpus, vs ~3 per
 * article if snapshotting one at a time.
 *
 * Safe + idempotent: appends one snapshot per run (so re-running daily builds a
 * position trend for ALL articles). Articles with no GSC data get a found:false
 * snapshot (tracked, tier 0 "watch" — nothing to optimize until they get demand).
 *
 * CLI:  tsx src/track-all.ts [-d 28]     (or: npm run track-all)
 */

import { env, BLOG_BASE_URL } from './config.js'
import { fetchAllBlogPagePerf } from './gsc.js'
import { upsertBulkSnapshot } from './perf-snapshot.js'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ARTICLES_DIR = path.resolve(__dirname, '..', 'reports', 'articles')

async function paginate(endpoint: string): Promise<any[]> {
  const all: any[] = []
  let page = 1
  while (true) {
    const params = new URLSearchParams({ limit: '200', page: String(page), depth: '0' })
    if (endpoint === 'posts') params.set('where[status][equals]', 'published')
    const res = await fetch(`${env.PAYLOAD_CMS_URL}/api/${endpoint}?${params.toString()}`, {
      headers: { Authorization: `users API-Key ${env.PAYLOAD_API_KEY}` },
    })
    if (!res.ok) { if (page === 1) throw new Error(`${endpoint} fetch ${res.status}: ${await res.text()}`); break }
    const data = await res.json()
    all.push(...(data.docs || []))
    if (!data.hasNextPage) break
    page++
  }
  return all
}

async function main() {
  const args = process.argv.slice(2)
  const dIdx = args.findIndex((a) => a === '-d' || a === '--days')
  const days = dIdx >= 0 ? parseInt(args[dIdx + 1], 10) || 28 : 28

  console.log('\n📚 Track-all — snapshotting every published article\n')
  console.log('  Fetching published posts + content-queue keywords...')
  const [posts, queue] = await Promise.all([paginate('posts'), paginate('content-queue')])
  const kw = new Map<string, string>()
  for (const q of queue) if (q.slug && q.keyword) kw.set(q.slug, q.keyword)
  console.log(`  ${posts.length} published posts · ${kw.size} queue keywords`)

  console.log('  Pulling bulk GSC page performance (1 query)...')
  const { dateRange, pages } = await fetchAllBlogPagePerf(days)
  console.log(`  GSC: ${pages.size} pages with data (${dateRange.start} → ${dateRange.end})\n`)

  const existing = new Set<string>()
  try { for (const f of fs.readdirSync(ARTICLES_DIR)) if (f.endsWith('.json')) existing.add(f.slice(0, -5)) } catch { /* none yet */ }

  let created = 0, updated = 0, withGsc = 0, failed = 0
  for (const post of posts) {
    if (!post.slug) continue
    try {
      const keyword = kw.get(post.slug) || post.slug.replace(/-/g, ' ')
      const p = pages.get(post.slug)
      if (p) withGsc++
      const perf = p
        ? { found: true, clicks: p.clicks, impressions: p.impressions, ctr: p.ctr, position: p.position }
        : { found: false, clicks: 0, impressions: 0, ctr: 0, position: 0 }
      const url = p?.url || `${BLOG_BASE_URL}/${post.slug}`
      upsertBulkSnapshot(post, keyword, url, perf, dateRange)
      if (existing.has(post.slug)) updated++; else created++
    } catch (e) {
      failed++
      console.warn(`  ⚠ ${post.slug}: ${(e as Error).message}`)
    }
  }

  console.log(`\n✅ Tracked ${created + updated} articles (${created} new records, ${updated} updated).`)
  console.log(`   ${withGsc} have GSC data; ${created + updated - withGsc} tracked with no impressions yet (tier 0 watch).`)
  if (failed) console.log(`   ${failed} failed (see warnings).`)
  console.log(`\n   View: npm run dashboard\n`)
}

main().catch((e) => { console.error('Error:', e instanceof Error ? e.message : String(e)); process.exit(1) })
