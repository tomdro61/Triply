/**
 * rate-chart.ts — the one place a blog chart draws parking prices (chart redraw, Nov 2026).
 *
 * The October 2026 charts printed lots Triply does not sell as "bookable on Triply", at mid-October
 * pre-fee rates, with no date (notes/2026-11-02-chart-redraw-plan.md). Every price chart now comes from
 * here, and from one input only: a dated snapshot of a live triplypro.com search (data/chart-prices.json,
 * written by reports/chart-redraw/prices.mts). So a chart:
 *   - shows only lots the search returned that day (the lots a customer can book);
 *   - prints the customer price — the search card's total incl. taxes, fees and our service fee — never
 *     ResLab's pre-fee `minPrice`;
 *   - says when the prices were read and which stay they are for;
 *   - never puts a paid-transfer lot first, and never claims a shuttle for a lot without one.
 * On-airport bars come from ON_AIRPORT_RATES below (posted rates, with the month they were checked).
 * An airport where Triply sells nothing gets the airport-only fallback chart: no Triply legend, no
 * "bookable" caption. Pure functions except svgToPng and loadPriceSnapshot.
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { Resvg } from '@resvg/resvg-js'

export type ChartCurrency = 'USD' | 'CAD'
/** shuttle = the lot lists a shuttle and no fee for it; valet = a driver takes you (or your car) to the terminal;
 *  paid = a transfer fee on top; none = no shuttle; unknown = no data. */
export type Transfer = 'shuttle' | 'valet' | 'paid' | 'none' | 'unknown'

export interface ChartLot {
  name: string
  /** Customer price for the priced stay ÷ its billed days — the "$X/day" line on the search card. */
  perDay: number
  /** Customer price for the whole priced stay — the search card's headline total. */
  stayTotal: number
  billedDays: number
  transfer: Transfer
  /** False for a paid transfer or a lot whose notes bar it from leading (suspended shuttle, "do not use in CTAs"): never first, never the "from" price. */
  mayLead: boolean
  /** ResLab's pre-tax daily rate without our fee (`minPrice`). Only for checking post text that quotes it — never printed on a chart. */
  baseRate?: number
}

export interface AirportPrices {
  status: 'ok' | 'none' | 'error'
  currency?: ChartCurrency
  lots?: ChartLot[]
  /** Why the airport has no chart data ('error'), for the run summary. */
  reason?: string
}

export interface PriceSnapshot {
  /** Date the search was run (YYYY-MM-DD). */
  asOf: string
  /** The stay priced: check-in and check-out dates, both at 10:00 AM airport time (exactly 7 × 24 h). */
  checkin: string
  checkout: string
  airports: Record<string, AirportPrices>
}

export interface OnAirportRate { name: string; lo: number; hi: number; week?: number }

export interface ChartInput {
  code: string
  currency: ChartCurrency
  asOf: string
  checkin: string
  checkout: string
  /** Ordered for display (orderLots); empty → fallback chart. */
  lots: ChartLot[]
  onAirport: OnAirportRate[]
  /** e.g. "October 2026"; null when there are no on-airport rows. */
  onAirportChecked: string | null
}

export type ChartKind = 'daily' | 'week'

// ── On-airport posted rates ──────────────────────────────────────────────────────────────────────

/** Month the ON_AIRPORT_RATES rows were checked against the airports' own sites; printed on every chart that uses them. */
export const ON_AIRPORT_CHECKED = 'October 2026'

/**
 * Posted on-airport daily rates [name, lo, hi, posted 7-day price?], checked 7–14 Oct 2026 (moved unchanged from
 * reports/lot-rewrite/make-infographics.mts). An airport not listed gets no airport bars.
 */
