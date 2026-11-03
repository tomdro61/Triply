// Chart redraw, steps 3–4 (no writes, no network): draw each airport's new charts from data/chart-prices.json and
// decide, for every post block that shows an October chart, whether it is swapped or held for Tom.
// At most one daily chart and one 7-day table per post (a second chart of one kind takes the other kind if it is free).
// Writes reports/chart-redraw/out/charts/<code>-<kind>.{png,svg} and out/plan.json.
//   npx tsx reports/chart-redraw/render.mts
import fs from 'fs'
import { chartAlt, chartFileName, chartInputFor, chartSvg, fmtStay, loadPriceSnapshot, svgToPng, type ChartInput, type ChartKind } from '../../src/rate-chart.js'
import type { Item } from './classify.mts'

const OUT = 'reports/chart-redraw/out'
const snap = loadPriceSnapshot()
if (!snap) throw new Error('data/chart-prices.json is missing — run prices.mts first')
const inv: { airports: string[]; items: Item[] } = JSON.parse(fs.readFileSync(`${OUT}/inventory.json`, 'utf-8'))

/**
 * What the text around a chart says vs the new chart:
 *   unsold  — names a lot the airport's data file marks not sellable, and today's search doesn't return it
 *   missing — names a lot marked sellable that today's search didn't return (sold out for the stay, or gone)
 *   pre-fee — quotes a lot's per-day rate before taxes and our fee (the chart prints the total)
 *   price   — quotes an off-site per-day price that matches no lot we sell today
 */
export type Flag = 'unsold' | 'missing' | 'pre-fee' | 'price'
export interface Chart { code: string; kind: ChartKind; file: string; mediaName: string; alt: string; fallback: boolean }
export interface Decision {
  post_id: number; slug: string; block: number; media_id: number; code: string; oldAlt: string; oldKind: ChartKind
  /** The chart that replaces it; null = nothing to swap in (see blockers). */
  kind: ChartKind | null
  action: 'swap' | 'hold'
  /** Why the swap can't happen as is (no chart, a third chart in one post, wrong airport). */
  blockers: string[]
  flags: Flag[]
  notes: string[]
  context: string
}

// ── Draw ──
fs.mkdirSync(`${OUT}/charts`, { recursive: true })
const inputs = new Map<string, ChartInput>()
const charts: Chart[] = []
const noChart: Record<string, string> = {}
for (const code of inv.airports) {
  const d = chartInputFor(code, snap)
  if (!d) {
    const row = snap.airports[code]
    noChart[code] = !row ? 'not searched' : row.status === 'error' ? `search unusable: ${row.reason}` : 'Triply sells nothing here and there are no on-airport rates to show'
    continue
  }
  inputs.set(code, d)
  for (const kind of ['daily', 'week'] as const) {
    const svg = chartSvg(d, kind), base = `${OUT}/charts/${code}-${kind}`
    fs.writeFileSync(`${base}.svg`, svg)
    fs.writeFileSync(`${base}.png`, svgToPng(svg))
    charts.push({ code, kind, file: `charts/${code}-${kind}.png`, mediaName: chartFileName(d, kind), alt: chartAlt(d, kind), fallback: d.lots.length === 0 })
  }
}

