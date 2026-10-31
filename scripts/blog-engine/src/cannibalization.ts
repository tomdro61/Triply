/**
 * cannibalization.ts — find keyword cannibalization from Google Search Console.
 *
 * Cannibalization = one search query that MULTIPLE of our blog pages rank for, so
 * Google splits authority/clicks between them instead of ranking one page strongly.
 * With ~2,000 spokes in tight per-airport clusters (e.g. "jfk long-term parking
 * cost" vs "…rates"), this is a structurally high risk — and nothing checked it
 * before. The classic fix: pick one primary page, then merge + 301 the weaker one,
 * or re-point each at a genuinely distinct intent.
 *
 * Pulls every (query, page) pair from GSC (via gsc.ts fetchQueryPagePairs), groups
 * by query, and flags queries where 2+ of our pages get meaningful impressions.
 * Ranks by "stolen impressions" (demand going to non-primary pages) = the traffic
 * actually at stake. Read-only: prints a table + saves reports/cannibalization-<date>.json.
 *
 * CLI:
 *   tsx src/cannibalization.ts                 # last 90 days, all clusters (every GSC row, paged)
 *   tsx src/cannibalization.ts -a JFK          # one airport cluster
 *   tsx src/cannibalization.ts -d 90 --min-impr 10 --top 30
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { fetchQueryPagePairs, type QueryPageRow } from './gsc.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPORTS_DIR = path.resolve(__dirname, '..', 'reports')

interface CompetingPage { slug: string; impressions: number; clicks: number; position: number }
interface Cannibalized {
  query: string
  totalImpressions: number
  totalClicks: number
  competitors: number
  primary: string            // page with the most impressions (keep this one)
  stolenImpressions: number  // impressions going to non-primary pages
  bestPosition: number       // best (lowest) position any of our pages holds
  pages: CompetingPage[]     // sorted by impressions desc
}

/**
 * @param maxCompetitors queries where MORE than this many of our pages rank are
 *   treated as broad head terms (e.g. "airport parking"), NOT cannibalization —
 *   consolidation isn't the fix there. Returned separately as `broad`.
 */
export function findCannibalization(
  rows: QueryPageRow[],
  minImpressions: number,
  maxCompetitors = 5,
): { hits: Cannibalized[]; broad: number } {
  const byQuery = new Map<string, QueryPageRow[]>()
  for (const r of rows) {
    if (!byQuery.has(r.query)) byQuery.set(r.query, [])
    byQuery.get(r.query)!.push(r)
  }

  const out: Cannibalized[] = []
  let broad = 0
  for (const [query, group] of byQuery) {
    // Collapse to one entry per page (GSC shouldn't dup, but be safe), keep those with real demand.
    const byPage = new Map<string, CompetingPage>()
    for (const r of group) {
      const cur = byPage.get(r.slug) || { slug: r.slug, impressions: 0, clicks: 0, position: r.position }
      cur.impressions += r.impressions
      cur.clicks += r.clicks
      cur.position = Math.min(cur.position, r.position) // best position across dup rows
      byPage.set(r.slug, cur)
    }
    const pages = [...byPage.values()].filter(p => p.impressions >= minImpressions).sort((a, b) => b.impressions - a.impressions)
    if (pages.length < 2) continue                       // not cannibalized
    if (pages.length > maxCompetitors) { broad++; continue } // broad head term, not actionable

    const totalImpressions = pages.reduce((s, p) => s + p.impressions, 0)
    out.push({
      query,
      totalImpressions,
      totalClicks: pages.reduce((s, p) => s + p.clicks, 0),
      competitors: pages.length,
      primary: pages[0].slug,
      stolenImpressions: totalImpressions - pages[0].impressions,
      bestPosition: Math.min(...pages.map(p => p.position)),
      pages,
    })
  }
  // Most traffic at stake first.
  return { hits: out.sort((a, b) => b.stolenImpressions - a.stolenImpressions), broad }
}

// ── CLI ─────────────────────────────────────────────────────────────────────
import { pathToFileURL } from 'url'
const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (isDirectRun) {
  const args = process.argv.slice(2)
  const val = (flag: string, def: string) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : def }
  const days = parseInt(val('-d', val('--days', '90')), 10) || 90
  const minImpr = parseInt(val('--min-impr', '5'), 10) || 5
  const top = parseInt(val('--top', '40'), 10) || 40
  const maxComp = parseInt(val('--max-competitors', '5'), 10) || 5
  const aIdx = args.findIndex(a => a === '-a' || a === '--airport')
  const airport = aIdx >= 0 ? (args[aIdx + 1] || '').toLowerCase() : ''

  console.log(`\n🔎 Cannibalization audit — last ${days} days${airport ? `, cluster ${airport.toUpperCase()}` : ''} (min ${minImpr} impr/page, ≤${maxComp} competing pages)\n`)

  let rows = await fetchQueryPagePairs(days, minImpr)
  if (airport) rows = rows.filter(r => r.slug.includes(airport))
  console.log(`   ${rows.length} query↔page pairs pulled from GSC`)

  const { hits, broad } = findCannibalization(rows, minImpr, maxComp)
  if (hits.length === 0) {
    console.log(`\n✅ No actionable cannibalization at this threshold.${broad ? ` (${broad} broad head terms with >${maxComp} pages skipped — those aren't cannibalization.)` : ''}\n`)
  } else {
    const stolen = hits.reduce((s, h) => s + h.stolenImpressions, 0)
    console.log(`\n⚠ ${hits.length} cannibalized quer${hits.length === 1 ? 'y' : 'ies'} (2–${maxComp} competing pages) — ${stolen.toLocaleString()} impressions/mo going to non-primary pages.`)
    console.log(`   ${broad} broad head terms (>${maxComp} pages) skipped — those are normal, not cannibalization.`)
    console.log(`   ▶ = strongest page (make this the primary); others → review for overlapping intent, then consolidate + 301 or differentiate.\n`)
    for (const h of hits.slice(0, top)) {
      console.log(`  "${h.query}"  (${h.totalImpressions.toLocaleString()} impr, ${h.competitors} pages, best pos ${h.bestPosition.toFixed(1)})`)
      h.pages.forEach((p, i) =>
        console.log(`      ${i === 0 ? '▶ primary' : '  also  '} ${p.slug.slice(0, 58).padEnd(60)} ${String(p.impressions).padStart(6)} impr  pos ${p.position.toFixed(1)}`))
    }
    if (hits.length > top) console.log(`\n   … and ${hits.length - top} more (raise --top to see all)`)
  }

  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true })
  const stamp = new Date().toISOString().slice(0, 10)
  const out = path.join(REPORTS_DIR, `cannibalization-${stamp}${airport ? `-${airport}` : ''}.json`)
  fs.writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), days, minImpr, maxCompetitors: maxComp, airport: airport || null, count: hits.length, broadHeadTerms: broad, items: hits }, null, 2))
  console.log(`\n📄 Saved: ${path.relative(process.cwd(), out)}\n`)
}
