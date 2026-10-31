/**
 * maintain-learn.ts — the learning loop's brain (treatment-ROI aggregation).
 *
 * Reads every per-article record's measured verdicts (changes[].measuredAfter,
 * produced by `perf measure`) and answers: which treatment types actually pay off,
 * per article-type? Groups verdicts by (articleType × change.type), computes win
 * rates + median lift, and derives a CONSERVATIVE policy that disables a treatment
 * for an article-type only once it's proven to lose (enough samples + clearly
 * negative). That policy is consumed at run time by allowedRecTypes() — closing
 * the loop so the system stops doing what measurably doesn't work.
 *
 * Purely reads existing data (no GSC calls, no CMS writes). Numeric thresholds are
 * NOT auto-tuned here — only treatment selection is learned (safer signal).
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { median } from './perf-control.js'
import type { ArticlePerfRecord } from './perf-snapshot.js'
import { LEARN_DISABLE_WINRATE, LEARN_DISABLE_NET_FRACTION } from './config.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPORTS_DIR = path.resolve(__dirname, '..', 'reports')
const ARTICLES_DIR = path.join(REPORTS_DIR, 'articles')
export const ROI_FILE = path.join(REPORTS_DIR, 'treatment-roi.json')
export const POLICY_FILE = path.join(REPORTS_DIR, 'treatment-policy.json')

// ── Shapes ────────────────────────────────────────────────────────────────────

export interface RoiGroup {
  key: string // `${articleType}:${type}` (or just `${type}` for the by-type rollup)
  articleType: string
  type: string
  helped: number
  hurt: number
  neutral: number
  inconclusive: number
  /** Decisive samples = helped + hurt (what the policy gate counts). */
  decisive: number
  winRate: number // helped / (helped + hurt), 0 if none decisive
  net: number // helped − hurt
  medianImprDelta: number
  medianPosDelta: number
  // ── GEO track: AI-Overview citation outcomes (parallel to the Google verdict above) ──
  citGained: number
  citLost: number
  citHeld: number
  /** Citation win rate = gained / (gained + lost), 0 if none decisive. */
  citWinRate: number
}

export interface RoiReport {
  generatedAt: string
  totalMeasured: number
  groups: RoiGroup[] // by (articleType × type)
  byType: RoiGroup[] // by type only
}

export interface TreatmentPolicy {
  generatedAt: string
  minSamples: number
  /** key = `${articleType}:${type}` → why it's disabled. Presence = disabled. */
  disabled: Record<string, { reason: string; decisive: number; net: number; winRate: number }>
}

// ── Aggregation ────────────────────────────────────────────────────────────────

function loadAllRecords(): ArticlePerfRecord[] {
  if (!fs.existsSync(ARTICLES_DIR)) return []
  const out: ArticlePerfRecord[] = []
  for (const f of fs.readdirSync(ARTICLES_DIR)) {
    if (!f.endsWith('.json')) continue
    try { out.push(JSON.parse(fs.readFileSync(path.join(ARTICLES_DIR, f), 'utf-8'))) } catch { /* skip corrupt */ }
  }
  return out
}

/** Accumulator keyed by a group id, holding raw verdict tallies + delta samples. */
interface Acc {
  articleType: string
  type: string
  helped: number; hurt: number; neutral: number; inconclusive: number
  imprDeltas: number[]; posDeltas: number[]
  citGained: number; citLost: number; citHeld: number
}

function newAcc(articleType: string, type: string): Acc {
  return { articleType, type, helped: 0, hurt: 0, neutral: 0, inconclusive: 0, imprDeltas: [], posDeltas: [], citGained: 0, citLost: 0, citHeld: 0 }
}

function finalize(a: Acc, key: string): RoiGroup {
  const decisive = a.helped + a.hurt
  const citDecisive = a.citGained + a.citLost
  return {
    key,
    articleType: a.articleType,
    type: a.type,
    helped: a.helped, hurt: a.hurt, neutral: a.neutral, inconclusive: a.inconclusive,
    decisive,
    winRate: decisive ? a.helped / decisive : 0,
    net: a.helped - a.hurt,
    medianImprDelta: median(a.imprDeltas),
    medianPosDelta: median(a.posDeltas),
    citGained: a.citGained, citLost: a.citLost, citHeld: a.citHeld,
    citWinRate: citDecisive ? a.citGained / citDecisive : 0,
  }
}

/**
 * Aggregate every measured, non-reverted change across all records into ROI groups.
 * Reverted changes are excluded (a revert means the verdict was acted on already).
 */
export function aggregateTreatmentRoi(records: ArticlePerfRecord[] = loadAllRecords()): RoiReport {
  const byPair = new Map<string, Acc>()
  const byType = new Map<string, Acc>()
  let totalMeasured = 0

  const accFor = (m: Map<string, Acc>, key: string, articleType: string, type: string): Acc => {
    let a = m.get(key)
    if (!a) { a = newAcc(articleType, type); m.set(key, a) }
    return a
  }
  const tally = (a: Acc, ch: ArticlePerfRecord['changes'][number]) => {
    if (ch.measuredAfter) {
      const v = ch.measuredAfter.verdict
      if (v === 'helped') a.helped++
      else if (v === 'hurt') a.hurt++
      else if (v === 'neutral') a.neutral++
      else a.inconclusive++
      if (Number.isFinite(ch.measuredAfter.impressionsDelta)) a.imprDeltas.push(ch.measuredAfter.impressionsDelta)
      if (Number.isFinite(ch.measuredAfter.positionDelta)) a.posDeltas.push(ch.measuredAfter.positionDelta)
    }
    if (ch.citationDelta === 'gained') a.citGained++
    else if (ch.citationDelta === 'lost') a.citLost++
    else if (ch.citationDelta === 'held') a.citHeld++
  }

  for (const rec of records) {
    const articleType = rec.articleType || 'spoke'
    for (const ch of rec.changes || []) {
      if (ch.reverted || ch.patchUnverified) continue
      // Count a change if it has EITHER a Google verdict OR a citation outcome.
      if (!ch.measuredAfter && !ch.citationDelta) continue
      if (ch.measuredAfter) totalMeasured++
      tally(accFor(byPair, `${articleType}:${ch.type}`, articleType, ch.type), ch)
      tally(accFor(byType, ch.type, '(all)', ch.type), ch)
    }
  }

  const groups = [...byPair.entries()].map(([k, a]) => finalize(a, k)).sort((x, y) => x.net - y.net)
  const typeRollup = [...byType.entries()].map(([k, a]) => finalize(a, k)).sort((x, y) => x.net - y.net)
  return { generatedAt: new Date().toISOString(), totalMeasured, groups, byType: typeRollup }
}