export const ON_AIRPORT_RATES: Record<string, [string, number, number, number?][]> = {
  ATL: [['Domestic Park-Ride', 15, 15], ['ATL Select', 15, 20], ['Economy Lots', 20, 20], ['Daily Decks', 30, 30], ['International Park-Ride', 30, 30]],
  LAX: [['Budget Parking', 20, 20], ['Economy Parking', 35, 35], ['CTA Terminal Garages', 60, 60], ['CTA Premium', 70, 70], ['CTA Valet', 75, 75]],
  PHL: [['Economy Lot', 18, 18], ['Garages (upper levels)', 32, 32], ['Short-Term (ground level)', 54, 54]],
  FLL: [['Overflow (peak only)', 10, 10], ['Long-Term Garages', 20, 20], ['Valet', 30, 30], ['Short-Term Garages', 36, 36]],
  MCO: [['Economy: Park Place & West Park', 14, 14], ['Garages A, B, C & Terminal Top', 24, 24], ['Valet', 35, 35]],
  MSP: [['Quick Ride Ramp', 19, 19], ['Value Parking (Terminal 2)', 23, 23], ['Terminal 1 Daily Ramps', 30, 30], ['Valet (Terminal 1)', 55, 55]],
  SEA: [['General Parking (garage)', 37, 37, 222], ['Reserved Parking (Floor 4)', 47, 47]],
  CLT: [['Long Term Lots 1 & 2', 14, 14], ['Daily North Lot', 18, 18], ['Express Decks', 24, 24], ['Daily Decks', 28, 28], ['Hourly Deck', 35, 35]],
  IAD: [['Economy Lot', 20, 20], ['Garages 1 & 2', 25, 25], ['Valet (Service Center)', 39, 39], ['Terminal Lot', 40, 40]],
  IAH: [['ecopark (uncovered)', 10, 10], ['ecopark covered / ecopark2', 12, 12], ['Terminal garages', 25, 25], ['Valet', 30, 30]],
  AUS: [['Economy Lots', 14, 14], ['Blue Garage', 26, 26], ['Red Garage', 35, 35]],
  DCA: [['Economy Lot', 25, 25], ['Parking 1 & 2 garages', 35, 35]],
  LAS: [['Economy / Remote Lot', 14, 14], ['Long Term garage', 20, 20], ['Valet', 34, 34], ['Short Term garage', 38, 38]],
  TPA: [['Economy Garage', 22, 22], ['Long Term Garage', 26, 26], ['Short Term Garage', 32, 32]],
  DFW: [['Remote (TollTag)', 14, 14], ['Express uncovered', 20, 20], ['Express covered', 23, 23], ['Terminal garages', 37, 37], ['Valet', 55, 55]],
  SFO: [['Long-Term Garage', 27, 27], ['International Garage', 37, 37], ['Domestic Garage', 41, 41], ['ParkFAST', 60, 60]],
  BNA: [['Economy', 24, 24], ['Garages', 36, 36], ['Valet', 48, 48]],
  BOS: [['Advance reservation', 29, 29], ['Economy (walk-up)', 37, 37], ['Terminal garages', 46, 46]],
  BWI: [['Long Term', 11, 11], ['Express', 14, 14], ['Daily Garage', 16, 16], ['Hourly Garage', 30, 30]],
  DEN: [['Pikes Peak', 10, 10], ['Economy', 20, 20], ['Garages', 35, 35]],
  JFK: [['Long-term lot (prebook from)', 35, 35], ['Long-term lot (drive-up)', 45, 45], ['Red Lot (T8)', 70, 70], ['Yellow Lot (T5)', 75, 75], ['Blue Lot (T4)', 82, 82]],
  LGA: [['Prepaid Economy (from)', 40, 40], ['Terminal A (prebook from)', 50, 50], ['Terminal B', 80, 80], ['Terminal C', 89, 89]],
  MIA: [['Economy Park & Ride', 12, 12], ['Terminal garages', 25, 25], ['Valet', 39, 39]],
  SAN: [['Terminal 1/2 Parking Plazas', 40, 40], ['Valet', 60, 60]],
  PHX: [['Park & Walk (seasonal)', 10, 10], ['East Economy uncovered / 24th St', 16, 16], ['Economy garages (East & West)', 19, 19], ['Terminal 3 & 4 garages', 33, 33], ['Premium (T3 & T4)', 37, 37], ['Valet', 43, 43]],
  DTW: [['Green Lot', 20, 20], ['Big Blue Deck long-term', 23, 23], ['McNamara long-term', 32, 32], ['Short-term garages', 43, 44], ['McNamara valet', 51, 51]],
  // flypdx.com 14 Oct 2026; Economy 7 days $90 per the official calculator
  PDX: [['Economy (7th day free)', 15, 15, 90], ['Long-Term garage', 24, 24], ['Short-Term garage', 30, 30], ['Valet', 45, 45]],
  ORD: [['Economy Lots G & H', 16, 16], ['Economy Lot F (covered)', 30, 30], ['Main & T5 Garages (daily)', 43, 43], ['Main Garage Level 1 (hourly)', 79, 79]],
  // EWR: the airport does not publish on-airport rates (13 Oct 2026) → no airport bars.
  // YYZ: the October rows came from a third-party site (torontopearson.com blocked by captcha) and were never verified,
  // so they are not printed. Add YYZ back here only after checking the airport's own page (values are C$).
}

