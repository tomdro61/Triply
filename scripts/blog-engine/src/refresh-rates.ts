/**
 * refresh-rates.ts — re-verify the parking rates in data/airports/<CODE>.json
 * against live pricing, and move `lastVerified` forward honestly.
 *
 * WHY THIS EXISTS
 * Every article's prices come from data/airports/<CODE>.json. Nothing in the engine
 * has ever WRITTEN `lastVerified` — it is only read (airport-data.ts, perf-recommend.ts)
 * — so refreshing has been a manual hand-edit and the files only ever got older. Past
 * PRICE_STALENESS_MAX_DAYS (150) the perf loop drops any recommendation that would put
 * a price in a SERP title/meta, so the engine quietly stops doing its most valuable
 * work corpus-wide. On 2026-08-31 JFK/LGA were 186 days old and 24 more airports sat
 * at 144 days, days away from crossing.
 *
 * WHERE THE PRICES COME FROM
 * Our own public search API — the same one the site runs on:
 *   GET {SITE}/api/search?airport=JFK&checkin=...&checkout=...&checkinTime=...&checkoutTime=...
 * No credentials needed. Each airport JSON already points at it in
 * `liveSources.parkingRatesAndCoupons.triplySearch`.
 *
 * FIELD MAPPING (verified 2026-08-31 against JFK, which was originally captured from
 * this endpoint — its stored taxesFor6Days 18.96 still matches the live 6-day tax to
 * the cent while the base rate has drifted +4.7%):
 *   dailyRate         = pricing.minPrice   ((subtotal + feesTotal) / numberOfDays)
 *   taxesFor<N>Days   = pricing.taxTotal
 *   totalFor<N>Days   = pricing.grandTotal
 * ResLab counts days INCLUSIVELY: numberOfDays = nights + 1. To price N days we book
 * N-1 nights. The daily rate genuinely varies with length of stay (JFK Safe Park:
 * $32.95 at 2 days vs $31.82 at 8), so each lot is priced at ITS OWN N, never a shared one.
 *
 * WHAT IT WILL NOT DO — every one of these was a real hazard found while building it:
 *
 *  1. It never deletes a lot. searchParking filters out sold-out lots and returns lots by
 *     geographic proximity (a JFK search returns LGA lots in Flushing). "Absent from the
 *     live result" therefore does NOT mean "gone" — absences are reported, never acted on.
 *
 *  2. It never writes from a degraded response. The API sets `degraded` / `stale` /
 *     `listIncomplete` when the lot list or the per-lot pricing calls were only partly
 *     successful. Writing a thin result would silently corrupt the catalogue AND bump
 *     `lastVerified`, hiding the damage behind a fresh date.
 *
 *  3. It only bumps top-level `lastVerified` when every lot PRESENT in live search was
 *     re-verified (see --min-coverage), and at least one lot is present. Fuzzy-skipped,
 *     implausible and unpriced lots are present but NOT verified, so they hold the date.
 *     Absent lots are marked `sellable: false` (+ `sellableCheckedOn`) and no longer
 *     hold the date: they are not lots we sell, and the title guard (airport-data.ts
 *     lotRateIsFresh) never lets their prices into a SERP title. Changed 2026-09-28;
 *     before that the denominator was every priced catalogue lot, and:
 *     Measured across all 30 airports 2026-08-31: only **33 of 206 lots (16%) could be
 *     verified**, plus 12 more behind --accept-fuzzy — and exactly ONE airport (JFK)
 *     reached full coverage. The catalogue lists the SEO-famous operators (The Parking
 *     Spot, WallyPark, MasterPark, Doug Fox) while we actually sell a different, smaller
 *     set (Motel 6, Sky Lot, Routes, Regal Philly). 13 airports match nothing at all, and
 *     SLC returns zero live lots on every date. Bumping `lastVerified` on a partly-
 *     refreshed file would silence the staleness guard across 30 airports while most of
 *     the prices stayed 186 days old — turning a visible problem into an invisible one.
 *     Per-lot `rateVerified` dates record what was actually checked.
 *
 *  4. Fuzzy name matches are reported but NOT applied without --accept-fuzzy. Two airport
 *     Hiltons are a real hazard; a wrong join writes one lot's price onto another.
 *
 *  5. An implausible move (default: >3x or <1/3 of the stored rate) is refused and reported
 *     rather than written. That is the signature of a bad join, not a price change.
 *
 * It also records `paymentMethod` from the live `dueAtLocation` flag, which is the input the
 * "prefer lots that don't take payment at the gate" work needs (18 of 206 recorded today).
 *
 * NOTE: ResLab rejects check-ins more than 60 days out (see src/lib/booking-window.ts,
 * MAX_ADVANCE_BOOKING_DAYS). Requests beyond it come back 503, so the sampling date is
 * clamped into that window.
 *
 * CLI:
 *   npm run refresh-rates                      # ALL airports, dry run (default)
 *   npm run refresh-rates -- -a JFK            # one airport, dry run
 *   npm run refresh-rates -- -a JFK --apply    # write it
 *   npm run refresh-rates -- --apply           # write every airport
 *   npm run refresh-rates -- --coverage        # no writes: just how much we can verify
 *   npm run refresh-rates -- --accept-fuzzy    # also apply fuzzy name matches
 *   npm run refresh-rates -- --lead 21 --days 7 --samples 3
 *   npm run refresh-rates -- -a LGA --min-coverage 0.85 --apply   # see the note by the check
 *
 * DO NOT use `npm run bootstrap` to refresh an existing airport — it is a new-airport
 * generator and strips ~17 fields (LAX went 31 keys/63.7KB -> 15 keys/4.3KB).
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.resolve(__dirname, '..', 'data', 'airports')
const REPORTS_DIR = path.resolve(__dirname, '..', 'reports')

/** Our own public search API. Override for a preview deployment or localhost. */
const SITE = (process.env.TRIPLY_SITE_URL || 'https://www.triplypro.com').replace(/\/$/, '')

