/**
 * refresh-candidates.ts — Workstream B3: GSC-driven rolling refresh loop
 *
 * Reads the latest GSC report(s) and surfaces the highest-opportunity pages to
 * refresh, then (with --apply) re-queues them so the normal `generate` path
 * updates them in place — refreshing prices/FAQ and bumping updatedAt (→ a real
 * dateModified, given the index.ts publishedAt-preserve fix).
 *
 * Two candidate types:
 *   • quick-win  — position 5-20 with real impressions ("one push from page 1")
 *   • decaying   — impressions dropped meaningfully vs the previous GSC report
 *
 * SAFE BY DEFAULT: dry-run lists candidates and changes nothing. --apply only
 * sets content-queue status→'queued' (it does NOT generate or publish — that is a
 * separate, explicit `npm run generate` step). Nothing here calls the Claude API.
 *
 * Usage:
 *   npm run refresh-candidates                          # dry-run, ranked list
 *   npm run refresh-candidates -- --apply --limit 15    # re-queue top 15
 *   npm run refresh-candidates -- --min-impressions 20 --max-position 18
 *   npm run refresh-candidates -- --apply --changelog   # also log a changelog entry
 *
 * Then:  npm run generate -- --airport <X>   (picks up the re-queued items)
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { config } from 'dotenv'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
config({ path: path.resolve(__dirname, '..', '.env') })
const ROOT = path.resolve(__dirname, '..')
const REPORTS_DIR = path.join(ROOT, 'reports')

const CMS_URL = process.env.PAYLOAD_CMS_URL!
const API_KEY = process.env.PAYLOAD_API_KEY!
const headers = { 'Content-Type': 'application/json', Authorization: `users API-Key ${API_KEY}` }

interface GscPage { slug?: string; page?: string; position?: number; impressions?: number; clicks?: number; ctr?: number }
interface Candidate {
  slug: string
  position: number
  impressions: number
  clicks: number
  type: 'quick-win' | 'decaying'
  opportunity: number
  detail: string
}

// CLI flags
const args = process.argv.slice(2)
const flag = (name: string, def?: string) => { const i = args.indexOf(name); return i >= 0 ? (args[i + 1] ?? '') : def }
const has = (name: string) => args.includes(name)
const APPLY = has('--apply')
const LIMIT = parseInt(flag('--limit', '15') || '15', 10)
const MIN_IMPR = parseInt(flag('--min-impressions', '10') || '10', 10)
const MAX_POS = parseFloat(flag('--max-position', '20') || '20')
const MIN_POS = parseFloat(flag('--min-position', '4') || '4')
const DO_CHANGELOG = has('--changelog')

function gscReportFiles(): string[] {
  if (!fs.existsSync(REPORTS_DIR)) return []
  return fs.readdirSync(REPORTS_DIR)
    .filter(f => f.startsWith('gsc-report-') && f.endsWith('.json'))
    .sort() // chronological by date in filename
}

// Collect every page-level entry (with slug + position) from a report
function pagesFromReport(r: any): Map<string, GscPage> {
  const out = new Map<string, GscPage>()
  const buckets: GscPage[][] = []
  if (Array.isArray(r.topPages)) buckets.push(r.topPages)
  if (Array.isArray(r.lowCtrHighImpressions)) buckets.push(r.lowCtrHighImpressions)
  const clusters = Array.isArray(r.airportClusters) ? r.airportClusters : Object.values(r.airportClusters || {})
  for (const c of clusters as any[]) {
    if (Array.isArray(c.topPages)) buckets.push(c.topPages)
    if (Array.isArray(c.underperformingPages)) buckets.push(c.underperformingPages)
  }
  for (const b of buckets) for (const p of b) {
    if (p && p.slug && typeof p.position === 'number') {
      // keep the entry with the most impressions if a slug appears in multiple buckets
      const prev = out.get(p.slug)
      if (!prev || (p.impressions || 0) > (prev.impressions || 0)) out.set(p.slug, p)
    }
  }
  return out
}

async function findQueueItem(slug: string): Promise<{ id: string; status: string; airportCode?: string } | null> {
  const res = await fetch(`${CMS_URL}/api/content-queue?where[slug][equals]=${encodeURIComponent(slug)}&depth=0`, { headers })
  if (!res.ok) return null
  const j = await res.json()
  return (j.docs || [])[0] || null
}

async function requeue(id: string): Promise<boolean> {
  const res = await fetch(`${CMS_URL}/api/content-queue/${id}`, {
    method: 'PATCH', headers, body: JSON.stringify({ status: 'queued' }),
  })
  return res.ok
}

async function main() {
  const files = gscReportFiles()
  if (files.length === 0) { console.log('No GSC reports found in reports/. Run `npm run gsc` first.'); return }
  const latest = JSON.parse(fs.readFileSync(path.join(REPORTS_DIR, files[files.length - 1]), 'utf8'))
  const prev = files.length >= 2 ? JSON.parse(fs.readFileSync(path.join(REPORTS_DIR, files[files.length - 2]), 'utf8')) : null
  console.log(`\n🔄 Refresh candidates — latest GSC: ${files[files.length - 1]}${prev ? `  (decay vs ${files[files.length - 2]})` : ''}`)
  console.log(`   filters: position ${MIN_POS}-${MAX_POS}, impressions ≥ ${MIN_IMPR}, limit ${LIMIT}${APPLY ? '  [APPLY]' : '  [dry-run]'}\n`)

  const cur = pagesFromReport(latest)
  const old = prev ? pagesFromReport(prev) : new Map<string, GscPage>()
  const candidates: Candidate[] = []

  for (const [slug, p] of cur) {
    const pos = p.position!
    const impr = p.impressions || 0
    const clicks = p.clicks || 0
    // quick-win: close to page 1 with real demand
    if (pos >= MIN_POS && pos <= MAX_POS && impr >= MIN_IMPR) {
      // opportunity ∝ impressions, weighted toward positions just off page 1
      const opportunity = Math.round(impr * (1 + Math.max(0, (20 - pos) / 20)))
      candidates.push({ slug, position: round(pos), impressions: impr, clicks, type: 'quick-win', opportunity, detail: `pos ${round(pos)}, ${impr} impr` })
      continue
    }
    // decaying: meaningful impression drop vs previous report
    const before = old.get(slug)
    if (before && (before.impressions || 0) >= MIN_IMPR) {
      const drop = (before.impressions || 0) - impr
      const dropPct = (before.impressions || 0) > 0 ? drop / (before.impressions || 1) : 0
      if (dropPct >= 0.3 && drop >= MIN_IMPR) {
        candidates.push({ slug, position: round(pos), impressions: impr, clicks, type: 'decaying', opportunity: drop, detail: `impr ${before.impressions}→${impr} (−${Math.round(dropPct * 100)}%)` })
      }
    }
  }

  candidates.sort((a, b) => b.opportunity - a.opportunity)
  const top = candidates.slice(0, LIMIT)

  if (top.length === 0) { console.log('No candidates matched the filters.'); return }
  console.log(`Found ${candidates.length} candidate(s); showing top ${top.length}:\n`)
  console.log('   opportunity  type        position  impr   slug')
  for (const c of top) {
    console.log(`   ${String(c.opportunity).padStart(10)}  ${c.type.padEnd(10)}  ${String(c.position).padStart(7)}  ${String(c.impressions).padStart(5)}  ${c.slug}`)
  }

  if (!APPLY) {
    console.log('\n[dry-run] Nothing changed. Re-run with --apply to set these to status=queued, then `npm run generate`.')
    return
  }

  console.log('\nRe-queueing (status → queued)...')
  let requeued = 0, missing = 0, failed = 0
  const airports = new Set<string>()
  for (const c of top) {
    const item = await findQueueItem(c.slug)
    if (!item) { console.log(`  ⊘ ${c.slug} — no content-queue item, skipping`); missing++; continue }
    if (item.status === 'queued') { console.log(`  • ${c.slug} — already queued`); continue }
    const ok = await requeue(item.id)
    if (ok) { console.log(`  ✓ ${c.slug} (was ${item.status}) → queued`); requeued++; if (item.airportCode) airports.add(item.airportCode) }
    else { console.log(`  ✗ ${c.slug} — re-queue failed`); failed++ }
  }
  console.log(`\nDone. Re-queued: ${requeued}, already-queued/skipped: ${top.length - requeued - missing - failed}, missing: ${missing}, failed: ${failed}`)
  if (requeued > 0) {
    console.log(`Next: npm run generate -- --airport <code>   (airports touched: ${[...airports].join(', ') || 'see above'})`)
    if (DO_CHANGELOG) {
      console.log('\nLog this batch with:')
      console.log(`  npm run changelog log "Refresh batch: re-queued ${requeued} GSC quick-win/decaying pages" -- --category content --impact medium`)
    }
  }
}

function round(x: number, d = 1): number { return Math.round(x * 10 ** d) / 10 ** d }

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