export function onAirportRows(code: string): OnAirportRate[] {
  return (ON_AIRPORT_RATES[code.toUpperCase()] ?? []).map(([name, lo, hi, week]) => ({ name, lo, hi, ...(week ? { week } : {}) }))
}

// ── Stay window ─────────────────────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000
const ymd = (t: number) => new Date(t).toISOString().slice(0, 10)
const parse = (d: string) => Date.parse(`${d}T00:00:00Z`)
const addDays = (d: string, n: number) => ymd(parse(d) + n * DAY_MS)

/** nth (1-based) weekday (0 = Sunday) of a month; n = -1 → the last one. */
function nthWeekday(year: number, month0: number, weekday: number, n: number): string {
  if (n > 0) {
    const first = new Date(Date.UTC(year, month0, 1)).getUTCDay()
    return ymd(Date.UTC(year, month0, 1 + ((weekday - first + 7) % 7) + (n - 1) * 7))
  }
  const lastDate = new Date(Date.UTC(year, month0 + 1, 0))
  return ymd(Date.UTC(year, month0, lastDate.getUTCDate() - ((lastDate.getUTCDay() - weekday + 7) % 7)))
}

/** Western Easter Sunday (anonymous Gregorian algorithm). */
function easter(year: number): string {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100, d = Math.floor(b / 4), e = b % 4
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1
  return ymd(Date.UTC(year, month - 1, day))
}

/** US + Canadian travel-holiday windows [first, last] (inclusive) a priced stay must not touch: their lot prices are not typical. */
export function holidayWindows(year: number): [string, string][] {
  const around = (d: string, before: number, after: number): [string, string] => [addDays(d, -before), addDays(d, after)]
  const thanksgiving = nthWeekday(year, 10, 4, 4)
  return [
    [`${year - 1}-12-18`, `${year}-01-04`],
    around(nthWeekday(year, 0, 1, 3), 3, 1), // MLK Day
    around(nthWeekday(year, 1, 1, 3), 3, 1), // Presidents' Day / Family Day
    around(easter(year), 3, 1), // Good Friday – Easter Monday
    around(nthWeekday(year, 4, 1, -1), 3, 1), // Memorial Day
    [`${year}-06-29`, `${year}-07-07`], // Canada Day + July 4
    around(nthWeekday(year, 8, 1, 1), 3, 1), // Labor Day
    around(nthWeekday(year, 9, 1, 2), 3, 1), // Canadian Thanksgiving
    around(thanksgiving, 5, 4), // US Thanksgiving week
    [`${year}-12-18`, `${year + 1}-01-04`],
  ]
}

/**
 * The stay a chart prices: the first Thursday at least 8 days after `today` whose 7-day stay (Thursday → Thursday,
 * 10:00 AM → 10:00 AM) touches no holiday window. Far enough out that same-week sell-outs don't thin the list.
 */
export function pickStayWindow(today: string): { checkin: string; checkout: string } {
  let t = parse(addDays(today, 8))
  t += ((4 - new Date(t).getUTCDay() + 7) % 7) * DAY_MS
  for (let guard = 0; guard < 60; guard++, t += 7 * DAY_MS) {
    const checkin = ymd(t), checkout = ymd(t + 7 * DAY_MS)
    const years = [Number(checkin.slice(0, 4)), Number(checkout.slice(0, 4))]
    const clash = years.flatMap(holidayWindows).some(([a, b]) => checkin <= b && checkout >= a)
    if (!clash) return { checkin, checkout }
  }
  throw new Error(`no holiday-free stay window found after ${today}`)
}

// ── Formatting ──────────────────────────────────────────────────────────────────────────────────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const parts = (d: string) => ({ y: Number(d.slice(0, 4)), m: Number(d.slice(5, 7)) - 1, d: Number(d.slice(8, 10)) })

