/**
 * analyze-logs.ts — Workstream C, Phase 0 (read-only, $0)
 *
 * Mines the existing article logs (logs/*.json) and GSC reports (reports/gsc-report-*.json)
 * to establish baselines BEFORE spending on cost/quality experiments:
 *   1. SEO score distribution by article type (normalized to %)
 *   2. Cost distribution by type, split by whether the edit pass ran
 *   3. Point-loss ranking — which scorer checks bleed the most points (cheapest fixes)
 *   4. Edit-pass uplift distribution (does editing actually help, and how much?)
 *   5. Score <-> GSC-position correlation (Spearman rho) — the gate that decides
 *      whether SEO score is a trustworthy fast proxy for real rankings
 *   6. Per-airport difficulty map (mean score vs mean GSC position)
 *
 * Writes only reports/log-analysis-<date>.json and prints tables. No API calls, no CMS writes.
 *
 * Run:  npm run analyze-logs
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const LOGS_DIR = path.join(ROOT, 'logs')
const REPORTS_DIR = path.join(ROOT, 'reports')

// ---------- types (loose; logs are trusted internal data) ----------
interface Check { name: string; passed: boolean; points: number; maxPoints: number; detail?: string }
interface CategoryScore { name: string; points: number; maxPoints: number; checks: Check[] }
interface SeoScore { total: number; maxTotal: number; grade: string; categories: CategoryScore[] }
interface LogReport {
  timestamp: string
  promptVersion?: string
  slug: string
  articleType: string
  airportCode: string
  seoScore: SeoScore | null
  revision: { triggered: boolean; scoreBefore: number; scoreAfter: number } | null
  tokenUsage?: { totalCost: number }
  experiment?: { arm: string | null; modelAnalyze?: string; modelWrite?: string; modelEdit?: string }
  error: string | null
}
interface GscPage { slug?: string; position?: number; impressions?: number; clicks?: number; ctr?: number }

// ---------- stats helpers ----------
function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN
  const pos = (sorted.length - 1) * q
  const base = Math.floor(pos)
  const rest = pos - base
  return sorted[base + 1] !== undefined ? sorted[base] + rest * (sorted[base + 1] - sorted[base]) : sorted[base]
}
function mean(xs: number[]): number { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN }
function summarize(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b)
  return {
    n: s.length,
    mean: round(mean(s)),
    median: round(quantile(s, 0.5)),
    p25: round(quantile(s, 0.25)),
    p75: round(quantile(s, 0.75)),
    p90: round(quantile(s, 0.9)),
    min: round(s[0]),
    max: round(s[s.length - 1]),
  }
}
function round(x: number, d = 2): number { return Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : x }
// average-rank (ties get mean rank) — needed for a correct Spearman
function rank(xs: number[]): number[] {
  const idx = xs.map((v, i) => [v, i] as [number, number]).sort((a, b) => a[0] - b[0])
  const ranks = new Array(xs.length).fill(0)
  let i = 0
  while (i < idx.length) {
    let j = i
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++
    const avg = (i + j) / 2 + 1
    for (let k = i; k <= j; k++) ranks[idx[k][1]] = avg
    i = j + 1
  }
  return ranks
}
function pearson(a: number[], b: number[]): number {
  const n = a.length
  if (n < 3) return NaN
  const ma = mean(a), mb = mean(b)
  let num = 0, da = 0, db = 0
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; num += x * y; da += x * x; db += y * y }
  return da && db ? num / Math.sqrt(da * db) : NaN
}
function spearman(a: number[], b: number[]): number { return pearson(rank(a), rank(b)) }

// ---------- load logs (latest per slug; skip errored / unscored) ----------
function loadLogs(): LogReport[] {
  const files = fs.readdirSync(LOGS_DIR).filter(f => f.endsWith('.json') && /^\d{4}-\d{2}-\d{2}_/.test(f))
  const bySlug = new Map<string, LogReport>()
  for (const f of files) {
    let j: LogReport
    try { j = JSON.parse(fs.readFileSync(path.join(LOGS_DIR, f), 'utf8')) } catch { continue }
    if (!j || j.error || !j.seoScore || !j.slug) continue
    const prev = bySlug.get(j.slug)
    if (!prev || (j.timestamp || '') > (prev.timestamp || '')) bySlug.set(j.slug, j)
  }
  return [...bySlug.values()]
}

// ---------- load GSC page positions (latest report per slug) ----------
function loadGscPositions(): Map<string, GscPage> {
  if (!fs.existsSync(REPORTS_DIR)) return new Map()
  const files = fs.readdirSync(REPORTS_DIR)
    .filter(f => f.startsWith('gsc-report-') && f.endsWith('.json'))
    .sort() // chronological by date in filename; later files win
  const bySlug = new Map<string, GscPage>()
  for (const f of files) {
    let r: any
    try { r = JSON.parse(fs.readFileSync(path.join(REPORTS_DIR, f), 'utf8')) } catch { continue }
    const buckets: GscPage[][] = []
    if (Array.isArray(r.topPages)) buckets.push(r.topPages)
    if (Array.isArray(r.lowCtrHighImpressions)) buckets.push(r.lowCtrHighImpressions)
    const clusters = Array.isArray(r.airportClusters) ? r.airportClusters : Object.values(r.airportClusters || {})
    for (const c of clusters as any[]) {
      if (Array.isArray(c.topPages)) buckets.push(c.topPages)
      if (Array.isArray(c.underperformingPages)) buckets.push(c.underperformingPages)
    }
    for (const bucket of buckets) for (const p of bucket) {
      if (p && p.slug && typeof p.position === 'number') bySlug.set(p.slug, p) // later report overwrites
    }
  }
  return bySlug
}

// ---------- analysis ----------
function main() {
  const logs = loadLogs()
  const gsc = loadGscPositions()
  const TYPES = ['hub', 'sub-pillar', 'spoke']
  const norm = (l: LogReport) => (l.seoScore!.total / l.seoScore!.maxTotal) * 100

  console.log(`\n📊 Log Analysis — ${logs.length} unique scored articles (latest per slug), ${gsc.size} GSC-joinable slugs\n`)

  // 1 + 2. Score & cost distribution by type
  console.log('── 1. SEO score (normalized %) & cost by article type ──')
  const byType: Record<string, any> = {}
  for (const t of TYPES) {
    const ls = logs.filter(l => l.articleType === t)
    if (!ls.length) continue
    const scores = ls.map(norm)
    const costs = ls.map(l => l.tokenUsage?.totalCost).filter((c): c is number => typeof c === 'number')
    const edited = ls.filter(l => l.revision?.triggered)
    const skipped = ls.filter(l => !l.revision?.triggered)
    const scoreStats = summarize(scores)
    const costStats = summarize(costs)
    byType[t] = {
      count: ls.length,
      score: scoreStats,
      cost: costStats,
      editRate: round(edited.length / ls.length, 3),
      costEdited: round(mean(edited.map(l => l.tokenUsage?.totalCost || 0)), 3),
      costSkipped: round(mean(skipped.map(l => l.tokenUsage?.totalCost || 0)), 3),
    }
    console.log(`\n  ${t.toUpperCase()} (n=${ls.length})`)
    console.log(`    score%:  mean ${scoreStats.mean}  median ${scoreStats.median}  p25 ${scoreStats.p25}  p75 ${scoreStats.p75}  range ${scoreStats.min}-${scoreStats.max}`)
    console.log(`    cost $:  mean ${costStats.mean}  median ${costStats.median}  p90 ${costStats.p90}  (edit rate ${(byType[t].editRate * 100).toFixed(0)}%; edited $${byType[t].costEdited} vs skipped $${byType[t].costSkipped})`)
  }

  // 3. Point-loss ranking
  console.log('\n── 2. Point-loss ranking (which checks bleed the most points across all articles) ──')
  const checkAgg = new Map<string, { occ: number; fails: number; ptsLost: number; maxPts: number }>()
  for (const l of logs) {
    for (const cat of l.seoScore!.categories || []) {
      for (const ch of cat.checks || []) {
        const e = checkAgg.get(ch.name) || { occ: 0, fails: 0, ptsLost: 0, maxPts: ch.maxPoints }
        e.occ++
        if (!ch.passed) e.fails++
        e.ptsLost += (ch.maxPoints - ch.points)
        checkAgg.set(ch.name, e)
      }
    }
  }
  const pointLoss = [...checkAgg.entries()]
    .map(([name, e]) => ({ check: name, failRate: round(e.fails / e.occ, 3), avgPtsLost: round(e.ptsLost / e.occ, 2), totalPtsLost: e.ptsLost, maxPts: e.maxPts }))
    .sort((a, b) => b.totalPtsLost - a.totalPtsLost)
  console.log('    rank  check                                         failRate  avgLost  totalLost')
  pointLoss.slice(0, 12).forEach((p, i) =>
    console.log(`    ${String(i + 1).padStart(2)}.   ${p.check.padEnd(44).slice(0, 44)}  ${(p.failRate * 100).toFixed(0).padStart(6)}%  ${String(p.avgPtsLost).padStart(7)}  ${String(p.totalPtsLost).padStart(9)}`))

  // 4. Edit-pass uplift
  console.log('\n── 3. Edit-pass uplift (scoreAfter − scoreBefore, where edit ran) ──')
  const uplifts = logs.filter(l => l.revision?.triggered && typeof l.revision.scoreAfter === 'number')
    .map(l => l.revision!.scoreAfter - l.revision!.scoreBefore)
  const upStats = summarize(uplifts)
  console.log(`    n=${upStats.n}  mean +${upStats.mean}  median +${upStats.median}  range ${upStats.min} to ${upStats.max}  (negative = edit hurt)`)

  // 5. Score <-> GSC position correlation (the gate)
  console.log('\n── 4. Score ↔ GSC position correlation (the proxy-trust gate) ──')
  const joined = logs
    .map(l => ({ slug: l.slug, score: norm(l), month: (l.timestamp || '').slice(0, 7), g: gsc.get(l.slug) }))
    .filter(x => x.g && typeof x.g.position === 'number' && (x.g.impressions || 0) >= 10)
  let rho = NaN
  let ageControlledRho = NaN
  const cohortRhos: { month: string; n: number; rho: number }[] = []
  if (joined.length >= 3) {
    rho = spearman(joined.map(x => x.score), joined.map(x => x.g!.position!))
    console.log(`    joined pages (impressions≥10): ${joined.length}`)
    console.log(`    POOLED Spearman ρ(score, position) = ${round(rho, 3)}  (NEGATIVE is good: higher score → lower/better position number)`)
    // binned table by score quartile
    const sortedByScore = [...joined].sort((a, b) => a.score - b.score)
    const qs = [0, 0.25, 0.5, 0.75, 1].map(q => quantile(sortedByScore.map(x => x.score), q))
    console.log('    score quartile → mean position / mean impressions:')
    for (let i = 0; i < 4; i++) {
      const lo = qs[i], hi = qs[i + 1]
      const bin = joined.filter(x => x.score >= lo && (i === 3 ? x.score <= hi : x.score < hi))
      if (bin.length) console.log(`      ${round(lo)}–${round(hi)}%  (n=${bin.length}): pos ${round(mean(bin.map(x => x.g!.position!)), 1)}, impr ${Math.round(mean(bin.map(x => x.g!.impressions || 0)))}`)
    }
    // AGE-CONTROLLED: Spearman WITHIN each generation-month cohort. The pooled ρ is
    // confounded — older articles scored lower (pre-template) but rank better (more
    // time indexed). Correlating within a cohort removes that age effect (Simpson guard).
    const byMonth = new Map<string, typeof joined>()
    for (const x of joined) { const m = x.month || 'unknown'; if (!byMonth.has(m)) byMonth.set(m, []); byMonth.get(m)!.push(x) }
    let wSum = 0, wN = 0
    console.log('    age-controlled — Spearman ρ within each generation-month cohort (n≥10):')
    for (const [m, arr] of [...byMonth.entries()].sort()) {
      if (arr.length < 10) continue
      const r = spearman(arr.map(x => x.score), arr.map(x => x.g!.position!))
      if (!Number.isFinite(r)) continue
      cohortRhos.push({ month: m, n: arr.length, rho: round(r, 3) })
      console.log(`      ${m}  (n=${arr.length}): ρ = ${round(r, 3)}`)
      wSum += r * arr.length; wN += arr.length
    }
    ageControlledRho = wN ? wSum / wN : NaN
    const gateRho = Number.isFinite(ageControlledRho) ? ageControlledRho : rho
    const basis = Number.isFinite(ageControlledRho) ? 'age-controlled' : 'pooled (no cohort ≥10 — age NOT controlled)'
    console.log(`    age-controlled ρ (sample-weighted) = ${round(ageControlledRho, 3)}`)
    const verdict = !Number.isFinite(gateRho) ? 'INSUFFICIENT'
      : gateRho <= -0.3 ? 'PASS — SEO score is a usable fast proxy'
      : gateRho <= -0.1 ? 'WEAK — use score cautiously, lean on GSC'
      : 'FAIL — score not predictive; harden seo-scorer / lean on GSC before score-judged experiments'
    console.log(`    GATE (${basis}): ${verdict}`)
  } else {
    console.log(`    Not enough joined pages (${joined.length}) for a correlation. Need more GSC data.`)
  }

  // 6. Per-airport difficulty
  console.log('\n── 5. Per-airport map (mean score% vs mean GSC position, where available) ──')
  const airports = [...new Set(logs.map(l => l.airportCode).filter(Boolean))]
  const airportRows = airports.map(a => {
    const ls = logs.filter(l => l.airportCode === a)
    const gp = ls.map(l => gsc.get(l.slug)).filter((g): g is GscPage => !!g && typeof g.position === 'number').map(g => g.position!)
    return { airport: a, n: ls.length, meanScore: round(mean(ls.map(norm)), 1), gscPages: gp.length, meanPos: gp.length ? round(mean(gp), 1) : null }
  }).sort((a, b) => b.n - a.n)
  console.log('    airport   n    score%   gscPages  meanPos')
  airportRows.forEach(r => console.log(`    ${r.airport.padEnd(8)} ${String(r.n).padStart(4)}   ${String(r.meanScore).padStart(5)}   ${String(r.gscPages).padStart(7)}   ${r.meanPos ?? '—'}`))

  // 7. Experiment arm comparison (Haiku A/B) — mean score% + cost per model arm.
  // Reads the experiment tag each generation run records (arm + per-step model ids).
  // Compares apples-to-apples per article type so a cheaper arm's score is trustworthy.
  console.log('\n── 6. Experiment arm comparison (model A/B — mean score% + cost) ──')
  const shortModel = (m?: string) => (m || 'sonnet-4-6').replace(/^claude-/, '').replace(/-\d{8}$/, '')
  const armLabel = (l: LogReport) => {
    const e = l.experiment
    const tag = e?.arm || 'untagged'
    return `${tag} [A:${shortModel(e?.modelAnalyze)} E:${shortModel(e?.modelEdit)} W:${shortModel(e?.modelWrite)}]`
  }
  const armGroups = new Map<string, LogReport[]>()
  for (const l of logs) { const k = armLabel(l); if (!armGroups.has(k)) armGroups.set(k, []); armGroups.get(k)!.push(l) }
  if (armGroups.size <= 1) {
    console.log('    only one arm present — run `run-generate-arm.ps1 -Arm haiku ...` on a small batch to compare')
  }
  const armSummary: any[] = []
  for (const [label, ls] of [...armGroups.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const scores = ls.map(norm)
    const costs = ls.map(l => l.tokenUsage?.totalCost).filter((c): c is number => typeof c === 'number')
    const s = summarize(scores)
    const meanCost = round(mean(costs), 3)
    console.log(`\n    ${label}  (n=${ls.length})`)
    console.log(`      score%: mean ${s.mean}  median ${s.median}  p25 ${s.p25}  p75 ${s.p75}   cost$: mean ${meanCost}`)
    const perType: Record<string, any> = {}
    for (const t of TYPES) {
      const tl = ls.filter(l => l.articleType === t)
      if (!tl.length) continue
      const ms = round(mean(tl.map(norm)), 1)
      const mc = round(mean(tl.map(l => l.tokenUsage?.totalCost || 0)), 3)
      perType[t] = { n: tl.length, meanScore: ms, meanCost: mc }
      console.log(`        ${t.padEnd(10)} n=${String(tl.length).padStart(4)}  score% ${ms}  cost$ ${mc}`)
    }
    armSummary.push({ arm: label, n: ls.length, score: s, meanCost, perType })
  }

  // write artifact
  const today = new Date().toISOString().slice(0, 10)
  const out = {
    generatedAt: new Date().toISOString(),
    totals: { scoredArticles: logs.length, gscJoinable: gsc.size },
    byType,
    pointLoss,
    editUplift: upStats,
    scoreVsPosition: { joinedPages: joined.length, pooledRho: round(rho, 3), ageControlledRho: round(ageControlledRho, 3), cohortRhos },
    airports: airportRows,
    armComparison: armSummary,
  }
  const outPath = path.join(REPORTS_DIR, `log-analysis-${today}.json`)
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2))
  console.log(`\n📄 Saved: ${outPath}\n`)
}

main()
