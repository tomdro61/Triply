// Chart redraw, step 2 (read-only): one live triplypro.com search per airport → data/chart-prices.json.
// The lots a chart may show are the lots this search returns — the ones a customer can book that day — priced
// the way the search card prices them (total incl. taxes, fees and our service fee; per day = total ÷ billed days).
// One search per airport, sequential, one retry. A result is used only if it is the airport's own list, complete,
// fresh and fully priced; otherwise the airport is recorded as 'error' and gets no chart until the next run.
//   npx tsx reports/chart-redraw/prices.mts [--today YYYY-MM-DD] [--from-saved] [ATL DFW ...]
// Writes data/chart-prices.json (tracked: the engine reads it for new posts) and reports/chart-redraw/out/search-<CODE>.json.
import fs from 'fs'
import path from 'path'
// The app's own price helpers (the search card's math). The app package is CommonJS to tsx, so take the default export.
import serviceFee from '../../../../src/lib/utils/service-fee.ts'
import { CANADIAN_AIRPORT_CODES } from '../../src/airport-data.js'
import { transferBlocker, DO_NOT_LEAD } from '../../src/prompts/write.js'
import { ON_AIRPORT_RATES, PRICE_SNAPSHOT_PATH, pickStayWindow, type AirportPrices, type ChartLot, type PriceSnapshot, type Transfer } from '../../src/rate-chart.js'

const { customerPerDayFromPricing, customerTotalFromPricing } = serviceFee
const SITE = 'https://www.triplypro.com'
const OUT = 'reports/chart-redraw/out'
const args = process.argv.slice(2)
// "Prices as of" is the date in New York (where the team reads it), not UTC: an evening run is still today.
const today = args.includes('--today') ? args[args.indexOf('--today') + 1] : new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date())
if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new Error(`--today must be YYYY-MM-DD, got ${today}`)
const { checkin, checkout } = pickStayWindow(today)

// Airports: every engine data file, every airport with on-airport rates, every airport in the chart inventory.
const fileCodes = fs.readdirSync('data/airports').filter((f) => /^[A-Z]{3}\.json$/.test(f)).map((f) => f.slice(0, 3))
const invPath = `${OUT}/inventory.json`
const invCodes: string[] = fs.existsSync(invPath) ? JSON.parse(fs.readFileSync(invPath, 'utf-8')).airports ?? [] : []
const only = args.filter((a) => /^[A-Z]{3}$/.test(a))
const CODES = only.length ? only : [...new Set([...fileCodes, ...Object.keys(ON_AIRPORT_RATES), ...invCodes])].sort()

type Json = Record<string, unknown>
interface LiveLot { id: string; name: string; slug?: string; reslabLocationId?: number; availability?: string; shuttleInfo?: { summary?: string; details?: string }; pricing?: Json }
interface SearchBody { total?: number; results?: LiveLot[]; degraded?: boolean; stale?: boolean; listIncomplete?: boolean; reslabUnavailable?: boolean; directUnavailable?: boolean; ownAirportFallback?: boolean; error?: string }