// ── Text check ──
const norm = (s: string) => s.toLowerCase().replace(/\([a-z]{3}\)/g, ' ').replace(/&/g, ' and ').replace(/[^a-z0-9$.]+/g, ' ').replace(/\bthe\b/g, ' ').replace(/\s+/g, ' ').trim()
interface FileLot { name: string; sellable: boolean }
function fileLots(code: string): FileLot[] {
  const f = `data/airports/${code}.json`
  if (!fs.existsSync(f)) return []
  const lots = (JSON.parse(fs.readFileSync(f, 'utf-8')) as { parkingLots?: { name?: string; triplyListingName?: string; sellable?: boolean }[] }).parkingLots ?? []
  return lots.flatMap((l) => [l.name, l.triplyListingName].filter((n): n is string => typeof n === 'string' && norm(n).length >= 6).map((name) => ({ name, sellable: l.sellable === true })))
}
const PER_DAY = /(C?\$)\s?(\d{1,3}(?:\.\d{1,2})?)\s*(?:\/\s*day|per day|a day|daily)/gi
// A per-day figure is off-site when the nearest place word before it is an off-site one (a lot name, "off-site",
// "Triply", a hotel word…) rather than on-airport parking ("garage", "economy", "Terminal B"…).
const OFF_MARK = /off-site|offsite|off-airport|off airport|triply|hotel|\binn\b|suites|park[- ]?(?:and|&|n|'n)[- ]?fly|independent lots?|private lots?/gi
const ON_MARK = /on-airport|on-site|garage|terminal [a-e0-9]\b|economy|daily park|value park|express park|short-term|long-term|ecopark|cell phone|hourly|reserved parking|prepaid|park[- ]?(?:&|and)?[- ]?ride|\bdeck\b|\bramp\b|\blot [a-z0-9]{1,2}\b|official|airport's own/gi
/** Characters from `at` back to the end of the nearest marker within 140 characters (Infinity if none). */
function distBack(text: string, at: number, re: RegExp, names: string[] = []): number {
  const win = text.slice(Math.max(0, at - 140), at).toLowerCase()
  let best = Infinity
  for (const m of win.matchAll(re)) best = Math.min(best, win.length - (m.index! + m[0].length))
  for (const n of names) { const i = win.lastIndexOf(n); if (i >= 0) best = Math.min(best, win.length - (i + n.length)) }
  return best
}
const close = (a: number, b: number) => Math.abs(a - b) <= Math.max(0.75, 0.08 * b)
const list = (xs: string[]) => `${xs.slice(0, 4).join(', ')}${xs.length > 4 ? ` (+${xs.length - 4})` : ''}`

function textCheck(code: string, context: string): { flags: Flag[]; notes: string[] } {
  const flags = new Set<Flag>(), notes: string[] = []
  const ctx = ` ${norm(context)} `
  const live = snap!.airports[code]?.lots ?? []
  const liveKeys = live.map((l) => norm(l.name))
  const inLive = (k: string) => liveKeys.some((s) => s === k || s.includes(k) || k.includes(s))
  const files = fileLots(code)
  const seen = new Set<string>()
  for (const l of files) {
    const k = norm(l.name)
    // "YYC Economy Lot", "SDF Parking Garage": the airport's own parking, listed in some data files — not a lot we'd sell.
    if (l.name.toUpperCase().startsWith(`${code} `)) continue
    if (seen.has(k) || !ctx.includes(` ${k} `)) continue
    seen.add(k)
    if (inLive(k)) continue
    const short = l.name.replace(/\s*\([A-Z]{3}\)/, '')
    if (l.sellable) { flags.add('missing'); notes.push(`names "${short}" — marked sellable, but not in the ${fmtStay(snap!.checkin, snap!.checkout)} search`) }
    else { flags.add('unsold'); notes.push(`names "${short}", which Triply doesn't sell`) }
  }
  const lotNames = [...files.map((l) => l.name), ...live.map((l) => l.name)].map((n) => n.toLowerCase().replace(/\s*\([a-z]{3}\)/, '').trim()).filter((n) => n.length >= 6)
  const prefee: string[] = [], other: string[] = []
  for (const m of context.matchAll(PER_DAY)) {
    const at = m.index!, v = Number(m[2])
    if (!(distBack(context, at, OFF_MARK, lotNames) < distBack(context, at, ON_MARK))) continue // on-airport or unplaced figure
    // "…C$16/day Economy Lot rate", "$15/day to $37/day for on-airport options": an on-airport word right after the figure wins.
    const after = context.slice(at + m[0].length, at + m[0].length + 45).split(/[.;|]/)[0]
    if (new RegExp(ON_MARK.source, 'i').test(after)) continue
    const fig = `${m[1]}${m[2]}/day`
    if (live.some((l) => close(v, l.perDay))) continue
    if (live.some((l) => l.baseRate !== undefined && close(v, l.baseRate))) { if (!prefee.includes(fig)) prefee.push(fig) }
    else if (!other.includes(fig)) other.push(fig)
  }
  if (prefee.length) { flags.add('pre-fee'); notes.push(`quotes ${list(prefee)}: a lot's rate before taxes and fees`) }
  if (other.length) { flags.add('price'); notes.push(`quotes ${list(other)} for off-site parking: no lot we sell today has that price`) }
  return { flags: [...flags], notes }
}

// ── Decide per post ──
const byPost = new Map<number, { item: Item; use: Item['uses'][number] }[]>()
for (const item of inv.items) {
  if (item.cls !== 'standard' && item.cls !== 'one-off') continue
  for (const use of item.uses) byPost.set(use.post_id, [...(byPost.get(use.post_id) ?? []), { item, use }])
}
const decisions: Decision[] = []
for (const [, list] of byPost) {
  list.sort((a, b) => a.use.block - b.use.block)
  const taken = new Set<ChartKind>()
  for (const { item, use } of list) {
    const d = inputs.get(item.code)
    const blockers: string[] = []
    let kind: ChartKind | null = item.kind
    if (!d) { blockers.push(`no chart for ${item.code}: ${noChart[item.code]}`); kind = null }
    else if (taken.has(item.kind)) {
      const other: ChartKind = item.kind === 'daily' ? 'week' : 'daily'
      if (taken.has(other)) { blockers.push('third price chart in this post'); kind = null } else kind = other
    }
    if (kind) taken.add(kind)
    if (use.airport && item.code !== use.airport.toUpperCase()) blockers.push(`chart is ${item.code}, post is filed under ${use.airport}`)
    const { flags, notes } = d ? textCheck(item.code, use.context ?? '') : { flags: [], notes: [] }
    // Proposed default (Tom decides on the contact sheet): text that names a lot we don't sell, or quotes a price no lot
    // of ours has, holds the swap; a pre-fee rate or a lot sold out for the priced stay doesn't.
    const holds = flags.some((f) => f === 'unsold' || f === 'price')
    decisions.push({ post_id: use.post_id, slug: use.slug, block: use.block, media_id: item.media_id, code: item.code, oldAlt: item.alt, oldKind: item.kind, kind, action: blockers.length || holds ? 'hold' : 'swap', blockers, flags, notes, context: use.context ?? '' })
  }
}

fs.writeFileSync(`${OUT}/plan.json`, JSON.stringify({ asOf: snap.asOf, checkin: snap.checkin, checkout: snap.checkout, charts, noChart, decisions }, null, 1))
const tally = (f: (x: Decision) => boolean) => `${String(decisions.filter(f).length).padStart(4)} blocks / ${String(new Set(decisions.filter(f).map((x) => x.post_id)).size).padStart(4)} posts`
console.log(`charts: ${charts.length} (${charts.filter((c) => c.fallback).length} airport-only fallback) for ${inputs.size} airports; no chart: ${Object.keys(noChart).join(' ') || 'none'}`)
console.log(`blocks: ${decisions.length} in ${byPost.size} posts`)
console.log(`  proposed swap   ${tally((x) => x.action === 'swap')}`)
console.log(`  proposed hold   ${tally((x) => x.action === 'hold')}`)
console.log(`  clean text      ${tally((x) => !x.flags.length && !x.blockers.length)}`)
for (const f of ['pre-fee', 'missing', 'price', 'unsold'] as const) console.log(`  flag ${f.padEnd(10)} ${tally((x) => x.flags.includes(f))}`)
console.log(`  blocked         ${tally((x) => x.blockers.length > 0)}`)
for (const b of new Set(decisions.flatMap((x) => x.blockers.map((r) => r.replace(/for [A-Z]{3}:.*/, 'for …').replace(/is [A-Z]{3}, post is filed under \S+/, 'is X, post is filed under Y'))))) console.log(`    · ${b}`)