/** ResLab refuses check-ins beyond this many days out (frontend: MAX_ADVANCE_BOOKING_DAYS). */
const MAX_ADVANCE_BOOKING_DAYS = 60

/** Days ahead to sample first. Far enough to be a normal advance booking, inside the 60d window. */
const DEFAULT_LEAD_DAYS = 21

/**
 * How many check-in dates to price before believing a rate, and how far apart.
 *
 * A single sample does not measure "the daily rate" — it captures a spot price on one
 * date. Measured 2026-08-31 across 41 lots at 4 airports and 6 check-in dates: 33 were
 * perfectly flat (0.0% spread), but 4 swung more than 25%, and Hyatt Place Flushing (a
 * LAZ hotel lot beside the US Open site) ranged $11.80-$21.06 — 78%, purely on date.
 * Publishing one date's number as a standing rate across 3,744 articles would put a
 * peak-demand price in front of everyone. So we sample and take the MEDIAN, which
 * ignores the excursion instead of averaging it in.
 */
const DEFAULT_SAMPLES = 3
const SAMPLE_SPACING_DAYS = 12

/** Stay length used for lots that carry no totalFor<N>Days of their own. */
const DEFAULT_DAYS = 7

/** A move beyond this ratio is treated as a bad join, not a price change. */
const MAX_PLAUSIBLE_RATIO = 3

/** Dice coefficient over name tokens at or above this is offered as a fuzzy match. */
const FUZZY_THRESHOLD = 0.8

const SLEEP_MS = 1200

interface LivePricing {
  minPrice?: number
  grandTotal?: number
  subtotal?: number
  feesTotal?: number
  taxTotal?: number
  numberOfDays?: number
}

interface LiveLot {
  name: string
  slug?: string
  address?: string | null
  pricing?: LivePricing
  availability?: string
  dueAtLocation?: boolean
}

interface SearchResponse {
  results?: LiveLot[]
  total?: number
  degraded?: boolean
  stale?: boolean
  listIncomplete?: boolean
}

type CatalogueLot = Record<string, unknown> & { name: string; slug?: string; dailyRate?: number }

interface Change {
  field: string
  from: unknown
  to: unknown
}

interface LotOutcome {
  lot: string
  status: 'updated' | 'unchanged' | 'fuzzy-skipped' | 'implausible' | 'absent' | 'unpriced'
  via?: 'name' | 'address' | 'fuzzy'
  matched?: string
  score?: number
  /** Number of sampled check-in dates this lot was priced on. */
  samples?: number
  /** (max-min)/min across those dates, as a percentage. High means a volatile lot. */
  spreadPct?: number
  changes: Change[]
  note?: string
}

interface AirportResult {
  code: string
  outcomes: LotOutcome[]
  bumped: boolean
  priced: number
  /** Lots matched in at least one live sample (name, address or fuzzy). The coverage denominator. */
  present: number
  verified: number
  /** Lots absent from every sample — marked sellable:false. */
  absent: number
}