const norm = (s: unknown) => String(s ?? '').toLowerCase().replace(/\([a-z]{3}\)/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').replace(/\bthe\b/g, '').trim()
const NO_SHUTTLE = /\bno (?:airport )?shuttle\b|shuttle (?:service )?(?:is )?not (?:available|provided|offered|included)|does not (?:offer|provide) (?:a |an )?(?:airport )?shuttle/i

function fileLots(code: string): Json[] {
  const f = `data/airports/${code}.json`
  if (!fs.existsSync(f)) return []
  const lots = (JSON.parse(fs.readFileSync(f, 'utf-8')) as { parkingLots?: Json[] }).parkingLots
  return Array.isArray(lots) ? lots : []
}

/** The data-file entry for a live lot (ResLab id, then slug, then name), for its notes / cruise / suspended flags only. */
function match(live: LiveLot, lots: Json[]): Json | undefined {
  return lots.find((l) => live.reslabLocationId !== undefined && Number(l.reslabLocationId) === live.reslabLocationId)
    ?? lots.find((l) => typeof l.slug === 'string' && l.slug === live.slug)
    ?? lots.find((l) => norm(l.name) === norm(live.name) || (typeof l.triplyListingName === 'string' && norm(l.triplyListingName) === norm(live.name)))
}

// "Added fee of CAD $5 per adult" (a YYZ hotel shuttle): a per-rider fee the engine's transferBlocker doesn't list.
const PER_RIDER_FEE = /(?:C\$|CAD\s?\$?|US\$|\$)\s?\d+(?:\.\d{2})?\s*(?:per|\/|a|each)\s*(?:adult|passenger|guest|person|rider|travell?er)/i
const EXTRA_RIDER = /(?:additional|extra|beyond|more than \d)[^.]{0,30}$/i

/**
 * A transfer cost on top of the lot price, by the blog engine's own rule (transferBlocker: "$10 each way", "C$8 fee",
 * "shuttle is NOT free", a paid cruise shuttle) or a per-rider fee — the same test that keeps a lot from leading an article.
 */
function paidTransfer(live: LiveLot, file: Json | undefined): boolean {
  const text = [live.shuttleInfo?.summary, live.shuttleInfo?.details, file?.shuttleInfo].filter((t) => typeof t === 'string').join(' ')
  if (transferBlocker({ shuttleInfo: text, notes: file?.notes, cruiseShuttle: file?.cruiseShuttle })) return true
  const fee = text.match(PER_RIDER_FEE)
  return !!fee && !EXTRA_RIDER.test(text.slice(Math.max(0, (fee.index ?? 0) - 40), fee.index ?? 0))
}

/**
 * The label: how the lot itself says you reach the terminal — its shuttle summary on our site, else the data file's.
 * Conservative: "No shuttle" only when the lot says so outright (a shuttle that stops overnight is still a shuttle);
 * "Valet" when it offers valet and no shuttle; "Shuttle" only on shuttle words; otherwise "—" (a hotel Lyft, an AirTrain).
 * A lot with no shuttle is labelled "No shuttle" even when the engine counts a rideshare as a paid transfer.
 */
function transferOf(live: LiveLot, file: Json | undefined, paid: boolean): Transfer {
  const s = (live.shuttleInfo?.summary ?? '').trim() || String(file?.shuttleInfo ?? '')
  if (file?.shuttleSuspended === true || /shuttle (?:is )?suspended/i.test(s)) return 'none'
  if (/^\s*no shuttle/i.test(s) || (NO_SHUTTLE.test(s) && !/shuttle runs|every \d+|on demand/i.test(s))) return 'none'
  if (/valet/i.test(s) && !/shuttle/i.test(s)) return 'valet'
  if (paid) return 'paid'
  if (/shuttle|on[- ]demand|every \d+\s*min|to and from the airport|pick ?ups?\b|on the hour/i.test(s)) return 'shuttle'
  return 'unknown'
}

async function search(code: string): Promise<{ status: number; body: SearchBody }> {
  const q = new URLSearchParams({ airport: code, checkin, checkout, checkinTime: '10:00 AM', checkoutTime: '10:00 AM' })
  const r = await fetch(`${SITE}/api/search?${q}`, { headers: { 'User-Agent': 'triply-chart-redraw/1.0 (blog price charts)' }, signal: AbortSignal.timeout(90_000) })
  return { status: r.status, body: (await r.json().catch(() => ({}))) as SearchBody }
}

/** Why a search can't feed a chart ('' = usable). */
function unusable(status: number, b: SearchBody): string {
  if (status !== 200) return `HTTP ${status}${b.error ? ` ${b.error}` : ''}`
  const flags = (['degraded', 'stale', 'listIncomplete', 'reslabUnavailable', 'directUnavailable', 'ownAirportFallback'] as const).filter((k) => b[k] === true)
  return flags.length ? flags.join(', ') : ''
}

function toAirport(code: string, b: SearchBody, excluded: string[]): AirportPrices {
  const expect = CANADIAN_AIRPORT_CODES.has(code) ? 'CAD' : 'USD'
  const files = fileLots(code)
  const cruise = code === 'POE'
  const lots: ChartLot[] = []
  for (const live of b.results ?? []) {
    const p = live.pricing as Parameters<typeof customerTotalFromPricing>[0] & { numberOfDays?: number; currencyCode?: string } | undefined
    const cur = p?.currencyCode
    if (cur !== expect) return { status: 'error', reason: `${live.name}: currency ${cur ?? 'missing'}, expected ${expect}` }
    const stayTotal = customerTotalFromPricing(p)
    const perDay = customerPerDayFromPricing(p as Parameters<typeof customerPerDayFromPricing>[0])
    if (stayTotal === null || perDay === null || !p?.numberOfDays) { excluded.push(`${live.name}: no total / billed days`); continue }
    const file = match(live, files)
    if (cruise) {
      // A port chart shows only lots with a port shuttle we know about (data file cruiseShuttle).
      const cs = String(file?.cruiseShuttle ?? '')
      if (cs !== 'included' && !cs.startsWith('paid')) { excluded.push(`${live.name}: no known cruise-port shuttle (${cs || 'not in data file'})`); continue }
    }
    const paid = paidTransfer(live, file)
    const transfer = transferOf(live, file, paid)
    // Leading follows the engine (leadEligibleLots): no paid transfer, no suspended shuttle, no "do not use in CTAs" note.
    // A lot with no shuttle may lead (Tom, Nov 2) — it just never gets a shuttle claim.
    const suspended = file?.shuttleSuspended === true || /shuttle (?:is )?suspended/i.test(live.shuttleInfo?.summary ?? '')
    const mayLead = !paid && !suspended && !(typeof file?.notes === 'string' && DO_NOT_LEAD.test(file.notes))
    const base = (p as { minPrice?: unknown }).minPrice
    lots.push({ name: live.name, perDay: Math.round(perDay * 100) / 100, stayTotal: Math.round(stayTotal * 100) / 100, billedDays: p.numberOfDays, transfer, mayLead, ...(typeof base === 'number' && base > 0 ? { baseRate: Math.round(base * 100) / 100 } : {}) })
  }
  return lots.length ? { status: 'ok', currency: expect, lots } : { status: 'none', currency: expect }
}

fs.mkdirSync(OUT, { recursive: true })
const started = new Date().toISOString()
console.log(`Stay priced: ${checkin} 10:00 AM → ${checkout} 10:00 AM · ${CODES.length} airports · started ${started}`)
const airports: Record<string, AirportPrices> = {}
const notes: Record<string, string[]> = {}
// --from-saved: rebuild the snapshot from this run's saved searches (out/search-<CODE>.json) without searching again.
const FROM_SAVED = args.includes('--from-saved')
for (const code of CODES) {
  const saved = `${OUT}/search-${code}.json`
  if (FROM_SAVED && !fs.existsSync(saved)) { console.log(`${code}: no saved search, skipped`); continue }
  let res: { status: number; body: SearchBody } = FROM_SAVED ? JSON.parse(fs.readFileSync(saved, 'utf-8')) : await search(code).catch((e: Error) => ({ status: 0, body: { error: e.message } as SearchBody }))
  let why = unusable(res.status, res.body)
  if (why && res.status !== 400 && !FROM_SAVED) {
    await new Promise((r) => setTimeout(r, 30_000))
    res = await search(code).catch((e: Error) => ({ status: 0, body: { error: e.message } as SearchBody }))
    why = unusable(res.status, res.body)
  }
  if (!FROM_SAVED) fs.writeFileSync(saved, JSON.stringify({ at: new Date().toISOString(), status: res.status, body: res.body }, null, 1))
  const excluded: string[] = []
  airports[code] = why ? { status: 'error', reason: why } : toAirport(code, res.body, excluded)
  if (excluded.length) notes[code] = excluded
  const a = airports[code]
  console.log(`${code}: ${a.status}${a.reason ? ` — ${a.reason}` : ''}${a.lots ? ` — ${a.lots.length} lots` : ''}${excluded.length ? ` (${excluded.length} excluded)` : ''}`)
  if (!FROM_SAVED) await new Promise((r) => setTimeout(r, 2_000))
}

const snapshot: PriceSnapshot = { asOf: today, checkin, checkout, airports }
fs.writeFileSync(PRICE_SNAPSHOT_PATH, JSON.stringify(snapshot, null, 1) + '\n')
if (FROM_SAVED) {
  console.log(`wrote ${path.relative(process.cwd(), PRICE_SNAPSHOT_PATH)} from saved searches (no new searches)`)
} else {
  fs.writeFileSync(`${OUT}/prices-run-${today}.json`, JSON.stringify({ started, finished: new Date().toISOString(), userAgent: 'triply-chart-redraw/1.0', excluded: notes }, null, 1))
  console.log(`wrote ${path.relative(process.cwd(), PRICE_SNAPSHOT_PATH)} · search window ${started} → ${new Date().toISOString()} (exclude these searches from demand reports)`)
}