/** "Nov 2, 2026" */
export function fmtDate(d: string): string {
  const p = parts(d)
  return `${MONTHS[p.m]} ${p.d}, ${p.y}`
}

/** "Nov 12–19, 2026", "Nov 26 – Dec 3, 2026", "Dec 30, 2026 – Jan 6, 2027" */
export function fmtStay(checkin: string, checkout: string): string {
  const a = parts(checkin), b = parts(checkout)
  if (a.y !== b.y) return `${fmtDate(checkin)} – ${fmtDate(checkout)}`
  if (a.m !== b.m) return `${MONTHS[a.m]} ${a.d} – ${MONTHS[b.m]} ${b.d}, ${b.y}`
  return `${MONTHS[a.m]} ${a.d}–${b.d}, ${a.y}`
}

const sym = (c: ChartCurrency) => (c === 'CAD' ? 'C$' : '$')
/** A lot price to the cent, as the search card prints it. */
export const money = (n: number, c: ChartCurrency) => `${sym(c)}${n.toFixed(2)}`
/** A posted on-airport rate (whole currency units) or range. */
function postedMoney(lo: number, hi: number, c: ChartCurrency): string {
  return lo === hi ? `${sym(c)}${lo}` : `${sym(c)}${lo}–${sym(c)}${hi}`
}
const weekOf = (r: OnAirportRate): [number, number] => (r.week !== undefined ? [r.week, r.week] : [r.lo * 7, r.hi * 7])

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Display name: drop "(ATL)"-style suffixes and "Formerly …", then cut at a word boundary to fit `max` characters. */
export function shortName(name: string, max = 34): string {
  const n = name.replace(/\s*\([A-Z]{3}\)/g, '').replace(/\s+Formerly.*$/i, '').replace(/\s+/g, ' ').trim()
  if (n.length <= max) return n
  const cut = n.slice(0, max + 1).replace(/\s+\S*$/, '')
  return (cut.length >= 8 ? cut : n.slice(0, max)).replace(/[\s,–-]+$/, '')
}

const TRANSFER_LABEL: Record<Transfer, string> = { shuttle: 'Shuttle', valet: 'Valet', paid: 'Paid shuttle', none: 'No shuttle', unknown: '—' }
/** Printed after a lot's price on the bars chart, so the name keeps its full width. */
const TRANSFER_NOTE: Partial<Record<Transfer, string>> = { paid: ' + paid shuttle', none: ', no shuttle', valet: ', valet' }

// ── Lot order + chart input ─────────────────────────────────────────────────────────────────────

/** Display order: lots that may lead cheapest first, then the rest (paid transfer, caveats); at most `max`. */
export function orderLots(lots: ChartLot[], max = 6): ChartLot[] {
  const byPrice = (a: ChartLot, b: ChartLot) => a.perDay - b.perDay || a.name.localeCompare(b.name)
  const lead = lots.filter((l) => l.mayLead).sort(byPrice)
  const rest = lots.filter((l) => !l.mayLead).sort(byPrice)
  return [...lead, ...rest].slice(0, max)
}

/** The engine-local snapshot file prices.mts writes and the engine reads. */
export const PRICE_SNAPSHOT_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'chart-prices.json')

export function loadPriceSnapshot(file = PRICE_SNAPSHOT_PATH): PriceSnapshot | null {
  if (!fs.existsSync(file)) return null
  const s = JSON.parse(fs.readFileSync(file, 'utf-8')) as PriceSnapshot
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s.asOf ?? '') || !s.airports || typeof s.airports !== 'object') throw new Error(`${file}: not a price snapshot`)
  return s
}

export function snapshotAgeDays(s: PriceSnapshot, today: string): number {
  return Math.round((parse(today) - parse(s.asOf)) / DAY_MS)
}

/**
 * Chart input for one airport, or null when there is nothing honest to draw: no snapshot row, a failed read, or
 * neither a lot we sell nor on-airport rates. `lots: []` with on-airport rows = the fallback chart.
 */
