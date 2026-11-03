// Chart redraw, step 2 (read-only): one live triplypro.com search per airport → data/chart-prices.json.
// The lots a chart may show are the lots this search returns — the ones a customer can book that day — priced
// the way the search card prices them (total incl. taxes, fees and our service fee; per day = total ÷ billed days).
// One search per airport, sequential, one retry. A result is used only if it is the airport's own list, complete,
// fresh, fully priced and for the dates asked; otherwise the airport is 'error' and gets no chart until the next run.
//   npx tsx reports/chart-redraw/prices.mts [--today YYYY-MM-DD] [ATL DFW ...]
//   npx tsx reports/chart-redraw/prices.mts --from-saved     (rebuild from this run's saved searches; keeps their dates)
// Writes data/chart-prices.json (tracked: the engine reads it for new posts) and reports/chart-redraw/out/search-<CODE>.json.
import fs from 'fs'
import path from 'path'
// The app's own price helpers (the search card's math). The app package is CommonJS to tsx, so take the default export.
import serviceFee from '../../../../src/lib/utils/service-fee.ts'
import { CANADIAN_AIRPORT_CODES } from '../../src/airport-data.js'
import { DO_NOT_LEAD } from '../../src/prompts/write.js'
import { cruisePortLot, paidTransfer, transferOf } from '../../src/chart-lots.js'
import { ON_AIRPORT_RATES, PRICE_SNAPSHOT_PATH, pickStayWindow, type AirportPrices, type ChartLot, type PriceSnapshot } from '../../src/rate-chart.js'

const { customerPerDayFromPricing, customerTotalFromPricing } = serviceFee
const SITE = 'https://www.triplypro.com'
const OUT = 'reports/chart-redraw/out'
const args = process.argv.slice(2)
const FROM_SAVED = args.includes('--from-saved')
const nyDate = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d)

/**
 * HELD (Nov 2, 2026): checkout charges ResLab's total in US dollars (src/lib/stripe/client.ts `currency: "usd"`), but
 * ResLab prices these airports' lots in Canadian dollars — so a chart printing "C$54.01, the triplypro.com total" is
 * not what the card is charged. No chart for these airports until Tom settles the checkout currency.
 */
const CURRENCY_HOLD = 'held: ResLab prices this airport in CAD but checkout charges the same number in USD (Tom to decide)'

// Airports: every engine data file, every airport with on-airport rates, every airport in the chart inventory.
const fileCodes = fs.readdirSync('data/airports').filter((f) => /^[A-Z]{3}\.json$/.test(f)).map((f) => f.slice(0, 3))
const invPath = `${OUT}/inventory.json`
const invCodes: string[] = fs.existsSync(invPath) ? JSON.parse(fs.readFileSync(invPath, 'utf-8')).airports ?? [] : []
const only = args.filter((a) => /^[A-Z]{3}$/.test(a))
const CODES = only.length ? only : [...new Set([...fileCodes, ...Object.keys(ON_AIRPORT_RATES), ...invCodes])].sort()

type Json = Record<string, unknown>
interface LiveLot { id: string; name: string; slug?: string; reslabLocationId?: number; shuttleInfo?: { summary?: string; details?: string }; pricing?: Json }
interface SearchBody {
  airport?: { code?: string }; checkin?: string; checkout?: string; checkinTime?: string; checkoutTime?: string
  total?: number; locationsConsidered?: number; results?: LiveLot[]
  degraded?: boolean; stale?: boolean; listIncomplete?: boolean; reslabUnavailable?: boolean; directUnavailable?: boolean; ownAirportFallback?: boolean; error?: string
}
interface Saved { at: string; status: number; body: SearchBody }

