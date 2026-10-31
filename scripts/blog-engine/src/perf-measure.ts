/**
 * perf-measure.ts — closes the loop: did an applied change help or hurt?
 *
 * For each logged change past its attribution window, re-pull GSC for the URL,
 * compare to the baseline captured at apply time, assign a verdict, and — if the
 * change clearly REGRESSED — auto-revert it by restoring the pre-edit CMS state.
 *
 * Signals: impressions + position ONLY (GSC CTR is unreliable post the 2025-2026
 * logging bug). Honest about confounders — when the baseline had too little data
 * to judge, the verdict is 'inconclusive' and nothing is reverted.
 *
 * CLI: perf measure --slug X [--window 28] [--no-revert]
 *      perf measure --all   [--window 28] [--no-revert]
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { fetchUrlPerformance } from './gsc.js'
import { findPostBySlug, updatePost } from './payload.js'
import { loadRecord, saveRecord } from './perf-snapshot.js'
import type { ArticlePerfRecord, PerfChange } from './perf-snapshot.js'
import { computeControlDelta } from './perf-control.js'
import type { ControlDelta } from './perf-control.js'
import { PERF_MIN_BASELINE_IMPRESSIONS } from './config.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ARTICLES_DIR = path.resolve(__dirname, '..', 'reports', 'articles')

const DAY_MS = 24 * 60 * 60 * 1000
const MIN_BASELINE_IMPRESSIONS = PERF_MIN_BASELINE_IMPRESSIONS // below this, we can't judge — call it inconclusive

type Verdict = NonNullable<PerfChange['measuredAfter']>['verdict']

function judge(
  base: { impressions: number; position: number },
  after: { impressions: number; position: number; found: boolean },
  control: ControlDelta | null,
): { verdict: Verdict; impressionsDelta: number; positionDelta: number; note: string; controlled: boolean } {
  const impressionsDelta = after.impressions - base.impressions // RAW change (what actually happened)
  const positionDelta = after.position - base.position // negative = better rank

  if (base.impressions < MIN_BASELINE_IMPRESSIONS || !after.found) {
    return { verdict: 'inconclusive', impressionsDelta, positionDelta, note: 'baseline too small / no after-data', controlled: false }
  }

  // Control-adjust when we have a usable seasonal control group: subtract what the
  // untouched siblings did, so the verdict reflects OUR edit, not August demand.
  let imprForJudge = impressionsDelta
  let posForJudge = positionDelta
  let note = 'raw (no control group)'
  // Adjust with any usable control, but only treat the verdict as ACTIONABLE when the
  // control is also coherent — see ControlDelta.reliable.
  const hasControl = !!control && control.count >= 3
  const controlled = hasControl && control!.reliable
  if (hasControl) {
    const expectedImpr = base.impressions * control!.imprPctDelta // seasonal expectation
    imprForJudge = impressionsDelta - expectedImpr
    posForJudge = positionDelta - control!.positionDelta
    note = `control-adjusted vs ${control!.count} siblings (they moved ${(control!.imprPctDelta * 100).toFixed(0)}% impr, ${control!.positionDelta.toFixed(1)} pos)`
  }

  const imprThreshold = Math.max(10, base.impressions * 0.15)
  const moreImpr = imprForJudge >= imprThreshold
  const fewerImpr = imprForJudge <= -imprThreshold
  const betterRank = posForJudge <= -2
  const worseRank = posForJudge >= 2

  if (fewerImpr || worseRank) {
    if (moreImpr || betterRank) return { verdict: 'neutral', impressionsDelta, positionDelta, note, controlled }
    return { verdict: 'hurt', impressionsDelta, positionDelta, note, controlled }
  }
  if (moreImpr || betterRank) return { verdict: 'helped', impressionsDelta, positionDelta, note, controlled }
  return { verdict: 'neutral', impressionsDelta, positionDelta, note, controlled }
}

async function measureRecord(
  rec: ArticlePerfRecord,
  windowDays: number,
  autoRevert: boolean,
  days: number,
  controlCache: Map<string, ControlDelta | null>,
): Promise<{ measured: number; reverted: number; waiting: number }> {
  const now = Date.now()
  const pending = rec.changes.filter((c) => !c.measuredAfter && !c.reverted && !c.patchUnverified)
  if (pending.length === 0) return { measured: 0, reverted: 0, waiting: 0 }

  let measured = 0
  let reverted = 0
  let waiting = 0

  // Only pull GSC once per record if at least one change is ready.
  const anyReady = pending.some((c) => now - new Date(c.at).getTime() >= windowDays * DAY_MS)
  const perf = anyReady ? await fetchUrlPerformance(rec.slug, days) : null

  // Compute the seasonal control ONCE per airport across the whole measure run.
  let control: ControlDelta | null = null
  if (anyReady && rec.airportCode) {
    if (!controlCache.has(rec.airportCode)) {
      const firstReady = pending.find((c) => now - new Date(c.at).getTime() >= windowDays * DAY_MS)!
      const cd = await computeControlDelta(rec.airportCode, firstReady.at.slice(0, 10), days)
      controlCache.set(rec.airportCode, cd)
      console.log(`  🎛 ${rec.airportCode} control: ${cd.note}` + (cd.count >= 3 ? ` → siblings moved ${(cd.imprPctDelta * 100).toFixed(0)}% impr, ${cd.positionDelta.toFixed(1)} pos` : ' → falling back to raw'))
    }
    control = controlCache.get(rec.airportCode) || null
  }

  for (const c of pending) {
    const ageDays = (now - new Date(c.at).getTime()) / DAY_MS
    if (ageDays < windowDays) {
      waiting++
      console.log(`  ⏳ ${rec.slug} [${c.type}] — waiting ${Math.ceil(windowDays - ageDays)} more day(s) before measuring`)
      continue
    }
    const after = { impressions: perf!.totals.impressions, position: perf!.totals.position, found: perf!.found }
    const { verdict, impressionsDelta, positionDelta, note, controlled } = judge(c.baselineMetrics, after, control)
    c.measuredAfter = { at: new Date().toISOString(), impressionsDelta, positionDelta, verdict, note }
    measured++

    const imprStr = `${impressionsDelta >= 0 ? '+' : ''}${impressionsDelta} impr`
    const posStr = `${positionDelta <= 0 ? '' : '+'}${positionDelta.toFixed(1)} pos`
    console.log(`  📈 ${rec.slug} [${c.type}] → ${verdict.toUpperCase()} (${imprStr}, ${posStr}) — ${note}`)

    // Auto-revert requires a control group. Without untouched siblings to subtract, a
    // 'hurt' verdict cannot distinguish our edit from a site-wide move — and during the
    // Jul→Aug 2026 decline (every cluster lost clicks) raw judging marked almost
    // everything hurt. Record the verdict either way; only ACT on a controlled one.
    if (verdict === 'hurt' && !controlled) {
      const why = control && control.count >= 3 ? 'control group too noisy to attribute' : 'no control group'
      console.log(`     ⓘ not reverting — ${why}, so this may just be the site-wide trend`)
    }
    if (verdict === 'hurt' && controlled && autoRevert && c.preEdit) {
      const post = await findPostBySlug(rec.slug)
      if (post) {
        await updatePost(post.id, c.preEdit as Record<string, unknown>)
        c.reverted = true
        reverted++
        console.log(`     ↩ auto-reverted (regression) — restored pre-edit state`)
      }
    }
  }

  saveRecord(rec)
  return { measured, reverted, waiting }
}

export async function measureSlug(slug: string, windowDays: number, autoRevert: boolean, days = 28): Promise<void> {
  const rec = loadRecord(slug)
  if (!rec) { console.log(`  No record for "${slug}".`); return }
  const controlCache = new Map<string, ControlDelta | null>()
  const r = await measureRecord(rec, windowDays, autoRevert, days, controlCache)
  console.log(`\n  ${slug}: measured ${r.measured}, reverted ${r.reverted}, waiting ${r.waiting}\n`)
}

export async function measureAll(windowDays: number, autoRevert: boolean, days = 28): Promise<void> {
  if (!fs.existsSync(ARTICLES_DIR)) { console.log('  No article records yet.'); return }
  const files = fs.readdirSync(ARTICLES_DIR).filter((f) => f.endsWith('.json'))
  const controlCache = new Map<string, ControlDelta | null>() // one control computation per airport per run
  let measured = 0, reverted = 0, waiting = 0
  for (const f of files) {
    const rec = loadRecord(f.replace(/\.json$/, ''))
    if (!rec) continue
    const r = await measureRecord(rec, windowDays, autoRevert, days, controlCache)
    measured += r.measured; reverted += r.reverted; waiting += r.waiting
  }
  console.log(`\n  Across ${files.length} record(s): measured ${measured}, reverted ${reverted}, waiting ${waiting}\n`)
}
