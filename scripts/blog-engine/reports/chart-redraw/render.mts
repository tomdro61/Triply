// Chart redraw, steps 3–4 (no writes, no network): draw each airport's new charts from data/chart-prices.json and
// decide, for every post block that shows an in-scope image, what is proposed:
//   swap — the text around the chart quotes no off-site lot price, names no lot we don't sell and gives no lot count
//   hold — anything else, for Tom (see Flag and Decision.blockers)
// The text check does NOT try to decide whether a quoted price is still right: prices written into prose drift every
// month and the review showed price matching misses too much. Any off-site price near the chart holds the post.
// At most one daily chart and one 7-day table per post (a second chart of one kind takes the other kind if it is free).
// Writes reports/chart-redraw/out/charts/<code>-<kind>.{png,svg} and out/plan.json.
//   npx tsx reports/chart-redraw/render.mts
import fs from 'fs'
import { chartAlt, chartFileName, chartInputFor, chartSvg, fmtStay, loadPriceSnapshot, lotKeys, OFF_SITE_WORDS, svgToPng, type ChartInput, type ChartKind } from '../../src/rate-chart.js'
import type { Item } from './classify.mts'

const OUT = 'reports/chart-redraw/out'
const snap = loadPriceSnapshot()
if (!snap) throw new Error('data/chart-prices.json is missing — run prices.mts first')
const inv: { airports: string[]; items: Item[] } = JSON.parse(fs.readFileSync(`${OUT}/inventory.json`, 'utf-8'))

/**
 * What the text around a chart says:
 *   prices  — quotes a price next to an off-site lot, "off-site", "Triply" or a hotel word (any $ figure within ~150
 *             characters in the same block): a dated chart next to it reads as a second price
 *   unsold  — names a lot the airport's data file marks not sellable, and today's search doesn't return it
 *   count   — says how many lots Triply sells here, and today's search lists a different number
 *   missing — names a lot marked sellable that today's search didn't return (sold out for the stay, or gone) — info only
 */
export type Flag = 'prices' | 'unsold' | 'count' | 'missing'
/** Flags that hold a swap for Tom (the approved plan holds text-vs-chart mismatches). A lot sold out for the stay doesn't. */
export const HOLDING_FLAGS: readonly Flag[] = ['prices', 'unsold', 'count']
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
  /** For a 'mixed' image: its own caption names a lot Triply doesn't sell (the case for removing it). */
  captionUnsold: string[]
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
    .filter((l) => !l.name.toUpperCase().startsWith(`${code} `)) // "YYC Economy Lot" is the airport's own parking
}
const airportWords = (code: string) => `${airportFile(code).fullName ?? ''} ${code}`.split(/[^A-Za-z]+/).filter(Boolean)

/** Lots a piece of text names that Triply doesn't sell (unsold) or sells but the search didn't return (missing). */
function namedLots(code: string, text: string): { unsold: string[]; missing: string[] } {
  const ctx = ` ${norm(text)} `
  const live = (snap!.airports[code]?.lots ?? []).map((l) => norm(l.name))
  const inLive = (k: string) => live.some((s) => s === k || s.includes(k) || k.includes(s))
  const files = fileLots(code), words = airportWords(code)
  const unsold: string[] = [], missing: string[] = []
  const seen = new Set<string>()
  for (const key of lotKeys(files.map((l) => l.name), words)) {
    const k = norm(key)
    if (seen.has(k) || !ctx.includes(` ${k} `)) continue
    seen.add(k)
    // A two-word key shared by a lot we sell today ("parking spot") is fine.
    const owners = files.filter((l) => lotKeys([l.name], words).some((x) => norm(x) === k))
    if (owners.some((l) => inLive(norm(l.name))) || inLive(k)) continue
    const short = owners[0].name.replace(/\s*\([A-Z]{3}\)/, '')
    ;(owners.some((l) => l.sellable) ? missing : unsold).push(short)
  }
  return { unsold, missing }
}

