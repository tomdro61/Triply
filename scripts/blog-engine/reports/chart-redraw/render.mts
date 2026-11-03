// Chart redraw, steps 3–4 (no writes, no network): draw each airport's new charts from data/chart-prices.json and
// decide, for every post block that shows an in-scope image, what is proposed:
//   swap — the text around the chart agrees with the new chart (a lot sold out for the priced stay is not a mismatch)
//   hold — anything else, for Tom: the text contradicts the new chart (see Flag), the image isn't a rate chart
//          (classify.mts 'mixed'), the post is about another airport, a third price chart in one post, or no chart
// At most one daily chart and one 7-day table per post (a second chart of one kind takes the other kind if it is free).
// Writes reports/chart-redraw/out/charts/<code>-<kind>.{png,svg} and out/plan.json.
//   npx tsx reports/chart-redraw/render.mts
import fs from 'fs'
import { chartAlt, chartFileName, chartInputFor, chartSvg, fmtStay, loadPriceSnapshot, lotKeys, svgToPng, type ChartInput, type ChartKind } from '../../src/rate-chart.js'
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
 *   price   — quotes an off-site price (per day, a range, a "from"/"start at" price, a 7-day total) no lot we sell has today
 *   count   — says how many lots Triply sells here, and today's search has a different number
 */
export type Flag = 'unsold' | 'missing' | 'pre-fee' | 'price' | 'count'
/** Flags that hold a swap for Tom (the approved plan holds text-vs-chart mismatches). A sold-out lot doesn't. */
export const HOLDING_FLAGS: readonly Flag[] = ['unsold', 'price', 'pre-fee', 'count']
export interface Chart { code: string; kind: ChartKind; file: string; mediaName: string; alt: string; fallback: boolean }
export interface Decision {
  post_id: number; slug: string; block: number; media_id: number; code: string; cls: Item['cls']; oldAlt: string; oldKind: ChartKind
  /** The chart that replaces it; null = nothing to swap in (see blockers). */
  kind: ChartKind | null
  action: 'swap' | 'hold'
  /** Why a swap can't happen as is (no chart, not a rate chart, another airport, a third chart in one post). */
  blockers: string[]
  flags: Flag[]
  notes: string[]
  context: string
}

