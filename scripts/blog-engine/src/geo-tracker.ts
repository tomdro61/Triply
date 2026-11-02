/**
 * geo-tracker.ts — GEO / AI-visibility measurement
 *
 * In the zero-click era, GSC clicks undercount value: what matters is whether AI
 * answer surfaces cite us. This measures, per target query, whether triplypro.com
 * is (a) cited in Google's AI Overview and (b) present in organic results — using
 * the SerpAPI key we already have (SerpAPI returns the AI Overview + its sources).
 *
 * Each query costs ~1 SerpAPI credit, so it runs a bounded set (default sample,
 * or pass --queries-file with one query per line). Read-only: writes a snapshot to
 * reports/geo-tracking-<date>.json and prints a summary. Run periodically to track
 * citation/mention rate over time (the GEO KPIs that GSC can't show).
 *
 * Usage:
 *   npm run geo-tracker                         # default ~12 commercial-intent queries
 *   npm run geo-tracker -- --limit 6
 *   npm run geo-tracker -- --queries-file ./my-queries.txt
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { serpApiSearch, hasSerpApiKey } from './serpapi.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPORTS_DIR = path.resolve(__dirname, '..', 'reports')
const DOMAIN = 'triplypro.com'

const args = process.argv.slice(2)
const flag = (n: string, d?: string) => { const i = args.indexOf(n); return i >= 0 ? (args[i + 1] ?? '') : d }
const LIMIT = parseInt(flag('--limit', '12') || '12', 10)
const QUERIES_FILE = flag('--queries-file')

// Commercial + informational mix across major clusters. Commercial-intent queries
// are where clicks still happen; "rates" queries test AI-Overview citation.
const DEFAULT_QUERIES = [
  'best jfk airport parking',
  'cheap lga airport parking',
  'msp airport parking rates',
  'ord airport parking deals',
  'boston logan airport parking',
  'lax long term parking',
  'cheap ewr airport parking',
  'sfo airport parking rates',
  'best fort lauderdale airport parking',
  'dca airport parking',
  'orlando airport parking deals',
  'seattle airport parking rates',
]

interface QueryResult {
  query: string
  aioPresent: boolean
  aioCitesTriply: boolean
  aioSourceCount: number
  organicPosition: number | null // 1-based, null if not in returned organic results
  topOrganicDomain: string | null
}

async function serpSearch(q: string): Promise<any | null> {
  // Auto-rotates to the backup key when the primary is out of searches.
  return serpApiSearch({ q, num: '10', engine: 'google' })
}

function domainOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return '' }
}

function analyze(q: string, data: any): QueryResult {
  const aio = data.ai_overview || null
  // SerpAPI exposes AI Overview sources under references / text_blocks[].reference_indexes
  const refs: any[] = (aio?.references || []) as any[]
  const aioPresent = !!aio && (refs.length > 0 || !!aio.text_blocks || !!aio.page_token)
  const aioCitesTriply = refs.some(r => (r.link || '').includes(DOMAIN))
  const organic: any[] = data.organic_results || []
  const idx = organic.findIndex(r => (r.link || '').includes(DOMAIN))
  return {
    query: q,
    aioPresent,
    aioCitesTriply,
    aioSourceCount: refs.length,
    organicPosition: idx >= 0 ? idx + 1 : null,
    topOrganicDomain: organic[0] ? domainOf(organic[0].link || '') : null,
  }
}

async function main() {
  if (!hasSerpApiKey()) { console.log('No SERPAPI_API_KEY in .env — cannot run.'); return }
  let queries = DEFAULT_QUERIES
  if (QUERIES_FILE && fs.existsSync(QUERIES_FILE)) {
    queries = fs.readFileSync(QUERIES_FILE, 'utf8').split('\n').map(l => l.trim()).filter(Boolean)
  }
  queries = queries.slice(0, LIMIT)
  console.log(`\n🤖 GEO tracker — ${queries.length} queries (each ~1 SerpAPI credit)\n`)

  const results: QueryResult[] = []
  for (const q of queries) {
    const data = await serpSearch(q)
    if (!data) continue
    const r = analyze(q, data)
    results.push(r)
    const aioFlag = !r.aioPresent ? 'no-AIO' : r.aioCitesTriply ? 'CITED ✓' : `not-cited (${r.aioSourceCount} srcs)`
    const org = r.organicPosition ? `organic #${r.organicPosition}` : 'not in top-10'
    console.log(`  ${aioFlag.padEnd(22)} ${org.padEnd(16)} ${q}`)
  }

  const n = results.length || 1
  const aioQueries = results.filter(r => r.aioPresent).length
  const citedQueries = results.filter(r => r.aioCitesTriply).length
  const organicTop10 = results.filter(r => r.organicPosition && r.organicPosition <= 10).length
  console.log('\n── GEO KPIs ──')
  console.log(`  AI Overview present:     ${aioQueries}/${results.length} queries`)
  console.log(`  Cited in AI Overview:    ${citedQueries}/${results.length} (${Math.round(citedQueries / n * 100)}% citation rate)`)
  console.log(`  In organic top-10:       ${organicTop10}/${results.length}`)
  console.log(`  AIO citation among AIO-present: ${aioQueries ? Math.round(citedQueries / aioQueries * 100) : 0}%`)

  const today = new Date().toISOString().slice(0, 10)
  const out = { generatedAt: new Date().toISOString(), queryCount: results.length, citationRate: round(citedQueries / n, 3), aioPresentRate: round(aioQueries / n, 3), organicTop10Rate: round(organicTop10 / n, 3), results }
  const outPath = path.join(REPORTS_DIR, `geo-tracking-${today}.json`)
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2))
  console.log(`\n📄 Saved: ${outPath}`)
  console.log('Run periodically to track citation/mention rate over time (the GEO KPI GSC cannot show).')
}

function round(x: number, d = 3): number { return Math.round(x * 10 ** d) / 10 ** d }

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