const MONEY = /(?:C\$|\$)\s?\d[\d,]*(?:\.\d{1,2})?/g
const OFF_MARK = new RegExp(`${OFF_SITE_WORDS.source}|triply|bookable|hotel|\\binn\\b|suites|shuttle lot`, 'gi')
const COUNT = /\b(?:sells?|lists?|offers?|has|have)\s+(?:only\s+)?(one|two|three|four|five|six|seven|eight|nine|ten|\d{1,2})\s+(?:(?:verified|off-site|off-airport|hotel|partner|bookable|nearby)\s+)*(?:parking\s+)?lots\b|\b(?:all|the|these)\s+(one|two|three|four|five|six|seven|eight|nine|ten|\d{1,2})\s+(?:(?:verified|off-site|off-airport|hotel|partner|bookable)\s+)*(?:parking\s+)?lots\b/gi
const NUMBERS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 }

function textCheck(code: string, context: string): { flags: Flag[]; notes: string[] } {
  const flags = new Set<Flag>(), notes: string[] = []
  const { unsold, missing } = namedLots(code, context)
  if (unsold.length) { flags.add('unsold'); notes.push(`names ${unsold.map((s) => `"${s}"`).join(', ')}, which Triply doesn't sell`) }
  if (missing.length) { flags.add('missing'); notes.push(`names ${missing.map((s) => `"${s}"`).join(', ')}: marked sellable, but not in the ${fmtStay(snap!.checkin, snap!.checkout)} search`) }

  // Any money figure near an off-site marker or a lot name, in the same block (blocks are joined by " || ").
  const lotNames = [...fileLots(code).map((l) => l.name), ...(snap!.airports[code]?.lots ?? []).map((l) => l.name)]
    .map((n) => n.toLowerCase().replace(/\s*\([a-z]{3}\)/, '').trim()).filter((n) => n.length >= 6)
  const keys = lotKeys(lotNames, airportWords(code))
  const quoted: string[] = []
  for (const block of context.split(' || ')) {
    const lower = block.toLowerCase()
    const marks = [...lower.matchAll(OFF_MARK)].map((m) => m.index!)
    for (const k of keys) for (let i = lower.indexOf(k); i >= 0; i = lower.indexOf(k, i + 1)) marks.push(i)
    if (!marks.length) continue
    for (const m of block.matchAll(MONEY)) if (marks.some((i) => Math.abs(i - m.index!) <= 150) && !quoted.includes(m[0])) quoted.push(m[0])
  }
  if (quoted.length) { flags.add('prices'); notes.push(`quotes off-site prices: ${quoted.slice(0, 5).join(', ')}${quoted.length > 5 ? ` (+${quoted.length - 5})` : ''}`) }

  // "Triply sells three lots here" in the same sentence as the count.
  const listed = snap!.airports[code]?.listed ?? (snap!.airports[code]?.lots ?? []).length
  for (const sentence of context.split(/(?<=[.!?])\s+| \|\| /)) {
    if (!/triply/i.test(sentence)) continue
    const m = [...sentence.matchAll(COUNT)][0]
    if (!m) continue
    const word = (m[1] ?? m[2]).toLowerCase()
    const n = NUMBERS[word] ?? Number(word)
    if (n !== listed) { flags.add('count'); notes.push(`says "${m[0].trim()}"; today's search lists ${listed}`); break }
  }
  return { flags: [...flags], notes }
}