/**
 * The date rule, pure so it can be tested. Re-date only when at least one lot is present
 * in live search and verified/present reaches minCoverage (default 1 = every present lot).
 * Absent lots are not in the denominator; fuzzy-skipped / implausible / unpriced are.
 */
export function coverageDecision(
  outcomes: Pick<LotOutcome, 'status'>[],
  minCoverage = 1
): { present: number; verified: number; absent: number; bump: boolean } {
  let present = 0
  let verified = 0
  let absent = 0
  for (const o of outcomes) {
    if (o.status === 'absent') {
      absent++
      continue
    }
    present++
    if (o.status === 'updated' || o.status === 'unchanged') verified++
  }
  return { present, verified, absent, bump: present > 0 && verified / present >= minCoverage }
}

// ── text normalisation ───────────────────────────────────────────────────────
// Catalogue and live names share a convention ("Safe Park (JFK)"), because the
// newer airport files were captured from this same API. Stripping the airport
// parenthetical and punctuation matches 9/9 JFK lots and 8/9 LGA lots exactly.
const STOP = new Set(['airport', 'parking', 'lot', 'the', 'by', 'at', 'and', 'a', 'of', 'inc', 'llc'])

function normName(n: string): string {
  return n
    .toLowerCase()
    .replace(/\([a-z]{3}\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

function nameTokens(n: string): Set<string> {
  return new Set(normName(n).split(' ').filter((t) => t && !STOP.has(t)))
}

/** House number + first street tokens — enough to identify, loose enough to survive formatting. */
function normAddress(a: unknown): string | null {
  if (typeof a !== 'string' || !a.trim()) return null
  const t = a.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean)
  return t.length ? t.slice(0, 3).join(' ') : null
}

function dice(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter++
  return (2 * inter) / (a.size + b.size)
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// ── surgical writing ─────────────────────────────────────────────────────────
//
// These files are hand-formatted: arrays of primitives sit on one line, and small
// objects like runwayDetails are inlined too. `JSON.stringify(data, null, 2)` throws
// all of that away — re-serialising JFK to change 9 prices produced a 398-line diff
// with the 9 real changes buried in it. Since the whole point of a rate refresh is
// that somebody can review what moved, we edit the touched values IN PLACE and leave
// every other byte of the file alone. writeSurgically() refuses to write unless the
// result parses back to exactly the object we intended, so the string surgery cannot
// silently corrupt a file.

/** Walk `text` from `from`, returning the index just past the value starting there. */
function endOfValue(text: string, from: number): number {
  let i = from
  while (i < text.length && /\s/.test(text[i])) i++
  const c = text[i]
  if (c === '"') {
    i++
    while (i < text.length) {
      if (text[i] === '\\') i += 2
      else if (text[i] === '"') return i + 1
      else i++
    }
    return i
  }
  if (c === '{' || c === '[') {
    let depth = 0
    let inStr = false
    for (; i < text.length; i++) {
      const ch = text[i]
      if (inStr) {
        if (ch === '\\') i++
        else if (ch === '"') inStr = false
        continue
      }
      if (ch === '"') inStr = true
      else if (ch === '{' || ch === '[') depth++
      else if (ch === '}' || ch === ']') {
        depth--
        if (depth === 0) return i + 1
      }
    }
    return i
  }
  while (i < text.length && !/[,}\]\s]/.test(text[i])) i++
  return i
}

/** Spans of the top-level elements of the root-level array named `key`. */
function arrayElementSpans(text: string, key: string): { start: number; end: number }[] {
  const m = new RegExp(`"${key}"\\s*:\\s*\\[`).exec(text)
  if (!m) return []
  let i = m.index + m[0].length
  const spans: { start: number; end: number }[] = []
  for (;;) {
    while (i < text.length && /[\s,]/.test(text[i])) i++
    if (i >= text.length || text[i] === ']') break
    const end = endOfValue(text, i)
    spans.push({ start: i, end })
    i = end
  }
  return spans
}

/** Replace `"key": <value>` inside [start,end), or return null if the key is absent. */
function replaceInSpan(text: string, start: number, end: number, key: string, json: string): string | null {
  const slice = text.slice(start, end)
  const m = new RegExp(`("${key}"\\s*:\\s*)`).exec(slice)
  if (!m) return null
  const vStart = start + m.index + m[1].length
  const vEnd = endOfValue(text, vStart)
  return text.slice(0, vStart) + json + text.slice(vEnd)
}

/**
 * Remove `"key": <value>` from the object spanning [start,end), taking the comma that
 * separates it from its neighbour with it. Returns null if the key is not present.
 */
function removeInSpan(text: string, start: number, end: number, key: string): string | null {
  const slice = text.slice(start, end)
  const m = new RegExp(`("${key}"\\s*:\\s*)`).exec(slice)
  if (!m) return null
  const kStart = start + m.index
  const vEnd = endOfValue(text, kStart + m[1].length)
  // Prefer eating the comma (and whitespace) that follows; else the one that precedes.
  const after = /^\s*,/.exec(text.slice(vEnd, end))
  if (after) return text.slice(0, kStart) + text.slice(vEnd + after[0].length).replace(/^\s*/, (ws) => ws)
  let b = kStart - 1
  while (b > start && /\s/.test(text[b])) b--
  if (text[b] === ',') return text.slice(0, b) + text.slice(vEnd)
  return text.slice(0, kStart) + text.slice(vEnd)
}

/**
 * Add `"key": <value>` as the last member of the object spanning [start,end),
 * matching however that object is already laid out — one-per-line or inlined.
 */
function insertInSpan(text: string, start: number, end: number, key: string, json: string): string {
  const close = text.lastIndexOf('}', end - 1)
  let lastNonWs = close - 1
  while (lastNonWs > start && /\s/.test(text[lastNonWs])) lastNonWs--

  // If the closing brace sits at the start of its own line, the object is expanded
  // and the new member goes on its own line one level deeper. Otherwise it is inlined.
  const lineStart = text.lastIndexOf('\n', close - 1) + 1
  const beforeClose = text.slice(lineStart, close)
  const expanded = /^\s*$/.test(beforeClose)
  const tail = expanded ? `,\n${beforeClose}  "${key}": ${json}\n${beforeClose}` : `, "${key}": ${json} `
  return text.slice(0, lastNonWs + 1) + tail + text.slice(close)
}

/**
 * Apply per-lot field changes and (optionally) lastVerified to the file's raw text,
 * then verify the result parses to `expected` before returning it. Returns null if
 * the surgery did not reproduce the intended object — the caller must not write.
 */
function writeSurgically(
  text: string,
  edits: { lotIndex: number; field: string; value: unknown }[],
  newLastVerified: string | null,
  expected: unknown
): string | null {
  const spans = arrayElementSpans(text, 'parkingLots')
  let out = text
  // Last lot first so earlier spans keep their offsets.
  const byLot = new Map<number, { field: string; value: unknown }[]>()
  for (const e of edits) {
    if (!byLot.has(e.lotIndex)) byLot.set(e.lotIndex, [])
    byLot.get(e.lotIndex)!.push({ field: e.field, value: e.value })
  }
  for (const idx of [...byLot.keys()].sort((a, b) => b - a)) {
    const span = spans[idx]
    if (!span) return null
    // Each edit changes the string's length, so this lot's end offset moves with it.
    // Lots are processed last-first, which keeps every *earlier* span valid — but the
    // one being edited has to be re-measured after every write, or the next insert
    // searches backwards past the lot and lands in the preceding object.
    let end = span.end
    for (const { field, value } of byLot.get(idx)!) {
      const before = out.length
      if (value === undefined) {
        // A deletion: the lot no longer carries this field. Skipping it here is what
        // made the reproduction check fail on every file with a stale rateSpreadPct.
        const removed = removeInSpan(out, span.start, end, field)
        if (removed !== null) out = removed
        end += out.length - before
        continue
      }
      const json = JSON.stringify(value)
      const replaced = replaceInSpan(out, span.start, end, field, json)
      out = replaced !== null ? replaced : insertInSpan(out, span.start, end, field, json)
      end += out.length - before
    }
  }
  if (newLastVerified) {
    const m = /("lastVerified"\s*:\s*)/.exec(out)
    if (!m) return null
    const vStart = m.index + m[1].length
    out = out.slice(0, vStart) + JSON.stringify(newLastVerified) + out.slice(endOfValue(out, vStart))
  }
  try {
    const got = JSON.stringify(JSON.parse(out))
    const want = JSON.stringify(expected)
    if (got !== want) {
      let i = 0
      while (i < got.length && i < want.length && got[i] === want[i]) i++
      console.log(`     surgery mismatch at char ${i}:`)
      console.log(`       wanted …${want.slice(Math.max(0, i - 70), i + 70)}`)
      console.log(`       got    …${got.slice(Math.max(0, i - 70), i + 70)}`)
      return null
    }
  } catch (e) {
    console.log(`     surgery produced invalid JSON: ${(e as Error).message}`)
    return null
  }
  return out
}

// ── the live call ────────────────────────────────────────────────────────────

/**
 * Price one airport for a stay of exactly `days` ResLab days (= days-1 nights).
 * Returns null when the response is unusable — the caller must then leave the file
 * alone rather than write a partial refresh.
 */
async function fetchLive(code: string, days: number, leadDays: number): Promise<LiveLot[] | null> {
  const lead = Math.min(leadDays, MAX_ADVANCE_BOOKING_DAYS - (days - 1))
  if (lead < 1) {
    console.log(`  ! ${code}: a ${days}-day stay does not fit inside the ${MAX_ADVANCE_BOOKING_DAYS}-day booking window`)
    return null
  }
  const checkin = new Date(Date.now() + lead * 86_400_000)
  const checkout = new Date(checkin.getTime() + (days - 1) * 86_400_000)

  const url =
    `${SITE}/api/search?airport=${encodeURIComponent(code)}` +
    `&checkin=${iso(checkin)}&checkout=${iso(checkout)}` +
    `&checkinTime=${encodeURIComponent('10:00 AM')}&checkoutTime=${encodeURIComponent('2:00 PM')}` +
    `&sort=price_asc`

  let res: Response
  try {
    res = await fetch(url, { headers: { accept: 'application/json' } })
  } catch (e) {
    console.log(`  ! ${code}: request failed — ${(e as Error).message}`)
    return null
  }
  if (!res.ok) {
    // 503 here is the documented upstream failure: ResLab could price nothing.
    console.log(`  ! ${code}: HTTP ${res.status} for ${iso(checkin)} to ${iso(checkout)} — not writing`)
    return null
  }

  const body = (await res.json()) as SearchResponse
  if (body.degraded || body.stale || body.listIncomplete) {
    console.log(
      `  ! ${code}: response flagged degraded=${body.degraded} stale=${body.stale} ` +
        `listIncomplete=${body.listIncomplete} — refusing to write from a partial result`
    )
    return null
  }
  return body.results ?? []
}

// ── matching ─────────────────────────────────────────────────────────────────

function findMatch(
  lot: CatalogueLot,
  live: LiveLot[]
): { live: LiveLot; via: 'name' | 'address' | 'fuzzy'; score: number } | null {
  const key = normName(lot.name)
  const exact = live.find((r) => normName(r.name) === key)
  if (exact) return { live: exact, via: 'name', score: 1 }

  const addr = normAddress(lot.address)
  if (addr) {
    const byAddr = live.find((r) => normAddress(r.address) === addr)
    if (byAddr) return { live: byAddr, via: 'address', score: 1 }
  }

  const toks = nameTokens(lot.name)
  let best: LiveLot | null = null
  let bestScore = 0
  for (const r of live) {
    const s = dice(toks, nameTokens(r.name))
    if (s > bestScore) {
      bestScore = s
      best = r
    }
  }
  if (best && bestScore >= FUZZY_THRESHOLD) return { live: best, via: 'fuzzy', score: bestScore }
  return null
}

/** The N in this lot's totalFor<N>Days, if it has one. */
function lotDays(lot: CatalogueLot): number | null {
  for (const k of Object.keys(lot)) {
    const m = /^totalFor(\d+)Days$/.exec(k)
    if (m) return Number(m[1])
  }
  return null
}

// ── per-airport refresh ──────────────────────────────────────────────────────

async function refreshAirport(
  code: string,
  opts: {
    apply: boolean
    acceptFuzzy: boolean
    leadDays: number
    defaultDays: number
    samples: number
    minCoverage: number
  }
): Promise<AirportResult | null> {
  const file = path.join(DATA_DIR, `${code}.json`)
  if (!fs.existsSync(file)) {
    console.log(`  ! ${code}: no data file`)
    return null
  }
  const raw = fs.readFileSync(file, 'utf-8')
  const data = JSON.parse(raw) as Record<string, unknown>
  const lots = (data.parkingLots as CatalogueLot[] | undefined) ?? []
  if (!lots.length) {
    console.log(`  · ${code}: no parkingLots`)
    return null
  }

  // One live call per distinct stay length this file needs — the daily rate
  // genuinely differs by length of stay, so a lot must be priced at its own N —
  // times one call per sampled check-in date, because the rate also moves with demand.
  const needed = new Set<number>([opts.defaultDays])
  for (const l of lots) {
    const n = lotDays(l)
    if (n) needed.add(n)
  }

  const leads: number[] = []
  for (let i = 0; i < opts.samples; i++) leads.push(opts.leadDays + i * SAMPLE_SPACING_DAYS)

  // byDays[N] = one live result-set per sampled check-in date.
  const byDays = new Map<number, LiveLot[][]>()
  for (const n of [...needed].sort((a, b) => a - b)) {
    const perSample: LiveLot[][] = []
    for (const lead of leads) {
      const live = await fetchLive(code, n, lead)
      if (live === null) return null // any bad response aborts the whole airport
      perSample.push(live)
      await sleep(SLEEP_MS)
    }
    byDays.set(n, perSample)
  }

  const today = iso(new Date())
  const outcomes: LotOutcome[] = []
  const edits: { lotIndex: number; field: string; value: unknown }[] = []
  let priced = 0
  let verified = 0

  // Record whether the lot is something we actually sell. Only on a confident answer:
  // absent from every sample -> false; exact name/address match -> true. A fuzzy match
  // leaves the field alone — we do not know it is the same lot.
  const markSellable = (lotIndex: number, lot: CatalogueLot, sellable: boolean): Change[] => {
    const out: Change[] = []
    const pairs: [string, unknown][] = [
      ['sellable', sellable],
      ['sellableCheckedOn', today],
    ]
    for (const [field, value] of pairs) {
      if (lot[field] === value) continue
      out.push({ field, from: lot[field], to: value })
      lot[field] = value
      edits.push({ lotIndex, field, value })
    }
    return out
  }

  for (const [lotIndex, lot] of lots.entries()) {
    const n = lotDays(lot) ?? opts.defaultDays
    const perSample = byDays.get(n) ?? []
    if (typeof lot.dailyRate === 'number') priced++

    // Match in each sample independently, then reduce. A lot can be missing from one
    // sample (sold out that week) and present in others — that is not an absence.
    const matches = perSample
      .map((live) => findMatch(lot, live))
      .filter((x): x is NonNullable<typeof x> => x !== null)

    if (!matches.length) {
      outcomes.push({ lot: lot.name, status: 'absent', changes: markSellable(lotIndex, lot, false) })
      continue
    }
    const m = matches[0]
    const seen = m.via !== 'fuzzy' ? markSellable(lotIndex, lot, true) : []
    const priceable = matches.filter(
      (x) => x.live.pricing && typeof x.live.pricing.minPrice === 'number' && x.live.pricing.numberOfDays
    )
    if (!priceable.length) {
      outcomes.push({ lot: lot.name, status: 'unpriced', via: m.via, matched: m.live.name, changes: seen })
      continue
    }
    if (m.via === 'fuzzy' && !opts.acceptFuzzy) {
      outcomes.push({
        lot: lot.name,
        status: 'fuzzy-skipped',
        via: 'fuzzy',
        matched: m.live.name,
        score: round2(m.score),
        changes: [],
        note: 'run with --accept-fuzzy to apply, after checking these are the same lot',
      })
      continue
    }

    // Take the MEDIAN sample whole, rather than averaging the fields separately —
    // that keeps dailyRate * N + taxes == total instead of blending two dates into
    // a row that is internally inconsistent.
    const sorted = [...priceable].sort((a, b) => a.live.pricing!.minPrice! - b.live.pricing!.minPrice!)
    const p = sorted[Math.floor((sorted.length - 1) / 2)].live.pricing!
    const rates = sorted.map((x) => x.live.pricing!.minPrice!)
    const lo = rates[0]
    const hi = rates[rates.length - 1]
    const spreadPct = lo > 0 ? round2((100 * (hi - lo)) / lo) : 0

    const newDaily = round2(p.minPrice!)
    const old = lot.dailyRate
    if (typeof old === 'number' && old > 0) {
      const ratio = newDaily / old
      if (ratio > MAX_PLAUSIBLE_RATIO || ratio < 1 / MAX_PLAUSIBLE_RATIO) {
        outcomes.push({
          lot: lot.name,
          status: 'implausible',
          via: m.via,
          matched: m.live.name,
          changes: [...seen, { field: 'dailyRate', from: old, to: newDaily }],
          note: `${ratio.toFixed(2)}x move — looks like a bad match, not a price change`,
        })
        continue
      }
    }

    const changes: Change[] = [...seen]
    const set = (field: string, value: unknown) => {
      if (lot[field] === value) return
      changes.push({ field, from: lot[field], to: value })
      lot[field] = value
      edits.push({ lotIndex, field, value })
    }

    set('dailyRate', newDaily)
    // Only maintain the totals a lot already carries — N varies per lot (4/6/7/8)
    // and inventing them for the other 186 lots would change the schema silently.
    if (lotDays(lot) !== null) {
      if (typeof p.grandTotal === 'number') set(`totalFor${n}Days`, round2(p.grandTotal))
      if (typeof p.taxTotal === 'number') set(`taxesFor${n}Days`, round2(p.taxTotal))
    }
    if (typeof lot.reservationRate === 'number') set('reservationRate', newDaily)
    if (typeof m.live.dueAtLocation === 'boolean') {
      set('paymentMethod', m.live.dueAtLocation ? 'Pay at Location' : 'Pay Online')
    }
    set('rateVerified', today)
    // Kept on the lot when it is meaningful, so a volatile rate is visible in the data
    // rather than only in this run's log. A writer quoting it can hedge accordingly.
    if (spreadPct >= 15) set('rateSpreadPct', spreadPct)
    else if ('rateSpreadPct' in lot) set('rateSpreadPct', undefined)

    verified++
    outcomes.push({
      lot: lot.name,
      status: changes.length ? 'updated' : 'unchanged',
      via: m.via,
      matched: m.live.name,
      score: round2(m.score),
      samples: rates.length,
      spreadPct,
      changes,
    })
  }

  // The rule that keeps this honest: a partial refresh must NOT look like a fresh file.
  // Since 2026-09-28 "the file" means the lots PRESENT in live search — see coverageDecision.
  //
  // `--min-coverage` exists for one real case, and should be used knowingly. LGA verifies
  // 8 of 9: the only miss, "Park N Depart", has left live inventory altogether, so its
  // stored price can never be re-verified and LGA would stay blocked by the guard forever
  // over a lot we cannot sell. Lowering the bar says "I accept that N% of this file's
  // prices are older than the date on it" — which is a judgement about publishing, not a
  // detail of the script. Default is 1: every priced lot, or the date does not move.
  const cov = coverageDecision(outcomes, opts.minCoverage)
  const full = cov.bump
  if (full) {
    data.lastVerified = today
    if (cov.verified < cov.present) {
      console.log(
        `  ⚠ ${code}: dating the file today on ${cov.verified}/${cov.present} present lots (--min-coverage ` +
          `${opts.minCoverage}). ${cov.present - cov.verified} present lot price(s) remain unverified.`
      )
    }
  }

  if (opts.apply && (edits.length || full)) {
    const next = writeSurgically(raw, edits, full ? today : null, data)
    if (next === null) {
      // Never fall back to a whole-file re-serialise. That reformats these hand-laid-out
      // files and buries the handful of real price changes in hundreds of lines of
      // incidental diff — which defeats the review this whole job exists to enable.
      console.log(`  ! ${code}: in-place edit did not reproduce the file exactly — NOT written`)
      return { code, outcomes, bumped: false, priced, present: cov.present, verified, absent: cov.absent }
    }
    fs.writeFileSync(file, next, 'utf-8')
  }

  return { code, outcomes, bumped: full, priced, present: cov.present, verified, absent: cov.absent }
}

// ── reporting ────────────────────────────────────────────────────────────────

function printAirport(r: AirportResult, apply: boolean): void {
  const pct = r.present ? Math.round((100 * r.verified) / r.present) : 0
  const bump = r.bumped
    ? 'lastVerified -> today'
    : r.present === 0
      ? 'lastVerified UNCHANGED (no catalogued lot is in live search)'
      : `lastVerified UNCHANGED (only ${r.verified}/${r.present} present lots verified)`
  console.log(
    `\n${r.code}  ${r.verified}/${r.present} present lots verified (${pct}%), ${r.absent} absent -> sellable:false  ` +
      `${bump}${apply ? '' : '  [dry run]'}`
  )
  for (const o of r.outcomes) {
    if (o.status === 'updated') {
      const d = o.changes.find((c) => c.field === 'dailyRate')
      const move =
        d && typeof d.from === 'number' && typeof d.to === 'number'
          ? `  $${d.from} -> $${d.to} (${(((d.to - d.from) / d.from) * 100).toFixed(1)}%)`
          : ''
      const vol = o.spreadPct && o.spreadPct >= 15 ? `  ⚠ varies ${o.spreadPct}% by date` : ''
      console.log(`   ✓ ${o.lot}${move}  [${o.via}, ${o.samples} samples]${vol}`)
    } else if (o.status === 'unchanged') {
      console.log(`   = ${o.lot}  no change  [${o.via}]`)
    } else if (o.status === 'fuzzy-skipped') {
      console.log(`   ? ${o.lot}  ~ "${o.matched}" (${o.score}) — SKIPPED, ${o.note}`)
    } else if (o.status === 'implausible') {
      console.log(`   ! ${o.lot}  REFUSED — ${o.note}`)
    } else if (o.status === 'unpriced') {
      console.log(`   · ${o.lot}  matched "${o.matched}" but it returned no price`)
    } else {
      const marked = o.changes.some((c) => c.field === 'sellable') ? ' — marking sellable:false' : ' — already sellable:false'
      console.log(`   · ${o.lot}  not in live inventory (not removed)${marked}`)
    }
  }
}

// ── entry point ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const flag = (n: string) => argv.includes(n)
  const value = (n: string) => {
    const i = argv.indexOf(n)
    return i >= 0 ? argv[i + 1] : undefined
  }

  const apply = flag('--apply')
  const acceptFuzzy = flag('--accept-fuzzy')
  const coverageOnly = flag('--coverage')
  const leadDays = Number(value('--lead') ?? DEFAULT_LEAD_DAYS)
  const defaultDays = Number(value('--days') ?? DEFAULT_DAYS)
  const samples = Math.max(1, Number(value('--samples') ?? DEFAULT_SAMPLES))
  const minCoverage = Math.min(1, Math.max(0, Number(value('--min-coverage') ?? 1)))
  const only = (value('-a') ?? value('--airport'))?.toUpperCase()

  const codes = only
    ? [only]
    : fs
        .readdirSync(DATA_DIR)
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.replace(/\.json$/, ''))
        .sort()

  console.log(`refresh-rates — ${codes.length} airport(s) via ${SITE}/api/search`)
  console.log(
    `  stay ${defaultDays} day(s), ${samples} check-in date(s) from +${leadDays}d every ${SAMPLE_SPACING_DAYS}d (median wins), ` +
      `${apply && !coverageOnly ? 'APPLYING' : 'DRY RUN (pass --apply to write)'}`
  )
  if (coverageOnly) console.log('  --coverage: reporting only, nothing will be written')

  const all: AirportResult[] = []
  for (const code of codes) {
    const r = await refreshAirport(code, { apply: apply && !coverageOnly, acceptFuzzy, leadDays, defaultDays, samples, minCoverage })
    if (r) {
      all.push(r)
      printAirport(r, apply && !coverageOnly)
    }
  }

  const present = all.reduce((a, r) => a + r.present, 0)
  const verified = all.reduce((a, r) => a + r.verified, 0)
  const absent = all.reduce((a, r) => a + r.absent, 0)
  const bumped = all.filter((r) => r.bumped)
  console.log(`\n─── summary ───`)
  console.log(
    `  ${verified}/${present} present lots re-verified (${present ? Math.round((100 * verified) / present) : 0}%), ` +
      `${absent} absent lots -> sellable:false`
  )
  console.log(
    `  ${bumped.length}/${all.length} airports re-dated${bumped.length ? ` -> ${bumped.map((b) => b.code).join(', ')}` : ''}`
  )
  const stuck = all.filter((r) => !r.bumped).map((r) => `${r.code} ${r.verified}/${r.present}`)
  if (stuck.length) console.log(`  still stale (present lots not all verified, or none present): ${stuck.join(', ')}`)
  if (!apply || coverageOnly) console.log(`  nothing was written — re-run with --apply`)

  fs.mkdirSync(REPORTS_DIR, { recursive: true })
  const out = path.join(REPORTS_DIR, `rate-refresh-${iso(new Date())}.json`)
  fs.writeFileSync(
    out,
    JSON.stringify({ generatedAt: new Date().toISOString(), site: SITE, applied: apply && !coverageOnly, airports: all }, null, 2)
  )
  console.log(`  report: ${path.relative(process.cwd(), out)}`)
}

// Only run when invoked as a script, so tests can import coverageDecision without a live fetch.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