export function chartInputFor(code: string, s: PriceSnapshot): ChartInput | null {
  const row = s.airports[code.toUpperCase()]
  if (!row || row.status === 'error') return null
  const currency: ChartCurrency = row.currency ?? 'USD'
  const lots = row.status === 'ok' ? orderLots(row.lots ?? []) : []
  const onAirport = onAirportRows(code)
  if (lots.length === 0 && onAirport.length === 0) return null
  return { code: code.toUpperCase(), currency, asOf: s.asOf, checkin: s.checkin, checkout: s.checkout, lots, onAirport, onAirportChecked: onAirport.length ? ON_AIRPORT_CHECKED : null }
}

// ── SVG ─────────────────────────────────────────────────────────────────────────────────────────

const C = { navy: '#1A1A2E', green: '#22c55e', gray: '#64748b', line: '#e2e8f0', band: '#f8fafc' }
const txt = (x: number, y: number, s: string, attrs = '') => `<text x="${x}" y="${y}" font-family="Arial, Helvetica, sans-serif" ${attrs}>${esc(s)}</text>`

function header(d: ChartInput, title: string): string {
  const sub = d.lots.length
    ? `Prices as of ${fmtDate(d.asOf)} for a 7-day stay, ${fmtStay(d.checkin, d.checkout)}`
    : `Posted on-airport rates, checked ${d.onAirportChecked}`
  const legend: string[] = []
  let y = 52
  if (d.lots.length) { legend.push(`<rect x="560" y="${y}" width="12" height="12" fill="${C.green}"/>${txt(578, y + 10, 'Off-site, bookable on Triply', `font-size="12" fill="${C.navy}"`)}`); y += 18 }
  if (d.onAirport.length) legend.push(`<rect x="560" y="${y}" width="12" height="12" fill="${C.navy}"/>${txt(578, y + 10, 'On-airport, posted rate', `font-size="12" fill="${C.navy}"`)}`)
  return `${txt(30, 42, title, `font-size="22" font-weight="bold" fill="${C.navy}"`)}
${txt(30, 66, sub, `font-size="13" fill="${C.gray}"`)}
${legend.join('\n')}`
}

/** Billed days of the lots whose 7-day stay bills more (or fewer) days — "8" when one lot counts calendar days. */
const oddBilling = (d: ChartInput) => [...new Set(d.lots.filter((l) => l.billedDays !== 7).map((l) => l.billedDays))]

function footer(d: ChartInput, kind: ChartKind): string {
  const lines: string[] = []
  if (d.lots.length) {
    lines.push(kind === 'daily'
      ? 'Off-site: the triplypro.com total for these dates, taxes and fees included, per billed day. Prices change by date.'
      : 'Off-site: the triplypro.com total for this 7-day stay, taxes and fees included. Prices change by date.')
    const odd = oddBilling(d)
    if (kind === 'week' && odd.length) lines.push(`* The lot bills ${odd.length === 1 ? odd[0] : 'a different number of'} days for this 7-day stay; per day = total ÷ billed days.`)
  }
  if (d.onAirport.length) lines.push(`On-airport: the airport's posted ${kind === 'daily' ? 'daily maximum' : 'rate for 7 days'}, checked ${d.onAirportChecked}.`)
  return lines.map((l, i) => txt(30, 488 - (lines.length - 1 - i) * 15, l, `font-size="11" fill="${C.gray}"`)).join('\n')
}

const frame = (body: string) => `<svg width="800" height="500" viewBox="0 0 800 500" xmlns="http://www.w3.org/2000/svg">
<rect width="800" height="500" fill="#ffffff"/>
${body}
</svg>`

interface Row { label: string; value: number; price: string; note: string; offSite: boolean; week: string; transfer: string }

function rows(d: ChartInput): Row[] {
  const lots = d.lots.map((l) => ({
    label: shortName(l.name), value: l.perDay, price: `${money(l.perDay, d.currency)}/day`, note: TRANSFER_NOTE[l.transfer] ?? '', offSite: true,
    week: money(l.stayTotal, d.currency) + (l.billedDays !== 7 ? '*' : ''), transfer: TRANSFER_LABEL[l.transfer],
  }))
  const on = d.onAirport.map((r) => {
    const [wlo, whi] = weekOf(r)
    return { label: shortName(r.name), value: r.hi, price: `${postedMoney(r.lo, r.hi, d.currency)}/day`, note: '', offSite: false, week: postedMoney(wlo, whi, d.currency), transfer: '' }
  })
  return [...lots, ...on]
}

