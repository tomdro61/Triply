/**
 * perf-control.ts — seasonality control group for the measure stage.
 *
 * The weakest link in per-URL before/after measurement is confounders — mostly
 * seasonal demand (e.g. the August travel peak), plus Google updates and
 * competitors. A raw "impressions went up 20%" could be entirely seasonal.
 *
 * Fix: for the edited page's airport cluster, measure a set of UNTOUCHED sibling
 * pages over the same before/after windows. Their median movement IS the seasonal
 * baseline. We then judge the edited page on its delta MINUS the control's delta
 * (relative lift), so "our edit helped" means it beat its untouched siblings.
 *
 * Before = the dated gsc-report nearest (at/before) the change date. After = a
 * live fetchUrlPerformance now. Computed ONCE per airport per measure run.
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { fetchUrlPerformance } from './gsc.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPORTS_DIR = path.resolve(__dirname, '..', 'reports')
const ARTICLES_DIR = path.join(REPORTS_DIR, 'articles')

export interface ControlDelta {
  count: number
  imprPctDelta: number // median fractional change in impressions across controls (e.g. 0.15 = +15%)
  positionDelta: number // median change in position (negative = ranks improved)
  note: string
  /**
   * Whether this control is coherent enough to REVERT on. A median over a handful of
   * heterogeneous pages is a noisy estimate, and acting on a noisy estimate is worse
   * than not acting: on 2026-08-14 the per-cluster medians ranged from -94% to +211%
   * impressions and -22 to +12 positions. Clusters that drew a positive control
   * reverted nearly everything (EWR 12/12, CLT 4/4) while clusters that drew a
   * negative one reverted nothing (MCO 0/11, ORD 0/29) — the outcome tracked the
   * control draw, not the treatment.
   */
  reliable: boolean
}

/** Interquartile range — spread of the control samples, used to detect an incoherent control. */
function iqr(xs: number[]): number {
  if (xs.length < 4) return Number.POSITIVE_INFINITY
  const s = [...xs].sort((a, b) => a - b)
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]
  return q(0.75) - q(0.25)
}

// A control is only actionable when there are enough siblings AND they broadly agree.
// These bounds are deliberately loose — they exist to reject nonsense, not to demand
// precision. Anything outside them means "we cannot attribute this change", not "the
// change was bad", so the verdict is still recorded; only auto-revert is withheld.
const MIN_RELIABLE_CONTROLS = 5
const MAX_RELIABLE_IMPR_IQR = 1.5 // 150 percentage points of spread
const MAX_RELIABLE_POS_IQR = 12 // positions
const MAX_PLAUSIBLE_POS_SHIFT = 10 // a market-wide median move beyond this is an artifact
// A median sibling that doubled its impressions is not showing seasonality — it is a
// freshly-published cohort still ramping into the index. TPA (+211%) and DEN (+179%)
// on 2026-08-14 are exactly that: clusters filled in recently, whose new pages climb
// from a near-zero base. Judging older treated pages against a ramping cohort marks
// healthy pages as regressions. Until controls are filtered by publish date, treat an
// extreme median as non-actionable.
const MAX_PLAUSIBLE_IMPR_SHIFT = 1.0 // ±100%

/** Median of a numeric list (0 for empty). Exported so the learn/holdout stages reuse it. */
export function median(xs: number[]): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/**
 * Slugs the loop has actually EDITED — excluded from controls.
 *
 * This used to treat "has a record file" as "was edited", which held only while
 * records existed solely for treated articles. `track-all` now snapshots the whole
 * corpus (3,744 records, of which just 282 have any changes), so that test excluded
 * every possible control and computeControlDelta always returned count 0 — silently
 * dropping every verdict to raw before/after judging. During a site-wide seasonal
 * decline raw judging marks almost everything 'hurt' and auto-reverts it.
 *
 * The weekly script runs track-all at step 0 and perf measure at step 1, so this was
 * guaranteed to fire on every scheduled run.
 *
 * A record counts as edited only if it has at least one entry in changes[].
 */
let editedSlugCache: Set<string> | null = null
function editedSlugSet(): Set<string> {
  if (editedSlugCache) return editedSlugCache
  const edited = new Set<string>()
  if (!fs.existsSync(ARTICLES_DIR)) return (editedSlugCache = edited)
  for (const f of fs.readdirSync(ARTICLES_DIR)) {
    if (!f.endsWith('.json')) continue
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(ARTICLES_DIR, f), 'utf-8'))
      if (Array.isArray(rec.changes) && rec.changes.length > 0) edited.add(f.replace(/\.json$/, ''))
    } catch {
      // Unreadable record — assume it was edited. Excluding one candidate costs a
      // control slot; wrongly including a treated page would contaminate the baseline.
      edited.add(f.replace(/\.json$/, ''))
    }
  }
  return (editedSlugCache = edited)
}