// ── Draw ──
fs.mkdirSync(`${OUT}/charts`, { recursive: true })
// Clear the previous run's charts (only this script's own <CODE>-<kind> files), so an airport held this run has none.
for (const f of fs.readdirSync(`${OUT}/charts`)) if (/^[A-Z]{3}-(?:daily|week)\.(?:png|svg)$/.test(f)) fs.rmSync(`${OUT}/charts/${f}`)
const inputs = new Map<string, ChartInput>()
const charts: Chart[] = []
const noChart: Record<string, string> = {}
for (const code of inv.airports) {
  const d = chartInputFor(code, snap)
  if (!d) {
    const row = snap.airports[code]
    noChart[code] = !row ? 'not searched' : row.status === 'error' ? `${row.reason}` : 'Triply sells nothing here and there are no on-airport rates to show'
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
const airportFile = (code: string) => {
  const f = `data/airports/${code}.json`
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf-8')) as { fullName?: string; parkingLots?: { name?: string; triplyListingName?: string; sellable?: boolean }[] } : {}
}
function fileLots(code: string): FileLot[] {
  return (airportFile(code).parkingLots ?? []).flatMap((l) => [l.name, l.triplyListingName].filter((n): n is string => typeof n === 'string' && norm(n).length >= 6).map((name) => ({ name, sellable: l.sellable === true })))
}
const airportWords = (code: string) => `${airportFile(code).fullName ?? ''} ${code}`.split(/[^A-Za-z]+/).filter(Boolean)

const MONEY = String.raw`(C?\$)\s?(\d{1,4}(?:\.\d{1,2})?)`
const PER_DAY = new RegExp(String.raw`${MONEY}\s*(?:\/\s*day|per day|a day|daily)`, 'gi')
const RANGE_LOW = new RegExp(String.raw`${MONEY}\s*(?:–|-|to)\s*(?:C?\$)?\s?\d{1,4}(?:\.\d{1,2})?\s*(?:\/\s*day|per day|a day)`, 'gi')
const WEEK_TOTAL = new RegExp(String.raw`${MONEY}\s*(?:for (?:a |the |your )?(?:7|seven)[- ](?:days?|nights?)|(?:a|per) week|weekly|for a week|total for (?:7|seven) (?:days|nights))`, 'gi')
const FROM_BEFORE = /(?:start(?:s|ing)? (?:at|from)|from|as low as|cheapest(?: is| at)?|lowest(?: is| at)?|under)\s*(?:about|just|only|around|roughly|~)?\s*$/i
const COUNT = /\b(?:sells?|lists?|offers?|has|have|with|all|the|these)\s+(two|three|four|five|six|seven|eight|nine|ten|\d{1,2})\s+(?:(?:verified|off-site|off-airport|hotel|partner|bookable|nearby)\s+)*(?:lots|options|hotels|parking lots|hotel lots)\b/gi
const NUMBERS: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 }
// A figure is off-site when the nearest place word before it is an off-site one (a lot name, "off-site", "Triply", a
// hotel word…) rather than on-airport parking ("garage", "economy", "Terminal B"…).
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
/** "C$16/day Economy Lot rate": an on-airport word right after the figure names it — but "…less than the Terminal D Garage" compares, it doesn't name. */
function namedOnAirportAfter(text: string, end: number): boolean {
  const after = text.slice(end, end + 30).split(/[.;|]/)[0]
  const m = new RegExp(ON_MARK.source, 'i').exec(after)
  return !!m && m.index <= 15 && !/than|vs\.?|versus|compared|against|below|cheaper|less|more/i.test(after.slice(0, m.index))
}
const close = (a: number, b: number) => Math.abs(a - b) <= Math.max(0.75, 0.08 * b)
const list = (xs: string[]) => `${xs.slice(0, 4).join(', ')}${xs.length > 4 ? ` (+${xs.length - 4})` : ''}`

function textCheck(code: string, context: string, d: ChartInput): { flags: Flag[]; notes: string[] } {
  const flags = new Set<Flag>(), notes: string[] = []
  const ctx = ` ${norm(context)} `
  const lower = context.toLowerCase()
  const live = snap!.airports[code]?.lots ?? []
  const liveKeys = live.map((l) => norm(l.name))
  const inLive = (k: string) => liveKeys.some((s) => s === k || s.includes(k) || k.includes(s))
  const files = fileLots(code).filter((l) => !l.name.toUpperCase().startsWith(`${code} `)) // "YYC Economy Lot" is the airport's own
  const words = airportWords(code)

  // Lot names: the full name, or its first two words ("Red Roof", "Clarion Inn"). A key shared by a lot we sell today is fine.
  const seen = new Set<string>()
  for (const key of lotKeys(files.map((l) => l.name), words)) {
    const k = norm(key)
    if (seen.has(k) || !ctx.includes(` ${k} `)) continue
    seen.add(k)
    const owners = files.filter((l) => lotKeys([l.name], words).some((x) => norm(x) === k))
    if (owners.some((l) => inLive(norm(l.name))) || inLive(k)) continue
    const short = owners[0].name.replace(/\s*\([A-Z]{3}\)/, '')
    if (owners.some((l) => l.sellable)) { flags.add('missing'); notes.push(`names "${short}": marked sellable, but not in the ${fmtStay(snap!.checkin, snap!.checkout)} search`) }
    else { flags.add('unsold'); notes.push(`names "${short}", which Triply doesn't sell`) }
  }

  const lotNames = [...files.map((l) => l.name), ...live.map((l) => l.name)].map((n) => n.toLowerCase().replace(/\s*\([a-z]{3}\)/, '').trim()).filter((n) => n.length >= 6)
  const offSite = (at: number, end: number) => distBack(context, at, OFF_MARK, lotNames) < distBack(context, at, ON_MARK) && !namedOnAirportAfter(context, end)
  const lead = [...live.filter((l) => l.mayLead)].sort((a, b) => a.stayTotal - b.stayTotal)
  const cheapest = lead.length ? Math.min(...lead.map((l) => l.perDay)) : null
  const prefee: string[] = [], other: string[] = []
  const add = (arr: string[], fig: string) => { if (!arr.includes(fig)) arr.push(fig) }
  const perDayFigures = [...context.matchAll(PER_DAY)].map((m) => ({ m, v: Number(m[2]), at: m.index!, end: m.index! + m[0].length }))
    .concat([...context.matchAll(RANGE_LOW)].map((m) => ({ m, v: Number(m[2]), at: m.index!, end: m.index! + m[0].length })))
  for (const { m, v, at, end } of perDayFigures) {
    if (!offSite(at, end)) continue
    const fig = `${m[1]}${m[2]}/day`
    // "start at $X", "from $X", "as low as $X": must be today's cheapest lot, not just any lot.
    if (FROM_BEFORE.test(context.slice(Math.max(0, at - 40), at)) && cheapest !== null) {
      const cheapestBase = Math.min(...lead.map((l) => l.baseRate ?? Infinity))
      if (close(v, cheapest)) continue
      if (Number.isFinite(cheapestBase) && close(v, cheapestBase)) add(prefee, fig)
      else add(other, `"from" ${fig} (cheapest today ${m[1]}${cheapest.toFixed(2)})`)
      continue
    }
    if (live.some((l) => close(v, l.perDay))) continue
    if (live.some((l) => l.baseRate !== undefined && close(v, l.baseRate))) add(prefee, fig)
    else add(other, fig)
  }
  const onWeek = d.onAirport.flatMap((r) => (r.week !== undefined ? [r.week] : [r.lo * 7, r.hi * 7]))
  for (const m of context.matchAll(WEEK_TOTAL)) {
    const at = m.index!, v = Number(m[2])
    if (!offSite(at, at + m[0].length)) continue
    if (live.some((l) => close(v, l.stayTotal)) || onWeek.some((w) => close(v, w))) continue
    if (live.some((l) => l.baseRate !== undefined && close(v, l.baseRate * l.billedDays))) add(prefee, `${m[1]}${m[2]} for 7 days`)
    else add(other, `${m[1]}${m[2]} for 7 days`)
  }
  if (prefee.length) { flags.add('pre-fee'); notes.push(`quotes ${list(prefee)}: a lot's rate before taxes and fees (the chart shows the total)`) }
  if (other.length) { flags.add('price'); notes.push(`quotes ${list(other)} for off-site parking: no lot we sell has that price today`) }

  if (/triply/i.test(lower)) {
    for (const m of context.matchAll(COUNT)) {
      const n = NUMBERS[m[1].toLowerCase()] ?? Number(m[1])
      if (n !== live.length) { flags.add('count'); notes.push(`says "${m[0].trim()}", today's search has ${live.length}`); break }
    }
  }
  return { flags: [...flags], notes }
}

// ── Another airport? ──
/**
 * Slug phrases that point at a NEIGHBOURING airport — the case the review found: Love Field posts filed under DFW.
 * Hand-kept on purpose: a generic name-word match flags "southwest" (the airline), "hilton", "green lot" and the LAX
 * "Tom Bradley" terminal. A post about both airports (comparisons) is held too.
 */
const NEIGHBOURS: Record<string, string[]> = {
  DFW: ['love-field', 'dal'], ORD: ['midway', 'mdw'], IAH: ['hobby', 'hou'], HOU: ['bush-intercontinental', 'iah'],
  JFK: ['laguardia', 'lga', 'newark', 'ewr'], LGA: ['jfk', 'kennedy', 'newark', 'ewr'], EWR: ['jfk', 'kennedy', 'laguardia', 'lga'],
  DCA: ['dulles', 'iad', 'bwi'], IAD: ['reagan', 'dca', 'bwi'], BWI: ['dulles', 'iad', 'reagan', 'dca'],
  FLL: ['miami-international', 'mia'], MIA: ['fort-lauderdale', 'fll'], SFO: ['oakland', 'oak', 'san-jose', 'sjc'],
  OAK: ['sfo', 'san-francisco-international'], SJC: ['sfo', 'san-francisco-international'],
  LAX: ['burbank', 'bur', 'long-beach', 'lgb', 'ontario', 'john-wayne', 'sna'], MCO: ['sanford', 'sfb'], TPA: ['st-pete', 'pie', 'sarasota'],
  YYZ: ['billy-bishop', 'ytz', 'buffalo', 'buf'], BUF: ['pearson', 'yyz', 'toronto'], DTW: ['windsor'], CVG: ['dayton', 'louisville', 'sdf'], SDF: ['cincinnati', 'cvg'],
}
function otherAirport(code: string, slug: string): string {
  const s = `-${slug.toLowerCase()}-`
  const hit = (NEIGHBOURS[code] ?? []).find((p) => s.includes(`-${p}-`))
  return hit ? `slug says "${hit}"` : ''
}

// ── Decide per post ──
const byPost = new Map<number, { item: Item; use: Item['uses'][number] }[]>()
for (const item of inv.items) {
  if (item.cls !== 'standard' && item.cls !== 'one-off' && item.cls !== 'mixed') continue
  for (const use of item.uses) byPost.set(use.post_id, [...(byPost.get(use.post_id) ?? []), { item, use }])
}
const decisions: Decision[] = []
for (const [, uses] of byPost) {
  uses.sort((a, b) => a.use.block - b.use.block)
  const taken = new Set<ChartKind>()
  for (const { item, use } of uses) {
    const d = inputs.get(item.code)
    const blockers: string[] = []
    let kind: ChartKind | null = item.kind
    if (item.cls === 'mixed') { blockers.push(`not a rate chart (${item.why.replace(/^prices off-site lots /, 'prices lots ')}): remove the image, or keep it`); kind = null }
    else if (!d) { blockers.push(`no chart for ${item.code}: ${noChart[item.code]}`); kind = null }
    else if (taken.has(item.kind)) {
      const other: ChartKind = item.kind === 'daily' ? 'week' : 'daily'
      if (taken.has(other)) { blockers.push('third price chart in this post'); kind = null } else kind = other
    }
    if (kind) taken.add(kind)
    if (use.airport && item.code !== use.airport.toUpperCase()) blockers.push(`chart is ${item.code}, post is filed under ${use.airport}`)
    const elsewhere = otherAirport(item.code, use.slug)
    if (elsewhere) blockers.push(`post may be about another airport (${elsewhere}), not ${item.code}`)
    const { flags, notes } = d ? textCheck(item.code, use.context ?? '', d) : { flags: [] as Flag[], notes: [] as string[] }
    const holds = flags.some((f) => HOLDING_FLAGS.includes(f))
    decisions.push({ post_id: use.post_id, slug: use.slug, block: use.block, media_id: item.media_id, code: item.code, cls: item.cls, oldAlt: item.alt, oldKind: item.kind, kind, action: blockers.length || holds ? 'hold' : 'swap', blockers, flags, notes, context: use.context ?? '' })
  }
}
// The text belongs to the post, not to one chart: a mismatch near one chart holds every chart in that post.
for (const [postId] of byPost) {
  const mine = decisions.filter((x) => x.post_id === postId)
  const textHold = mine.filter((x) => x.flags.some((f) => HOLDING_FLAGS.includes(f)))
  if (!textHold.length) continue
  for (const x of mine) {
    if (x.action === 'swap') { x.action = 'hold'; x.notes.push(`held with the rest of the post: ${textHold[0].notes[0]}`) }
  }
}

fs.writeFileSync(`${OUT}/plan.json`, JSON.stringify({ asOf: snap.asOf, checkin: snap.checkin, checkout: snap.checkout, charts, noChart, decisions }, null, 1))
const tally = (f: (x: Decision) => boolean) => `${String(decisions.filter(f).length).padStart(4)} blocks / ${String(new Set(decisions.filter(f).map((x) => x.post_id)).size).padStart(4)} posts`
console.log(`charts: ${charts.length} (${charts.filter((c) => c.fallback).length} airport-only fallback) for ${inputs.size} airports; no chart: ${Object.entries(noChart).map(([c, r]) => `${c} (${r.slice(0, 40)})`).join(', ') || 'none'}`)
console.log(`blocks: ${decisions.length} in ${byPost.size} posts`)
console.log(`  proposed swap   ${tally((x) => x.action === 'swap')}`)
console.log(`  proposed hold   ${tally((x) => x.action === 'hold')}`)
for (const f of ['unsold', 'price', 'count', 'pre-fee', 'missing'] as const) console.log(`  flag ${f.padEnd(10)} ${tally((x) => x.flags.includes(f))}`)
console.log(`  blocked         ${tally((x) => x.blockers.length > 0)}`)
const bk = new Map<string, number>()
for (const x of decisions) for (const b of x.blockers) { const k = b.replace(/\(.*\)/, '(…)').replace(/[A-Z]{3}/g, 'XXX'); bk.set(k, (bk.get(k) ?? 0) + 1) }
for (const [k, n] of bk) console.log(`    ${String(n).padStart(4)} · ${k.slice(0, 110)}`)
