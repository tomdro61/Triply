/**
 * maintain-holdout.ts — the never-touched control cohort + program-lift proof.
 *
 * To prove the maintenance program creates real value (not seasonal noise), we
 * reserve a small, deterministic, representative slice of articles that
 * `maintain run` NEVER treats. Later, `maintain lift` compares the movement of the
 * treated cohort against this holdout over the same window — the difference is the
 * program's causal lift.
 *
 * Selection is a stable per-slug hash (reproducible across runs, no RNG) taken
 * lowest-first WITHIN each article-type stratum, so the holdout mirrors the corpus
 * mix (hubs/sub-pillars/spokes) instead of skewing. Lift is computed from snapshots
 * already on disk — no new GSC calls.
 */

import { median } from './perf-control.js'
import { loadRecord, saveRecord } from './perf-snapshot.js'
import type { ArticlePerfRecord, PerfSnapshot } from './perf-snapshot.js'
import { getAllPublishedPosts } from './payload.js'

const DAY_MS = 24 * 60 * 60 * 1000

/** Deterministic FNV-1a hash of a string mapped to [0,1). No RNG → reproducible cohorts. */
function hash01(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
  return (h >>> 0) / 4294967296
}

// ── Assignment ──────────────────────────────────────────────────────────────

export interface HoldoutSummary {
  total: number
  assigned: number
  skippedNoRecord: number
  byType: Record<string, { total: number; holdout: number }>
}

/**
 * Assign ~pct% of published articles to the holdout cohort, stratified by
 * article-type. Persists `holdout` onto each existing record (dry-run just
 * reports). Idempotent: same slugs + pct → same cohort. Requires records to exist
 * (run `maintain plan --refresh` first) — articles without a record are skipped.
 */
export async function assignHoldout(opts: { airport?: string; pct?: number; dryRun?: boolean }): Promise<HoldoutSummary> {
  const pct = opts.pct ?? 5
  const posts = await getAllPublishedPosts(opts.airport)

  // Stratify by article-type, take the lowest-hash pct% within each stratum.
  const byType = new Map<string, string[]>()
  for (const p of posts) {
    const t = p.articleType || 'spoke'
    if (!byType.has(t)) byType.set(t, [])
    byType.get(t)!.push(p.slug)
  }
  const holdoutSet = new Set<string>()
  const typeStats: HoldoutSummary['byType'] = {}
  for (const [t, slugs] of byType) {
    const sorted = [...slugs].sort((a, b) => hash01(a) - hash01(b))
    const take = Math.floor(sorted.length * (pct / 100))
    for (const s of sorted.slice(0, take)) holdoutSet.add(s)
    typeStats[t] = { total: slugs.length, holdout: take }
  }

  let assigned = 0
  let skippedNoRecord = 0
  for (const p of posts) {
    const record = loadRecord(p.slug)
    if (!record) { skippedNoRecord++; continue }
    const shouldHold = holdoutSet.has(p.slug)
    if (record.holdout !== shouldHold) {
      record.holdout = shouldHold
      if (!opts.dryRun) saveRecord(record)
    }
    if (shouldHold) assigned++
  }

  const summary: HoldoutSummary = { total: posts.length, assigned, skippedNoRecord, byType: typeStats }
  console.log(`\n🧪 Holdout ${opts.dryRun ? '(dry-run)' : ''} — ${pct}% stratified${opts.airport ? ` · ${opts.airport.toUpperCase()}` : ''}`)
  console.log(`   ${posts.length} published · ${holdoutSet.size} selected · ${assigned} stamped onto records · ${skippedNoRecord} skipped (no record yet)`)
  for (const [t, s] of Object.entries(typeStats)) console.log(`   · ${t.padEnd(12)} ${s.holdout}/${s.total} held out`)
  if (skippedNoRecord > 0) {
    const targetPct = pct
    const actualPct = posts.length ? ((assigned / posts.length) * 100).toFixed(1) : '0'
    console.log(`   ⚠ ${skippedNoRecord} article(s) had no record → control cohort is UNDERSIZED (~${actualPct}% vs ${targetPct}% target).`)
    console.log(`   ⚠ Run \`maintain plan --refresh\` first (so every article has a record), then re-run --assign to complete the cohort.`)
  }
  console.log('')
  return summary
}