/** Per-slug {impressions, position} for an airport, pulled from a saved gsc-report. */
function airportPagesFromReport(report: any, airportCode: string): Map<string, { impressions: number; position: number }> {
  const m = new Map<string, { impressions: number; position: number }>()
  const add = (p: any) => { if (p?.slug && !m.has(p.slug)) m.set(p.slug, { impressions: p.impressions, position: p.position }) }
  const cluster = (report.airportClusters || []).find((c: any) => c.airportCode === airportCode)
  if (cluster) { (cluster.topPages || []).forEach(add); (cluster.underperformingPages || []).forEach(add) }
  return m
}

/** Pick the gsc-report whose window ends at/before `dateISO`, closest to it. */
function loadReportNearest(dateISO: string): { file: string; data: any } | null {
  if (!fs.existsSync(REPORTS_DIR)) return null
  const files = fs.readdirSync(REPORTS_DIR).filter((f) => /^gsc-report-.*\.json$/.test(f))
  let best: string | null = null
  let bestEnd: string | null = null
  for (const f of files) {
    const m = f.match(/to-(\d{4}-\d{2}-\d{2})\.json$/)
    if (!m) continue
    const end = m[1]
    if (end <= dateISO && (!bestEnd || end > bestEnd)) { bestEnd = end; best = f }
  }
  if (!best) return null
  return { file: best, data: JSON.parse(fs.readFileSync(path.join(REPORTS_DIR, best), 'utf-8')) }
}

/**
 * Median before/after movement of untouched sibling pages in `airportCode`.
 * baselineDateISO should be the edit's apply date. Returns count<3 note when
 * there aren't enough measurable controls → caller falls back to raw judging.
 */
export async function computeControlDelta(
  airportCode: string,
  baselineDateISO: string,
  days = 28,
  maxControls = 10,
): Promise<ControlDelta> {
  const report = loadReportNearest(baselineDateISO)
  if (!report) return { count: 0, imprPctDelta: 0, positionDelta: 0, note: 'no baseline gsc-report', reliable: false }

  const edited = editedSlugSet()
  const basePages = airportPagesFromReport(report.data, airportCode)
  const candidates = [...basePages.entries()]
    .filter(([slug, m]) => !edited.has(slug) && m.impressions >= 20)
    .sort((a, b) => b[1].impressions - a[1].impressions)
    .slice(0, maxControls)

  if (candidates.length < 3) {
    return { count: candidates.length, imprPctDelta: 0, positionDelta: 0, note: `only ${candidates.length} control candidate(s) in ${report.file}`, reliable: false }
  }

  const imprPct: number[] = []
  const posD: number[] = []
  for (const [slug, before] of candidates) {
    const after = await fetchUrlPerformance(slug, days)
    if (!after.found) continue
    if (before.impressions > 0) imprPct.push((after.totals.impressions - before.impressions) / before.impressions)
    posD.push(after.totals.position - before.position)
  }

  if (imprPct.length < 3) {
    return { count: imprPct.length, imprPctDelta: 0, positionDelta: 0, note: `only ${imprPct.length} measurable control(s)`, reliable: false }
  }

  const imprMedian = median(imprPct)
  const posMedian = median(posD)
  const imprSpread = iqr(imprPct)
  const posSpread = iqr(posD)

  const reasons: string[] = []
  if (imprPct.length < MIN_RELIABLE_CONTROLS) reasons.push(`n=${imprPct.length}<${MIN_RELIABLE_CONTROLS}`)
  if (imprSpread > MAX_RELIABLE_IMPR_IQR) reasons.push(`impr IQR ${(imprSpread * 100).toFixed(0)}pp`)
  if (posSpread > MAX_RELIABLE_POS_IQR) reasons.push(`pos IQR ${posSpread.toFixed(1)}`)
  if (Math.abs(posMedian) > MAX_PLAUSIBLE_POS_SHIFT) reasons.push(`implausible median pos shift ${posMedian.toFixed(1)}`)
  if (Math.abs(imprMedian) > MAX_PLAUSIBLE_IMPR_SHIFT) reasons.push(`implausible median impr shift ${(imprMedian * 100).toFixed(0)}% (likely a ramping cohort, not seasonality)`)
  const reliable = reasons.length === 0

  return {
    count: imprPct.length,
    imprPctDelta: imprMedian,
    positionDelta: posMedian,
    note: `${imprPct.length} untouched ${airportCode} siblings vs ${report.file}`
      + (reliable ? '' : ` — NOT actionable (${reasons.join('; ')})`),
    reliable,
  }
}