export function barsSvg(d: ChartInput): string {
  const rs = rows(d)
  const max = Math.max(...rs.map((r) => r.value)), h = Math.min(40, 340 / rs.length), y0 = 100
  const body = rs.map((r, k) => {
    const y = y0 + k * h, w = Math.max(4, (r.value / max) * 300)
    const note = r.note ? `<tspan font-weight="normal" fill="${C.gray}">${esc(r.note)}</tspan>` : ''
    return `${txt(290, y + h / 2 + 5, r.label, `font-size="13" fill="${C.navy}" text-anchor="end"`)}
<rect x="300" y="${(y + 4).toFixed(1)}" width="${w.toFixed(1)}" height="${(h - 8).toFixed(1)}" fill="${r.offSite ? C.green : C.navy}"/>
<text x="${(308 + w).toFixed(1)}" y="${(y + h / 2 + 5).toFixed(1)}" font-family="Arial, Helvetica, sans-serif" font-size="13" font-weight="bold" fill="${C.navy}">${esc(r.price)}${note}</text>`
  }).join('\n')
  const title = d.lots.length ? `${d.code} parking: daily rates compared` : `${d.code} airport parking: posted daily rates`
  return frame(`${header(d, title)}\n${body}\n${footer(d, 'daily')}`)
}

export function tableSvg(d: ChartInput): string {
  const rs = rows(d)
  const h = Math.min(30, 330 / (rs.length + 1)), y0 = 100, cols = [30, 330, 440, 560, 680]
  const head = ['Parking', 'Type', 'Per day', '7-day stay', d.lots.length ? 'Shuttle' : ''].map((s, k) => txt(cols[k], y0 + h / 2 + 5, s, `font-size="13" font-weight="bold" fill="${C.navy}"`)).join('')
  const body = rs.map((r, k) => {
    const y = y0 + (k + 1) * h, cy = y + h / 2 + 5
    return `${k % 2 ? '' : `<rect x="20" y="${y.toFixed(1)}" width="760" height="${h.toFixed(1)}" fill="${C.band}"/>`}
${txt(cols[0], cy, r.label, `font-size="13" fill="${C.navy}"`)}${txt(cols[1], cy, r.offSite ? 'Off-site' : 'On-airport', `font-size="13" fill="${r.offSite ? C.green : C.gray}"`)}
${txt(cols[2], cy, r.price.replace('/day', ''), `font-size="13" fill="${C.navy}"`)}${txt(cols[3], cy, r.week, `font-size="13" font-weight="bold" fill="${C.navy}"`)}
${txt(cols[4], cy, r.transfer, `font-size="13" fill="${C.gray}"`)}`
  }).join('\n')
  const title = d.lots.length ? `${d.code} parking: what 7 days costs` : `${d.code} airport parking: 7 days at posted rates`
  return frame(`${header(d, title)}\n<line x1="20" x2="780" y1="${(y0 + h).toFixed(1)}" y2="${(y0 + h).toFixed(1)}" stroke="${C.line}"/>${head}\n${body}\n${footer(d, 'week')}`)
}

export function chartSvg(d: ChartInput, kind: ChartKind): string {
  return kind === 'daily' ? barsSvg(d) : tableSvg(d)
}

// ── Alt text (the blog prints it as the visible caption) ────────────────────────────────────────

/**
 * Caption for a chart. Every lot figure carries its date and stay; the range runs over lots that may lead (a
 * paid-transfer or caveated lot is never the "from" price); on-airport figures carry the month they were checked.
 */