/** List the current holdout cohort from saved records. */
export async function listHoldout(airport?: string): Promise<void> {
  const posts = await getAllPublishedPosts(airport)
  const held = posts.map((p) => p.slug).filter((slug) => loadRecord(slug)?.holdout === true)
  console.log(`\n🧪 Holdout cohort${airport ? ` · ${airport.toUpperCase()}` : ''} — ${held.length} article(s)`)
  held.slice(0, 60).forEach((s) => console.log(`   · ${s}`))
  if (held.length > 60) console.log(`   … and ${held.length - 60} more`)
  console.log('')
}

// ── Lift measurement ──────────────────────────────────────────────────────────

interface CohortMove { imprPct: number[]; posDelta: number[]; n: number }

/** First-vs-latest snapshot movement within the trailing `window` days for one record. */
function moveWithinWindow(rec: ArticlePerfRecord, now: Date, windowDays: number): { imprPct: number | null; posDelta: number | null } {
  const cutoff = now.getTime() - windowDays * DAY_MS
  const inWin = rec.snapshots.filter((s: PerfSnapshot) => new Date(s.capturedAt).getTime() >= cutoff && s.gsc.found)
  if (inWin.length < 2) return { imprPct: null, posDelta: null }
  const base = inWin[0]
  const cur = inWin[inWin.length - 1]
  const imprPct = base.gsc.totals.impressions > 0
    ? (cur.gsc.totals.impressions - base.gsc.totals.impressions) / base.gsc.totals.impressions
    : null
  const posDelta = cur.gsc.totals.position - base.gsc.totals.position
  return { imprPct, posDelta }
}

function isTreated(rec: ArticlePerfRecord): boolean {
  return (rec.changes?.some((c) => !c.reverted) ?? false) || !!rec.maintenance?.lastMaintainedAt
}

/**
 * Program-wide lift: median movement of the treated cohort minus the holdout
 * cohort over the same window, from stored snapshots only. Positive impr lift and
 * negative position lift = the program beat its untouched control.
 */
export async function computeLift(opts: { airport?: string; window?: number }): Promise<void> {
  const windowDays = opts.window ?? 28
  const now = new Date()
  const posts = await getAllPublishedPosts(opts.airport)

  const treated: CohortMove = { imprPct: [], posDelta: [], n: 0 }
  const holdout: CohortMove = { imprPct: [], posDelta: [], n: 0 }

  for (const p of posts) {
    const rec = loadRecord(p.slug)
    if (!rec) continue
    const { imprPct, posDelta } = moveWithinWindow(rec, now, windowDays)
    if (imprPct === null && posDelta === null) continue
    const bucket = rec.holdout ? holdout : isTreated(rec) ? treated : null
    if (!bucket) continue // untreated non-holdout — not part of this comparison
    bucket.n++
    if (imprPct !== null) bucket.imprPct.push(imprPct)
    if (posDelta !== null) bucket.posDelta.push(posDelta)
  }

  console.log(`\n📈 Program lift — treated vs holdout, last ${windowDays}d${opts.airport ? ` · ${opts.airport.toUpperCase()}` : ''}\n`)
  const MIN = 3
  if (treated.imprPct.length < MIN || holdout.imprPct.length < MIN) {
    console.log(`   Inconclusive — need ≥${MIN} measurable articles per cohort with ≥2 in-window snapshots.`)
    console.log(`   Have: treated ${treated.imprPct.length}, holdout ${holdout.imprPct.length}.`)
    console.log(`   (Assign a holdout, let snapshots accrue over the window, then re-check.)\n`)
    return
  }

  const tImpr = median(treated.imprPct), hImpr = median(holdout.imprPct)
  const tPos = median(treated.posDelta), hPos = median(holdout.posDelta)
  const imprLift = (tImpr - hImpr) * 100
  const posLift = tPos - hPos // negative = treated improved rank more than control
  console.log(`   Treated (${treated.n}):  median Δimpr ${(tImpr * 100).toFixed(1)}%   median Δpos ${tPos.toFixed(2)}`)
  console.log(`   Holdout (${holdout.n}):  median Δimpr ${(hImpr * 100).toFixed(1)}%   median Δpos ${hPos.toFixed(2)}`)
  console.log(`   ─────`)
  console.log(`   NET LIFT:  impressions ${imprLift >= 0 ? '+' : ''}${imprLift.toFixed(1)}%   ·   position ${posLift <= 0 ? '' : '+'}${posLift.toFixed(2)} (negative = better)`)
  const verdict = imprLift > 2 || posLift < -0.3 ? '✅ program is beating its control'
    : imprLift < -2 || posLift > 0.3 ? '⚠ program is underperforming its control — investigate'
    : '≈ no clear separation yet'
  console.log(`   ${verdict}\n`)
}