// ── Policy derivation ───────────────────────────────────────────────────────────

/**
 * Derive the auto-disable policy from ROI. CONSERVATIVE by design: a treatment is
 * disabled for an article-type only when it has enough decisive samples AND is
 * clearly losing (low win-rate AND a net loss scaled to sample size). Everything
 * else stays enabled. Reversible — delete the policy file to re-enable.
 */
export function computeTreatmentPolicy(report: RoiReport, minSamples = 8): TreatmentPolicy {
  const disabled: TreatmentPolicy['disabled'] = {}
  for (const g of report.groups) {
    if (g.decisive < minSamples) continue
    const clearlyLosing = g.winRate < LEARN_DISABLE_WINRATE && g.net <= -Math.ceil(g.decisive * LEARN_DISABLE_NET_FRACTION)
    if (clearlyLosing) {
      disabled[g.key] = {
        reason: `${g.helped}/${g.decisive} helped (winRate ${(g.winRate * 100).toFixed(0)}%, net ${g.net}) over ${g.decisive} decisive samples`,
        decisive: g.decisive, net: g.net, winRate: g.winRate,
      }
    }
  }
  return { generatedAt: new Date().toISOString(), minSamples, disabled }
}

/** Load the persisted policy the runtime should honor (null if none written yet). */
export function loadTreatmentPolicy(): TreatmentPolicy | null {
  if (!fs.existsSync(POLICY_FILE)) return null
  try { return JSON.parse(fs.readFileSync(POLICY_FILE, 'utf-8')) as TreatmentPolicy } catch { return null }
}

// ── CLI-facing runner ─────────────────────────────────────────────────────────

export function runLearn(opts: { writePolicy: boolean; minSamples?: number }): void {
  const report = aggregateTreatmentRoi()
  fs.writeFileSync(ROI_FILE, JSON.stringify(report, null, 2))

  console.log(`\n🧠 Treatment ROI — ${report.totalMeasured} measured verdict(s) across all records\n`)
  if (report.totalMeasured === 0) {
    console.log('   No measured verdicts yet. Run `perf measure --all` after the 28-day window;')
    console.log('   the ~448 edits from the 2026-07-08 sweep become measurable after ~2026-08-05.\n')
  } else {
    console.log('   By article-type × treatment (sorted worst net first):')
    for (const g of report.groups) {
      console.log(`   · ${g.key.padEnd(26)} n=${g.decisive} (${g.helped}✓/${g.hurt}✗/${g.neutral}~)  win ${(g.winRate * 100).toFixed(0)}%  net ${g.net >= 0 ? '+' : ''}${g.net}  medΔimpr ${g.medianImprDelta.toFixed(0)}  medΔpos ${g.medianPosDelta.toFixed(1)}`)
    }
    console.log('\n   By treatment (all article-types):')
    for (const g of report.byType) {
      console.log(`   · ${g.type.padEnd(16)} n=${g.decisive}  win ${(g.winRate * 100).toFixed(0)}%  net ${g.net >= 0 ? '+' : ''}${g.net}`)
    }
  }

  // GEO track: AI-Overview citation ROI (which treatments win us AI citations).
  const geoGroups = report.byType.filter((g) => g.citGained + g.citLost + g.citHeld > 0)
  if (geoGroups.length) {
    console.log('\n   🌐 AI citation ROI (Google AI Overview) by treatment:')
    for (const g of geoGroups) {
      const dec = g.citGained + g.citLost
      console.log(`   · ${g.type.padEnd(16)} gained ${g.citGained} · lost ${g.citLost} · held ${g.citHeld}` +
        (dec ? `  (win ${(g.citWinRate * 100).toFixed(0)}%)` : ''))
    }
  }

  const policy = computeTreatmentPolicy(report, opts.minSamples ?? 8)
  const disabledKeys = Object.keys(policy.disabled)
  console.log(`\n   Policy (auto-disable, n≥${policy.minSamples}, clearly-losing only): ${disabledKeys.length} disabled`)
  for (const k of disabledKeys) console.log(`     ⛔ ${k} — ${policy.disabled[k].reason}`)

  if (opts.writePolicy) {
    fs.writeFileSync(POLICY_FILE, JSON.stringify(policy, null, 2))
    console.log(`\n   ✓ Wrote ${ROI_FILE}\n   ✓ Wrote ${POLICY_FILE} (honored by \`maintain run\`)\n`)
  } else {
    console.log(`\n   ✓ Wrote ${ROI_FILE}\n   (--no-policy: treatment-policy.json NOT written — advisory only)\n`)
  }
}