export function chartAlt(d: ChartInput, kind: ChartKind): string {
  const cur = d.currency
  const lotPrice = (l: ChartLot) => (kind === 'daily' ? `${money(l.perDay, cur)}/day` : money(l.stayTotal, cur))
  const unit = kind === 'daily' ? 'daily rates' : '7-day costs'
  const clauses: string[] = []
  if (d.lots.length) {
    const lead = d.lots.filter((l) => l.mayLead)
    const named = (l: ChartLot) => `${lotPrice(l)} (${shortName(l.name, 60)})`
    if (d.lots.length === 1) {
      const l = d.lots[0]
      clauses.push(`the one lot bookable on Triply, ${shortName(l.name, 60)}, ${lotPrice(l)}${l.transfer === 'paid' ? ' plus a paid shuttle' : ''}`)
    } else if (lead.length === 0) {
      clauses.push(`lots bookable on Triply from ${named(d.lots[0])}, each with a transfer caveat (see the lot page)`)
    } else {
      const sorted = (kind === 'daily' ? [...lead].sort((a, b) => a.perDay - b.perDay) : [...lead].sort((a, b) => a.stayTotal - b.stayTotal))
      const lo = sorted[0], hi = sorted[sorted.length - 1]
      clauses.push(lo === hi ? `lots bookable on Triply from ${named(lo)}` : `lots bookable on Triply from ${named(lo)} to ${named(hi)}`)
    }
    clauses[0] += `, taxes and fees included, prices as of ${fmtDate(d.asOf)} for a 7-day stay ${fmtStay(d.checkin, d.checkout)}`
  }
  if (d.onAirport.length) {
    const lo = d.onAirport.reduce((m, r) => (r.lo < m.lo ? r : m)), hi = d.onAirport.reduce((m, r) => (r.hi > m.hi ? r : m))
    const val = (r: OnAirportRate, edge: 'lo' | 'hi') => (kind === 'daily' ? `${sym(cur)}${r[edge]}/day` : `${sym(cur)}${weekOf(r)[edge === 'lo' ? 0 : 1]}`)
    const range = lo === hi ? `${val(lo, 'lo')} (${lo.name})` : `${val(lo, 'lo')} (${lo.name}) to ${val(hi, 'hi')} (${hi.name})`
    clauses.push(`on-airport parking from ${range}, posted rates checked ${d.onAirportChecked}`)
  }
  const head = d.lots.length ? `${d.code} parking ${unit} compared` : `${d.code} airport parking ${kind === 'daily' ? 'posted daily rates' : '7-day costs at posted rates'}`
  return `${head}: ${clauses.join('; ')}.`
}

// ── Engine helpers (new posts) ──────────────────────────────────────────────────────────────────

/** A snapshot older than this is not used for a new post: no chart rather than a stale one. */
export const MAX_SNAPSHOT_AGE_DAYS = 35

/** Where a new post gets its rate chart: after the first paragraph under the first H2 about cost/prices. -1 = no such section. */
export function rateChartInsertAt(html: string): number {
  const h = /<h2[^>]*>(?:(?!<\/h2>)[\s\S])*?(?:cost|price|rate|cheap|compar|sav(?:e|ing)|budget|how much)(?:(?!<\/h2>)[\s\S])*?<\/h2>/i.exec(html)
  if (!h) return -1
  const p = html.indexOf('</p>', h.index + h[0].length)
  return p === -1 ? -1 : p + '</p>'.length
}

/**
 * True when a free-form infographic prices an off-site lot: its text has a money figure AND says Triply / bookable or
 * names one of the airport's off-site lots (first two words of the name). The "Source: triplypro.com" footer is ignored.
 */
export function pricesOffSiteLots(svg: string, lotNames: string[]): boolean {
  const text = svg.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/Source:\s*triplypro\.com/gi, ' ')
  if (!/(?:C\$|\$)\s?\d/.test(text)) return false
  if (/triply|bookable/i.test(text)) return true
  const lower = text.toLowerCase().replace(/\s+/g, ' ')
  return lotNames.some((n) => {
    const key = n.toLowerCase().replace(/\s*\([a-z]{3}\)/, '').replace(/^the\s+/, '').split(/\s+/).slice(0, 2).join(' ')
    return key.length >= 6 && lower.includes(key)
  })
}

/** Media filename for a redrawn chart — distinct from the October families (`<code>-parking-rates-<hash>`, `<code>-infographic-…`). */
export function chartFileName(d: ChartInput, kind: ChartKind): string {
  return `${d.code.toLowerCase()}-rate-chart-${kind}${d.lots.length ? '' : '-airport'}-${d.asOf}.png`
}

export function svgToPng(svg: string): Buffer {
  const r = new Resvg(svg, { fitTo: { mode: 'width', value: 800 }, font: { loadSystemFonts: true, defaultFontFamily: 'Arial' } })
  return Buffer.from(r.render().asPng())
}