// The run's date and stay: today's for a live run; the saved searches' own for --from-saved (never re-dated).
let asOf: string, checkin: string, checkout: string
if (FROM_SAVED) {
  const saved = CODES.map((c) => `${OUT}/search-${c}.json`).filter((f) => fs.existsSync(f)).map((f) => JSON.parse(fs.readFileSync(f, 'utf-8')) as Saved)
  const runs = new Set(saved.map((s) => `${nyDate(new Date(s.at))}|${s.body.checkin}|${s.body.checkout}`))
  if (runs.size !== 1) throw new Error(`--from-saved: the saved searches are from ${runs.size} different runs (${[...runs].join(', ')}); search again`)
  ;[asOf, checkin, checkout] = [...runs][0].split('|')
} else {
  asOf = args.includes('--today') ? args[args.indexOf('--today') + 1] : nyDate(new Date())
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new Error(`--today must be YYYY-MM-DD, got ${asOf}`)
  ;({ checkin, checkout } = pickStayWindow(asOf))
}

const norm = (s: unknown) => String(s ?? '').toLowerCase().replace(/\([a-z]{3}\)/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').replace(/\bthe\b/g, '').trim()

function fileLots(code: string): Json[] {
  const f = `data/airports/${code}.json`
  if (!fs.existsSync(f)) return []
  const lots = (JSON.parse(fs.readFileSync(f, 'utf-8')) as { parkingLots?: Json[] }).parkingLots
  return Array.isArray(lots) ? lots : []
}

/**
 * The data-file entry for a live lot (ResLab id, then slug, then name), for its notes / cruise / suspended flags only.
 * `exact` = matched by ResLab id, or by a slug/name no other live lot at the airport shares.
 */
function match(live: LiveLot, lots: Json[], all: LiveLot[]): { file: Json | undefined; exact: boolean } {
  const byId = lots.find((l) => live.reslabLocationId !== undefined && Number(l.reslabLocationId) === live.reslabLocationId)
  if (byId) return { file: byId, exact: true }
  const file = lots.find((l) => typeof l.slug === 'string' && l.slug === live.slug)
    ?? lots.find((l) => norm(l.name) === norm(live.name) || (typeof l.triplyListingName === 'string' && norm(l.triplyListingName) === norm(live.name)))
  const twins = all.filter((o) => o.slug === live.slug || norm(o.name) === norm(live.name)).length
  return { file, exact: !!file && twins === 1 }
}

async function search(code: string): Promise<Saved> {
  const q = new URLSearchParams({ airport: code, checkin, checkout, checkinTime: '10:00 AM', checkoutTime: '10:00 AM' })
  const r = await fetch(`${SITE}/api/search?${q}`, { headers: { 'User-Agent': 'triply-chart-redraw/1.0 (blog price charts)' }, signal: AbortSignal.timeout(90_000) })
  return { at: new Date().toISOString(), status: r.status, body: (await r.json().catch(() => ({}))) as SearchBody }
}

/** Why a search can't feed a chart ('' = usable): an error, a partial or fallback list, or an answer for other dates. */
function unusable(code: string, s: Saved): string {
  const b = s.body
  if (s.status !== 200) return `HTTP ${s.status}${b.error ? ` ${b.error}` : ''}`
  if (b.airport?.code !== code || b.checkin !== checkin || b.checkout !== checkout || b.checkinTime !== '10:00 AM' || b.checkoutTime !== '10:00 AM') {
    return `answer is for ${b.airport?.code} ${b.checkin} ${b.checkinTime} → ${b.checkout} ${b.checkoutTime}, not ${code} ${checkin} → ${checkout} 10:00 AM`
  }
  const flags = (['degraded', 'stale', 'listIncomplete', 'reslabUnavailable', 'directUnavailable', 'ownAirportFallback'] as const).filter((k) => b[k] === true)
  return flags.length ? flags.join(', ') : ''
}

const money2 = (n: number) => Number(n.toFixed(2)) // the search card's own rounding (toFixed)

function toAirport(code: string, b: SearchBody, excluded: string[]): AirportPrices {
  const expect = CANADIAN_AIRPORT_CODES.has(code) ? 'CAD' : 'USD'
  const files = fileLots(code)
  const port = code === 'POE'
  const results = b.results ?? []
  // 'none' only when Triply lists nothing at this airport. Lots that exist but can't be shown (sold out for the stay,
  // unpriced, all excluded) are an 'error': the next run may show them, and a fallback chart would wrongly say we sell none.
  if (results.length === 0) return (b.locationsConsidered ?? 0) === 0 ? { status: 'none', currency: expect } : { status: 'error', reason: `${b.locationsConsidered} lots listed, none bookable for ${checkin} → ${checkout}` }
  const lots: ChartLot[] = []
  const byName = new Map<string, number>()
  for (const live of results) {
    const p = live.pricing as Parameters<typeof customerTotalFromPricing>[0] & { numberOfDays?: number; currencyCode?: string; minPrice?: unknown } | undefined
    if (p?.currencyCode !== expect) return { status: 'error', reason: `${live.name}: currency ${p?.currencyCode ?? 'missing'}, expected ${expect}` }
    const stayTotal = customerTotalFromPricing(p)
    const perDay = customerPerDayFromPricing(p as Parameters<typeof customerPerDayFromPricing>[0])
    if (stayTotal === null || perDay === null || !p?.numberOfDays) { excluded.push(`${live.name}: no total or billed days`); continue }
    const { file, exact } = match(live, files, results)
    const sh = { name: live.name, summary: live.shuttleInfo?.summary, details: live.shuttleInfo?.details }
    if (port) {
      // A port chart shows only lots with a port shuttle we know about (data file cruiseShuttle).
      const cs = String(file?.cruiseShuttle ?? '')
      if (cs !== 'included' && !cs.startsWith('paid')) { excluded.push(`${live.name}: no known cruise-port shuttle (${cs || 'not in data file'})`); continue }
    } else {
      // An airport chart never shows a cruise-port lot (its shuttle runs to the port, not the terminal).
      const why = cruisePortLot(sh, file, exact)
      if (why) { excluded.push(`${live.name}: ${why}`); continue }
    }
    const paid = paidTransfer(sh, file)
    const transfer = transferOf(sh, file, paid)
    // Leading follows the engine (leadEligibleLots): no paid transfer, no suspended shuttle, no "do not use in CTAs"
    // note. A lot with no shuttle may lead (Tom, Nov 2) — it just never gets a shuttle claim.
    const suspended = file?.shuttleSuspended === true || /shuttle (?:is )?suspended/i.test(sh.summary ?? '')
    // Notes count only on an exact match: BWI's two "Clarion Hotel BWI North" listings share one entry written for the port one.
    const mayLead = !paid && !suspended && !(exact && typeof file?.notes === 'string' && DO_NOT_LEAD.test(file.notes))
    const base = typeof p.minPrice === 'number' && p.minPrice > 0 ? { baseRate: money2(p.minPrice) } : {}
    const lot: ChartLot = { name: live.name, perDay: money2(perDay), stayTotal: money2(stayTotal), billedDays: p.numberOfDays, transfer, mayLead, ...base }
    // Two listings with one name (BWI's two "Clarion Hotel BWI North") would print as identical rows: keep the cheaper stay.
    const key = norm(live.name), twin = byName.get(key)
    if (twin !== undefined) {
      const keepNew = lot.stayTotal < lots[twin].stayTotal
      excluded.push(`${live.name}: two listings with this name, kept the ${keepNew ? 'later' : 'first'} (cheaper stay)`)
      if (keepNew) lots[twin] = lot
      continue
    }
    byName.set(key, lots.length)
    lots.push(lot)
  }
  if (lots.length === 0) return { status: 'error', reason: `every listed lot was left off (${excluded.length})`, listed: results.length }
  return { status: 'ok', currency: expect, lots, listed: results.length }
}

fs.mkdirSync(OUT, { recursive: true })
const started = new Date().toISOString()
console.log(`${FROM_SAVED ? 'Rebuilding from saved searches' : 'Searching'}: stay ${checkin} 10:00 AM → ${checkout} 10:00 AM, prices as of ${asOf} · ${CODES.length} airports`)
const airports: Record<string, AirportPrices> = {}
const notes: Record<string, string[]> = {}
for (const code of CODES) {
  const file = `${OUT}/search-${code}.json`
  if (FROM_SAVED && !fs.existsSync(file)) { console.log(`${code}: no saved search, skipped`); continue }
  let res: Saved = FROM_SAVED ? JSON.parse(fs.readFileSync(file, 'utf-8')) : await search(code).catch((e: Error) => ({ at: new Date().toISOString(), status: 0, body: { error: e.message } }))
  let why = unusable(code, res)
  if (why && res.status !== 400 && !FROM_SAVED) {
    await new Promise((r) => setTimeout(r, 30_000))
    res = await search(code).catch((e: Error) => ({ at: new Date().toISOString(), status: 0, body: { error: e.message } }))
    why = unusable(code, res)
  }
  if (!FROM_SAVED) fs.writeFileSync(file, JSON.stringify(res, null, 1))
  const excluded: string[] = []
  let row: AirportPrices = why ? { status: 'error', reason: why } : toAirport(code, res.body, excluded)
  if (row.status !== 'error' && CANADIAN_AIRPORT_CODES.has(code)) row = { ...row, status: 'error', reason: CURRENCY_HOLD }
  airports[code] = row
  if (excluded.length) notes[code] = excluded
  console.log(`${code}: ${row.status}${row.reason ? ` — ${row.reason}` : ''}${row.lots ? ` — ${row.lots.length} lots` : ''}${excluded.length ? ` (${excluded.length} left off)` : ''}`)
  if (!FROM_SAVED) await new Promise((r) => setTimeout(r, 2_000))
}

// A run on a few airports (`prices.mts ATL DFW`) updates those rows of the same run; it never replaces the whole file
// (the engine would lose every other airport) and never mixes two runs' dates in one file.
let merged = airports
if (only.length && fs.existsSync(PRICE_SNAPSHOT_PATH)) {
  const prev = JSON.parse(fs.readFileSync(PRICE_SNAPSHOT_PATH, 'utf-8')) as PriceSnapshot
  if (prev.asOf !== asOf || prev.checkin !== checkin || prev.checkout !== checkout) {
    throw new Error(`data/chart-prices.json holds the ${prev.asOf} run (${prev.checkin} → ${prev.checkout}); a partial run for ${asOf} would mix dates — run every airport instead. Searches saved in ${OUT}.`)
  }
  merged = { ...prev.airports, ...airports }
}
const snapshot: PriceSnapshot = { asOf, checkin, checkout, airports: Object.fromEntries(Object.entries(merged).sort(([a], [b]) => a.localeCompare(b))) }
fs.writeFileSync(PRICE_SNAPSHOT_PATH, JSON.stringify(snapshot, null, 1) + '\n')
const runFile = `${OUT}/prices-run-${asOf}.json`
const prior = fs.existsSync(runFile) ? JSON.parse(fs.readFileSync(runFile, 'utf-8')) as { started?: string; finished?: string } : {}
fs.writeFileSync(runFile, JSON.stringify({
  // The search window is what demand reports must exclude; a --from-saved rebuild keeps the original one.
  started: FROM_SAVED ? prior.started : started, finished: FROM_SAVED ? prior.finished : new Date().toISOString(),
  userAgent: 'triply-chart-redraw/1.0', excluded: notes,
}, null, 1))
console.log(`wrote ${path.relative(process.cwd(), PRICE_SNAPSHOT_PATH)}${FROM_SAVED ? ' from saved searches (no new searches)' : ` · search window ${started} → ${new Date().toISOString()} (exclude these searches from demand reports)`}`)