// ── Another airport, or a special topic? ──
/**
 * Slug phrases that point at a NEIGHBOURING airport (Love Field posts are filed under DFW). Hand-kept: a generic
 * name-word match flags "southwest" (the airline), "hilton", "green lot" and LAX's "Tom Bradley" terminal.
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
const otherAirport = (code: string, slug: string) => (NEIGHBOURS[code] ?? []).find((p) => `-${slug.toLowerCase()}-`.includes(`-${p}-`))
/** A post about something other than parking prices, where a one-off image would carry topic content a rate chart lacks. */
const TOPIC_SLUG = /(?:^|-)(?:taxi|uber|lyft|rideshare|oversized|over-height|rv|ev|charging|electric|lost|ticket|receipt|hourly|free|veteran|veterans|disabled|ada|handicap|motorcycle|cell-phone|pickup|pick-up|drop-off|rental|bus|train|transit|map|terminal-guide|tsa|lounge|wait|arrival|how-early|rewards|points|loyalty)(?:-|$)/

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
    const topic = item.cls === 'one-off' ? use.slug.match(TOPIC_SLUG)?.[0].replace(/^-|-$/g, '') : undefined
    if (item.cls === 'mixed') { blockers.push(`not a rate chart (${item.why.replace(/^prices off-site lots /, 'prices lots ')}): remove the image, or keep it`); kind = null }
    else if (topic) { blockers.push(`not a rate chart: a one-off image in a post about "${topic}" — remove the image, or keep it`); kind = null }
    else if (!d) { blockers.push(`no chart for ${item.code}: ${noChart[item.code]}`); kind = null }
    else if (taken.has(item.kind)) {
      const other: ChartKind = item.kind === 'daily' ? 'week' : 'daily'
      if (taken.has(other)) { blockers.push('third price chart in this post'); kind = null } else kind = other
    }
    if (kind) taken.add(kind)
    if (use.airport && item.code !== use.airport.toUpperCase()) blockers.push(`chart is ${item.code}, post is filed under ${use.airport}`)
    const elsewhere = otherAirport(item.code, use.slug)
    if (elsewhere) blockers.push(`post may be about another airport (slug says "${elsewhere}"), not ${item.code}`)
    const { flags, notes } = textCheck(item.code, use.context ?? '')
    const captionUnsold = kind === null ? namedLots(item.code, item.alt).unsold : []
    const holds = flags.some((f) => HOLDING_FLAGS.includes(f))
    decisions.push({ post_id: use.post_id, slug: use.slug, block: use.block, media_id: item.media_id, code: item.code, cls: item.cls, oldAlt: item.alt, oldKind: item.kind, kind, action: blockers.length || holds ? 'hold' : 'swap', blockers, flags, notes, captionUnsold, context: use.context ?? '' })
  }
}
// The text belongs to the post, not to one chart: a mismatch near one chart holds every chart in that post.
for (const [postId] of byPost) {
  const mine = decisions.filter((x) => x.post_id === postId)
  const textHold = mine.find((x) => x.flags.some((f) => HOLDING_FLAGS.includes(f)))
  if (!textHold) continue
  for (const x of mine) if (x.action === 'swap') { x.action = 'hold'; x.notes.push(`held with the rest of the post: ${textHold.notes[0]}`) }
}

fs.writeFileSync(`${OUT}/plan.json`, JSON.stringify({ asOf: snap.asOf, checkin: snap.checkin, checkout: snap.checkout, charts, noChart, decisions }, null, 1))
const tally = (f: (x: Decision) => boolean) => `${String(decisions.filter(f).length).padStart(4)} blocks / ${String(new Set(decisions.filter(f).map((x) => x.post_id)).size).padStart(4)} posts`
console.log(`charts: ${charts.length} (${charts.filter((c) => c.fallback).length} airport-only fallback) for ${inputs.size} airports; no chart: ${Object.keys(noChart).join(' ') || 'none'}`)
console.log(`blocks: ${decisions.length} in ${byPost.size} posts`)
console.log(`  proposed swap   ${tally((x) => x.action === 'swap')}`)
console.log(`  proposed hold   ${tally((x) => x.action === 'hold')}`)
for (const f of ['prices', 'unsold', 'count', 'missing'] as const) console.log(`  flag ${f.padEnd(10)} ${tally((x) => x.flags.includes(f))}`)
console.log(`  blocked         ${tally((x) => x.blockers.length > 0)}`)
