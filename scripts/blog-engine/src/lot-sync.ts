/**
 * lot-sync.ts — make data/airports/<CODE>.json list the lots we actually SELL.
 *
 * WHY THIS EXISTS
 * refresh-rates only re-prices lots that are already in a file. Lots that joined ResLab
 * after a file was written never get in, and a lot whose listing name drifted from the
 * file's name ("Apex EWR Airport Parking" vs the live "Apex Airport Parking") is judged
 * absent and marked sellable:false. Measured 2026-11-05 (notes/live-price-check-2026-11-06):
 * EWR sold 12 lots while its file had 2 sellable; JFK's cheapest lot (The Parking Point,
 * $9.95) was missing; ORD was missing 5; DFW's Red Roof Inn was wrongly unsellable.
 *
 * WHAT IT DOES (per airport, sequentially, at most 3 search calls)
 *   1. Pulls the live list from our own public search API (the same call refresh-rates makes).
 *   2. Matches every file lot to a live lot, strongest evidence first, one-to-one:
 *        STRONG (applied): ResLab id -> slug -> normalised name
 *        WEAK (reported for a human to confirm; applied only with --accept-fuzzy): unique street address
 *        (unique among live AND file lots) -> same name tokens (airport code and filler words removed) ->
 *        one name's tokens inside the other's (2+ tokens, unambiguous both ways) -> fuzzy. LAS "Best Western
 *        McCarran Inn" subset-matched the live "Best Western" (a different hotel) — that is why weak matches
 *        write nothing. An address is weak because one street can host two products (SAN's Aladdin Airport
 *        and Aladdin Port Parking; EWR's Apex and EWR Airport Parking): with one sold out on both dates, the
 *        other would inherit its id and price (review of #160).
 *        ID CONFLICT: a lot that already has a ResLab id is never re-pointed to a different id by a slug /
 *        name / address / token match — not even with --accept-fuzzy. It is reported; a human edits the id.
 *   3. Diffs: live lots missing from the file (added), file lots gone from search (marked
 *      sellable:false — never deleted, history kept — and only when missing on 2+ check-in dates AND no
 *      live lot is even a weak candidate for it: a lot that lost an ambiguous match is reported, not gone),
 *      sellable flips. A match whose price moved >3x writes nothing at all.
 *   4. --apply writes the file in place (same surgical writer as refresh-rates, so the diff
 *      shows only what changed) and refuses to write unless the result parses back exactly.
 *
 * PRICES BELONG TO refresh-rates. A lot already in the file keeps its dailyRate / totals / rateVerified: refresh-rates
 * prices on the median of 3 check-in dates and tracks rateSpreadPct, and one search date can be a holiday (the first
 * run priced a stay starting the day after Thanksgiving). A live price that differs is reported ("run refresh-rates").
 * Only a lot with no dailyRate (an added lot, or an old entry without one) is priced here. Run refresh-rates after
 * an --apply.
 *
 * PRICE BASIS for those: the files' own. dailyRate = pricing.minPrice ((subtotal + fees) / days, pre-tax),
 * for a stay of the lot's own N days when it carries totalFor<N>Days, else DEFAULT_DAYS (7),
 * 10:00 AM -> 2:00 PM, exactly like refresh-rates. Call 1 prices the default stay; if the file
 * prices some lots at another N, call 2 prices that N on the same date; the last call is always
 * the default stay on a second check-in date, which only widens presence: a lot sold out on one
 * date is not "gone". Pick a --lead whose two dates avoid holiday weeks.
 *
 * WHAT IT WILL NOT DO
 *  - Invent fields. An added lot carries only what search returns (name, slug, ResLab id,
 *    address, distance, phone, shuttle summary, amenities, minimum stay, payment method,
 *    dailyRate) plus `needsReview`, naming what a human still has to fill (parkingType,
 *    driveTime, overview). Unknown stays absent.
 *  - Move the file-level `lastVerified`. That date also covers on-airport rates and the
 *    3-date median refresh-rates takes; one or two search calls do not verify those.
 *    Per-lot `rateVerified` / `sellableCheckedOn` record what this run checked.
 *  - Write from a degraded/stale/incomplete, ownAirportFallback, one-source-failed (reslabUnavailable /
 *    directUnavailable), wrong-currency or empty response (refresh-rates unusableReason), or create a missing file
 *    (`npm run bootstrap` makes new airports; this reports what live search shows instead).
 *  - Write from anything but production (TRIPLY_SITE_URL is for dry runs: staging uses a separate ResLab account).
 *  - Add lots another airport's search owns. NOTE: production stamps EVERY result with the searched
 *    airport's code (search.ts), so the `airportCode` check below is only a guard; the real protection
 *    is refusing `ownAirportFallback` responses (fetchLive), the only time other airports' lots appear.
 *  - Put a cruise/downtown lot on airport content: a new lot named "cruise"/"port(s)", or with no shuttle and >5 mi
 *    out, gets NOT_AIRPORT_NOTE. On an airport (not cruise-port) file, loadAirportData and monthly-prices then leave it
 *    out entirely until a human removes the note (airport-data.ts airportPageLots).
 *
 * CLI:
 *   npm run lot-sync                         # every airport file, dry run
 *   npm run lot-sync -- -a EWR               # one airport (works for a code with no file: report only)
 *   npm run lot-sync -- --apply              # write
 *   npm run lot-sync -- --lead 35 --md ../notes/SYNC.md
 *   npm run lot-sync -- --accept-fuzzy       # also apply weak (tokens/subset/fuzzy) matches, id included (check them first)
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import {
  DEFAULT_DAYS,
  DEFAULT_LEAD_DAYS,
  FUZZY_THRESHOLD,
  MAX_PLAUSIBLE_RATIO,
  SITE,
  SLEEP_MS,
  applyLotEdits,
  arrayElementSpans,
  dice,
  endOfValue,
  fetchLive,
  iso,
  lotDays,
  nameTokens,
  nonProductionReason,
  normName,
  reproduces,
  round2,
  sleep,
  effectiveLead,
  type CatalogueLot,
  type LiveLot,
  type LivePricing,
} from './refresh-rates.js'
import { NOT_AIRPORT_NOTE } from './airport-data.js'

export { NOT_AIRPORT_NOTE }

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.resolve(__dirname, '..', 'data', 'airports')
const REPORTS_DIR = path.resolve(__dirname, '..', 'reports')

/** Days between the two check-in dates when the second call is a presence check. */
const SECOND_SAMPLE_SPACING_DAYS = 12

/** The fields of a live search result lot-sync reads. */
export interface SyncLive extends LiveLot {
  id?: string
  source?: string
  airportCode?: string
  phone?: string | null
  shuttleInfo?: { summary?: string | null } | string | null
  amenities?: { displayName?: string; name?: string }[] | null
  distanceFromAirport?: number | null
  minimumBookingDays?: number | null
}

/** One live lot, with its pricing per stay length (days -> pricing). */
export interface MergedLive {
  lot: SyncLive
  pricing: Map<number, LivePricing>
}

export type Via = 'id' | 'slug' | 'name' | 'address' | 'tokens' | 'subset' | 'fuzzy'

/** Matches strong enough to write `reslabLocationId` / `sellable` without a human. */
export const STRONG_VIA: ReadonlySet<Via> = new Set<Via>(['id', 'slug', 'name'])

export interface Match {
  live: number
  via: Via
  score: number
  /** The file lot already has a ResLab id and the matched live lot has a different one. Never applied. */
  idConflict: boolean
}

export interface Edit {
  lotIndex: number
  field: string
  value: unknown
}

export interface PriceChange {
  lot: string
  from: number | undefined
  to: number
  days: number
}

export interface SyncReport {
  code: string
  liveCount: number
  matched: { lot: string; live: string; via: Via }[]
  added: { name: string; dailyRate: number | null; days: number; availability?: string }[]
  gone: string[]
  flippedToSellable: string[]
  /** Prices WRITTEN: only lots that had no dailyRate. */
  priceChanges: PriceChange[]
  /** A live price that differs from the file's, NOT written — refresh-rates owns prices. */
  priceDrift: { lot: string; file: number; live: number; days: number }[]
  /** Weak (address/tokens/subset/fuzzy) matches NOT applied: a human confirms, then --accept-fuzzy. */
  needsConfirmation: { lot: string; live: string; via: Via; score: number }[]
  /** A lot whose file id differs from the id of the live lot its name/slug/address matched. Never applied. */
  idConflicts: { lot: string; fileId: number; live: string; liveId: number; via: Via }[]
  /** Unmatched, but a live lot is still a candidate at some tier (it lost an ambiguous match): reported, not gone. */
  ambiguous: { lot: string; live: string }[]
  /** Price moved >3x: nothing about the lot was written (not the id, not sellable). */
  implausible: { lot: string; from: number; to: number; via: Via }[]
  /** `reslabLocationId` written (or changed) by this run. */
  idSet: { lot: string; live: string; id: number; via: Via }[]
  /** Absent from search, but only checked on one check-in date: reported, NOT marked unsellable. */
  missingOneDate: string[]
  /** Lots given the NOT_AIRPORT_NOTE (cruise/downtown). */
  notAirport: string[]
  unpriced: { lot: string; days: number }[]
  collapsedDuplicates: string[]
  otherAirport: string[]
  notAdded: string[]
  note?: string
}

// ── normalisation ────────────────────────────────────────────────────────────

/** Name tokens without filler words or the airport's own code ("Apex EWR Airport Parking" -> {apex}). */
export function codeTokens(name: string, code: string): Set<string> {
  const t = nameTokens(name)
  t.delete(code.toLowerCase())
  return t
}

const STREET: Record<string, string> = {
  street: 'st', avenue: 'ave', av: 'ave', boulevard: 'blvd', road: 'rd', drive: 'dr', parkway: 'pkwy',
  highway: 'hwy', lane: 'ln', place: 'pl', court: 'ct', circle: 'cir', terrace: 'ter', expressway: 'expy',
  north: 'n', south: 's', east: 'e', west: 'w',
}

/**
 * House number + the next two tokens, with street words abbreviated, so "819 Spring Street"
 * and "819 Spring St." agree. refresh-rates' normAddress compares raw tokens and misses that.
 */
export function streetKey(a: unknown): string | null {
  if (typeof a !== 'string' || !a.trim()) return null
  const t = a
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map((w) => STREET[w] ?? w)
  if (!t.length || !/^\d/.test(t[0])) return null // no house number: too vague to identify a lot
  return t.slice(0, 3).join(' ')
}

/** One name's tokens contain the other's, and the smaller name still has 2+ tokens ("Red Roof Inn" in "Red Roof Inn Dallas North"). */
export function tokenSubset(a: Set<string>, b: Set<string>): boolean {
  const [small, big] = a.size <= b.size ? [a, b] : [b, a]
  if (small.size < 2) return false
  for (const x of small) if (!big.has(x)) return false
  return true
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size || !a.size) return false
  for (const x of a) if (!b.has(x)) return false
  return true
}

// ── live list ────────────────────────────────────────────────────────────────

/**
 * Union the samples into one list keyed by listing id. Drops lots another airport owns and
 * collapses a hotel listed twice under one name (BWI's Clarion has two ResLab ids) to the
 * cheaper listing, so it is neither added twice nor left "unmatched".
 */
export function mergeSamples(
  samples: { days: number; lots: SyncLive[] }[],
  code: string
): { live: MergedLive[]; collapsed: string[]; otherAirport: string[] } {
  const byKey = new Map<string, MergedLive>()
  const otherAirport = new Set<string>()
  for (const s of samples) {
    for (const lot of s.lots) {
      if (lot.airportCode && lot.airportCode.toUpperCase() !== code.toUpperCase()) {
        otherAirport.add(`${lot.name} (${lot.airportCode})`)
        continue
      }
      const key = lot.id ?? (typeof lot.reslabLocationId === 'number' ? `reslab-${lot.reslabLocationId}` : `name-${normName(lot.name)}`)
      let m = byKey.get(key)
      if (!m) {
        m = { lot, pricing: new Map() }
        byKey.set(key, m)
      }
      // First sample wins for a given stay length: the second date only widens presence.
      if (lot.pricing && typeof lot.pricing.minPrice === 'number' && !m.pricing.has(s.days)) m.pricing.set(s.days, lot.pricing)
    }
  }

  const byName = new Map<string, MergedLive[]>()
  for (const m of byKey.values()) {
    const k = normName(m.lot.name)
    if (!byName.has(k)) byName.set(k, [])
    byName.get(k)!.push(m)
  }
  const live: MergedLive[] = []
  const collapsed: string[] = []
  const cheapest = (m: MergedLive) => Math.min(...[...m.pricing.values()].map((p) => p.minPrice ?? Infinity), Infinity)
  for (const group of byName.values()) {
    if (group.length > 1) {
      group.sort((a, b) => cheapest(a) - cheapest(b))
      collapsed.push(`${group[0].lot.name} (listed ${group.length}x; kept the cheapest listing)`)
    }
    live.push(group[0])
  }
  return { live, collapsed, otherAirport: [...otherAirport] }
}

// ── matching ─────────────────────────────────────────────────────────────────

/**
 * One-to-one match of file lots to live lots, strongest evidence first across the WHOLE
 * file (so a weak match can never steal a live lot that another file lot owns by id/name).
 * Address and token matches must be unambiguous: two live lots at one address (EWR's Apex
 * and "EWR Airport Parking" share 819 Spring St) match neither by address, and neither do
 * two file lots at one address. A match below the id tier whose live id contradicts the file's
 * id is marked `idConflict` (planSync never applies it).
 */
export function matchLots(fileLots: CatalogueLot[], live: SyncLive[], code: string): Map<number, Match> {
  const out = new Map<number, Match>()
  const taken = new Set<number>()
  const free = (j: number) => !taken.has(j)
  const claim = (i: number, j: number, via: Via, score = 1) => {
    const fileId = fileLots[i].reslabLocationId
    const liveId = live[j].reslabLocationId
    out.set(i, { live: j, via, score, idConflict: typeof fileId === 'number' && typeof liveId === 'number' && fileId !== liveId })
    taken.add(j)
  }

  const liveTok = live.map((l) => codeTokens(l.name, code))
  const liveStreet = live.map((l) => streetKey(l.address))
  const streetCount = new Map<string, number>()
  for (const k of liveStreet) if (k) streetCount.set(k, (streetCount.get(k) ?? 0) + 1)
  const fileStreetCount = new Map<string, number>()
  for (const l of fileLots) {
    const k = streetKey(l.address)
    if (k) fileStreetCount.set(k, (fileStreetCount.get(k) ?? 0) + 1)
  }

  type Tier = (lot: CatalogueLot, i: number) => { j: number; score?: number } | null
  const unique = (pred: (j: number) => boolean): { j: number } | null => {
    const hits = live.map((_, j) => j).filter((j) => free(j) && pred(j))
    return hits.length === 1 ? { j: hits[0] } : null
  }
  const tiers: [Via, Tier][] = [
    ['id', (lot) => (typeof lot.reslabLocationId === 'number' ? unique((j) => live[j].reslabLocationId === lot.reslabLocationId) : null)],
    ['slug', (lot) => (typeof lot.slug === 'string' && lot.slug ? unique((j) => live[j].slug === lot.slug) : null)],
    ['name', (lot) => unique((j) => normName(live[j].name) === normName(lot.name))],
    [
      'address',
      (lot) => {
        const k = streetKey(lot.address)
        if (!k || streetCount.get(k) !== 1 || fileStreetCount.get(k) !== 1) return null
        return unique((j) => liveStreet[j] === k)
      },
    ],
    [
      'tokens',
      (lot) => {
        const t = codeTokens(lot.name, code)
        return unique((j) => setsEqual(t, liveTok[j]))
      },
    ],
    [
      // Unambiguous both ways: one live candidate, and no other unmatched file lot claims it.
      'subset',
      (lot, i) => {
        const t = codeTokens(lot.name, code)
        const hit = unique((j) => tokenSubset(t, liveTok[j]))
        if (!hit) return null
        const rival = fileLots.some((o, k) => k !== i && !out.has(k) && tokenSubset(codeTokens(o.name, code), liveTok[hit.j]))
        return rival ? null : hit
      },
    ],
    [
      'fuzzy',
      (lot) => {
        const t = codeTokens(lot.name, code)
        let best = -1
        let bestScore = 0
        let tie = false
        for (let j = 0; j < live.length; j++) {
          if (!free(j)) continue
          const s = dice(t, liveTok[j])
          if (s > bestScore) {
            bestScore = s
            best = j
            tie = false
          } else if (s === bestScore && s > 0) tie = true
        }
        return best >= 0 && !tie && bestScore >= FUZZY_THRESHOLD ? { j: best, score: bestScore } : null
      },
    ],
  ]

  for (const [via, tier] of tiers) {
    for (const [i, lot] of fileLots.entries()) {
      if (out.has(i)) continue
      const hit = tier(lot, i)
      if (hit) claim(i, hit.j, via, hit.score ?? 1)
    }
  }
  return out
}

/**
 * The first live lot that is a candidate for `lot` at ANY tier, ignoring which file lot claimed it — or null.
 * An unmatched lot with a candidate lost an ambiguous match ("Comfort Suites North" and "...South" vs one live
 * "Comfort Suites"): that is not evidence it is gone (review of #160).
 */
export function anyCandidate(lot: CatalogueLot, live: SyncLive[], code: string): SyncLive | null {
  const t = codeTokens(lot.name, code)
  const k = streetKey(lot.address)
  return (
    live.find((l) => {
      if (typeof lot.reslabLocationId === 'number' && l.reslabLocationId === lot.reslabLocationId) return true
      if (typeof lot.slug === 'string' && lot.slug && l.slug === lot.slug) return true
      if (normName(l.name) === normName(lot.name)) return true
      if (k && streetKey(l.address) === k) return true
      const lt = codeTokens(l.name, code)
      return setsEqual(t, lt) || tokenSubset(t, lt) || dice(t, lt) >= FUZZY_THRESHOLD
    }) ?? null
  )
}

// ── the plan ─────────────────────────────────────────────────────────────────

function shuttleSummary(s: SyncLive['shuttleInfo']): string | null {
  const raw = typeof s === 'string' ? s : s?.summary
  if (typeof raw !== 'string') return null
  const t = raw.replace(/\s+/g, ' ').trim()
  return t || null
}

/** A new file lot built ONLY from what live search returned, plus the review flag. */
export function newLotFromLive(m: MergedLive, days: number, today: string): CatalogueLot {
  const l = m.lot
  const p = m.pricing.get(days)
  const lot: CatalogueLot = { name: l.name }
  if (l.slug) lot.slug = l.slug
  if (typeof l.reslabLocationId === 'number') lot.reslabLocationId = l.reslabLocationId
  if (typeof l.address === 'string' && l.address.trim()) lot.address = l.address.trim()
  if (typeof l.distanceFromAirport === 'number') lot.distanceFromAirport = `${l.distanceFromAirport} mi`
  if (typeof l.phone === 'string' && l.phone.trim()) lot.phone = l.phone.trim()
  const shuttle = shuttleSummary(l.shuttleInfo)
  if (shuttle) lot.shuttleInfo = shuttle
  const amen = (l.amenities ?? []).map((a) => a.displayName || a.name).filter((x): x is string => !!x)
  if (amen.length) lot.amenities = amen
  if (typeof l.minimumBookingDays === 'number' && l.minimumBookingDays > 1) lot.minimumBookingDays = l.minimumBookingDays
  if (typeof l.dueAtLocation === 'boolean') lot.paymentMethod = l.dueAtLocation ? 'Pay at Location' : 'Pay Online'
  if (p && typeof p.minPrice === 'number') {
    lot.dailyRate = round2(p.minPrice)
    lot.rateVerified = today
  }
  lot.sellable = true
  lot.sellableCheckedOn = today
  lot.needsReview = `added by lot-sync ${today} from live search: parkingType, driveTime and overview not filled`
  return lot
}

/**
 * Why a lot looks like a cruise-port/downtown lot rather than an airport lot, or '' when it does not:
 * "cruise" or "port(s)" as a word in the name ("Airport" does not count), or no shuttle and more than 5 mi out.
 */
export function notAirportReason(lot: { name: string; shuttleInfo?: unknown; distanceFromAirport?: unknown }): string {
  if (/\bcruise\b|\bports?\b/i.test(lot.name)) return 'cruise/port name'
  const d = typeof lot.distanceFromAirport === 'number' ? lot.distanceFromAirport : parseFloat(String(lot.distanceFromAirport ?? ''))
  const shuttle = typeof lot.shuttleInfo === 'string' ? lot.shuttleInfo : ''
  const noShuttle = !shuttle.trim() || /^\s*no shuttle/i.test(shuttle)
  if (noShuttle && Number.isFinite(d) && d > 5) return `no shuttle, ${d} mi out`
  return ''
}

/** A lot lot-sync added that nobody has reviewed yet (its `needsReview` flag is still lot-sync's). */
function addedByLotSync(lot: CatalogueLot): boolean {
  return typeof lot.needsReview === 'string' && lot.needsReview.startsWith('added by lot-sync')
}

export function emptyReport(code: string, liveCount: number): SyncReport {
  return {
    code, liveCount, matched: [], added: [], gone: [], flippedToSellable: [], priceChanges: [], priceDrift: [],
    needsConfirmation: [], idConflicts: [], ambiguous: [], implausible: [], idSet: [], missingOneDate: [], notAirport: [],
    unpriced: [], collapsedDuplicates: [], otherAirport: [], notAdded: [],
  }
}

/**
 * The whole diff for one airport. Mutates `lots` the way --apply will change the file (so the
 * caller can verify the surgical write reproduces it) and returns the edits, the new lots and
 * the report. Pure apart from that: no I/O.
 *
 * `checkinDates` = how many distinct check-in dates the samples covered. A lot missing from
 * search is marked unsellable only when that is 2+ (one date can be a sell-out, not a delisting).
 */
export function planSync(
  code: string,
  lots: CatalogueLot[],
  merged: MergedLive[],
  opts: { today: string; defaultDays: number; acceptFuzzy: boolean; checkinDates: number }
): { edits: Edit[]; newLots: CatalogueLot[]; report: SyncReport } {
  const report = emptyReport(code, merged.length)
  const edits: Edit[] = []
  const newLots: CatalogueLot[] = []
  if (!merged.length) {
    report.note = 'live search returned no lots for this airport — nothing changed (an empty list is not evidence that every lot is gone)'
    return { edits, newLots, report }
  }

  const set = (i: number, field: string, value: unknown) => {
    if (lots[i][field] === value) return
    lots[i][field] = value
    edits.push({ lotIndex: i, field, value })
  }

  const liveLots = merged.map((m) => m.lot)
  const matches = matchLots(lots, liveLots, code)
  const reserved = new Set<number>()
  // Live lots another file lot owns on strong evidence can't make an unmatched lot "ambiguous".
  const strongClaimed = new Set([...matches.values()].filter((m) => STRONG_VIA.has(m.via) && !m.idConflict).map((m) => m.live))
  const unclaimedLive = liveLots.filter((_, j) => !strongClaimed.has(j))

  for (const [i, lot] of lots.entries()) {
    const m = matches.get(i)
    if (!m) {
      if (lot.sellable !== false) {
        const near = anyCandidate(lot, unclaimedLive, code)
        if (near) {
          report.ambiguous.push({ lot: lot.name, live: near.name })
        } else if (opts.checkinDates >= 2) {
          report.gone.push(lot.name)
          set(i, 'sellable', false)
          set(i, 'sellableCheckedOn', opts.today)
        } else {
          report.missingOneDate.push(lot.name)
        }
      }
      continue
    }
    const live = merged[m.live]
    reserved.add(m.live)
    if (m.idConflict) {
      // Never re-point an established id on name/slug/address evidence, --accept-fuzzy or not: from then on both tools
      // trust the id first, so a wrong one sticks (review of #160).
      report.idConflicts.push({ lot: lot.name, fileId: lot.reslabLocationId as number, live: live.lot.name, liveId: live.lot.reslabLocationId as number, via: m.via })
      continue
    }
    if (!STRONG_VIA.has(m.via) && !opts.acceptFuzzy) {
      report.needsConfirmation.push({ lot: lot.name, live: live.lot.name, via: m.via, score: round2(m.score) })
      continue
    }

    // Price sanity BEFORE any write: a >3x move says "probably not the same lot", so nothing is written.
    const n = lotDays(lot) ?? opts.defaultDays
    const p = live.pricing.get(n)
    const to = p && typeof p.minPrice === 'number' ? round2(p.minPrice) : null
    const from = typeof lot.dailyRate === 'number' ? lot.dailyRate : undefined
    if (to !== null && from && from > 0) {
      const ratio = to / from
      if (ratio > MAX_PLAUSIBLE_RATIO || ratio < 1 / MAX_PLAUSIBLE_RATIO) {
        report.implausible.push({ lot: lot.name, from, to, via: m.via })
        continue
      }
    }

    report.matched.push({ lot: lot.name, live: live.lot.name, via: m.via })
    if (lot.sellable !== true) report.flippedToSellable.push(lot.name)
    set(i, 'sellable', true)
    set(i, 'sellableCheckedOn', opts.today)
    if (typeof live.lot.reslabLocationId === 'number' && lot.reslabLocationId !== live.lot.reslabLocationId) {
      set(i, 'reslabLocationId', live.lot.reslabLocationId)
      report.idSet.push({ lot: lot.name, live: live.lot.name, id: live.lot.reslabLocationId, via: m.via })
    }
    // Lots an earlier run added and nobody reviewed get the same cruise/downtown check as new ones.
    const why = addedByLotSync(lot) && lot.notes === undefined ? notAirportReason(lot) : ''
    if (why) {
      set(i, 'notes', NOT_AIRPORT_NOTE)
      report.notAirport.push(`${lot.name} (${why})`)
    }

    if (typeof live.lot.dueAtLocation === 'boolean') set(i, 'paymentMethod', live.lot.dueAtLocation ? 'Pay at Location' : 'Pay Online')

    if (to === null || !p) {
      report.unpriced.push({ lot: lot.name, days: n })
      continue
    }
    // refresh-rates owns the price of a lot that has one (3-date median + rateSpreadPct); this run saw one date.
    if (from !== undefined) {
      if (from !== to) report.priceDrift.push({ lot: lot.name, file: from, live: to, days: n })
      continue
    }
    report.priceChanges.push({ lot: lot.name, from, to, days: n })
    set(i, 'dailyRate', to)
    if (lotDays(lot) !== null) {
      if (typeof p.grandTotal === 'number') set(i, `totalFor${n}Days`, round2(p.grandTotal))
      if (typeof p.taxTotal === 'number') set(i, `taxesFor${n}Days`, round2(p.taxTotal))
    }
    set(i, 'rateVerified', opts.today)
  }

  for (const [j, m] of merged.entries()) {
    if (reserved.has(j)) continue
    const p = m.pricing.get(opts.defaultDays)
    if (!p || typeof p.minPrice !== 'number') {
      // Only seen at another stay length: no price on this file's default basis, so not added.
      report.notAdded.push(`${m.lot.name} (no ${opts.defaultDays}-day price)`)
      continue
    }
    const lot = newLotFromLive(m, opts.defaultDays, opts.today)
    const why = notAirportReason(lot)
    if (why) {
      lot.notes = NOT_AIRPORT_NOTE
      report.notAirport.push(`${m.lot.name} (${why})`)
    }
    newLots.push(lot)
    report.added.push({ name: m.lot.name, dailyRate: (lot.dailyRate as number) ?? null, days: opts.defaultDays, availability: m.lot.availability })
  }
  return { edits, newLots, report }
}

// ── writing ──────────────────────────────────────────────────────────────────

/** Lay a lot out the way the hand-written files do: one key per line, primitive arrays inline. */
export function formatLot(lot: CatalogueLot, indent: string): string {
  const inner = indent + '  '
  const lines = Object.entries(lot).map(([k, v]) => {
    const val =
      Array.isArray(v) && v.every((x) => x === null || typeof x !== 'object')
        ? `[${v.map((x) => JSON.stringify(x)).join(', ')}]`
        : JSON.stringify(v)
    return `${inner}${JSON.stringify(k)}: ${val}`
  })
  return `${indent}{\n${lines.join(',\n')}\n${indent}}`
}

/** Append whole lots to the root-level parkingLots array, matching the existing indentation. */
export function appendLots(text: string, newLots: CatalogueLot[]): string | null {
  if (!newLots.length) return text
  const m = /"parkingLots"\s*:\s*\[/.exec(text)
  if (!m) return null
  const open = m.index + m[0].length - 1
  const close = endOfValue(text, open) - 1
  if (text[close] !== ']') return null
  const spans = arrayElementSpans(text, 'parkingLots')
  const keyLineStart = text.lastIndexOf('\n', m.index) + 1
  const keyIndent = /^\s*/.exec(text.slice(keyLineStart, m.index))![0]
  if (!spans.length) {
    const body = newLots.map((l) => formatLot(l, keyIndent + '  ')).join(',\n')
    return text.slice(0, open + 1) + '\n' + body + '\n' + keyIndent + text.slice(close)
  }
  const first = spans[0]
  const elIndent = /^\s*/.exec(text.slice(text.lastIndexOf('\n', first.start) + 1, first.start))![0]
  const last = spans[spans.length - 1]
  const body = newLots.map((l) => formatLot(l, elIndent)).join(',\n')
  return text.slice(0, last.end) + ',\n' + body + text.slice(last.end)
}

// ── per airport ──────────────────────────────────────────────────────────────

function mostCommonOtherDays(lots: CatalogueLot[], defaultDays: number): number | null {
  const c = new Map<number, number>()
  for (const l of lots) {
    const n = lotDays(l)
    if (n && n !== defaultDays) c.set(n, (c.get(n) ?? 0) + 1)
  }
  let best: number | null = null
  for (const [n, k] of c) if (best === null || k > c.get(best)!) best = n
  return best
}

/**
 * The search calls for one airport (<=3). Call 1: the default stay. Then the other stay length the file
 * prices at, on the SAME date, if any. Last: the default stay on a second check-in date, so a "gone"
 * verdict always rests on 2 distinct dates. With no file there is nothing to mark gone: one call.
 */
export function planCalls(
  lots: CatalogueLot[] | null,
  defaultDays: number,
  leadDays: number
): { calls: { days: number; lead: number }[]; checkinDates: number } {
  const calls: { days: number; lead: number }[] = [{ days: defaultDays, lead: leadDays }]
  if (lots) {
    const other = mostCommonOtherDays(lots, defaultDays)
    if (other) calls.push({ days: other, lead: leadDays })
    calls.push({ days: defaultDays, lead: leadDays + SECOND_SAMPLE_SPACING_DAYS })
  }
  return { calls, checkinDates: new Set(calls.map((c) => effectiveLead(c.days, c.lead))).size }
}

async function syncAirport(
  code: string,
  opts: { apply: boolean; acceptFuzzy: boolean; leadDays: number; defaultDays: number; today: string }
): Promise<{ report: SyncReport; written: boolean; hasFile: boolean } | null> {
  const file = path.join(DATA_DIR, `${code}.json`)
  const hasFile = fs.existsSync(file)
  const raw = hasFile ? fs.readFileSync(file, 'utf-8') : null
  const data = raw ? (JSON.parse(raw) as Record<string, unknown>) : null
  const lots = ((data?.parkingLots as CatalogueLot[] | undefined) ?? []) as CatalogueLot[]

  const { calls, checkinDates } = planCalls(hasFile ? lots : null, opts.defaultDays, opts.leadDays)
  const samples: { days: number; lots: SyncLive[] }[] = []
  for (const c of calls) {
    const live = await fetchLive(code, c.days, c.lead)
    await sleep(SLEEP_MS)
    if (live === null) return null // never act on part of an airport
    samples.push({ days: c.days, lots: live as SyncLive[] })
  }
  const { live, collapsed, otherAirport } = mergeSamples(samples, code)

  if (!hasFile || !data) {
    const report: SyncReport = {
      ...emptyReport(code, live.length),
      collapsedDuplicates: collapsed,
      otherAirport,
      added: live.map((m) => ({ name: m.lot.name, dailyRate: m.pricing.get(opts.defaultDays)?.minPrice != null ? round2(m.pricing.get(opts.defaultDays)!.minPrice!) : null, days: opts.defaultDays, availability: m.lot.availability })),
      note: `no data file — not created (new airports go through \`npm run bootstrap\`); "added" lists what live search sells`,
    }
    return { report, written: false, hasFile }
  }

  const { edits, newLots, report } = planSync(code, lots, live, { today: opts.today, defaultDays: opts.defaultDays, acceptFuzzy: opts.acceptFuzzy, checkinDates })
  report.collapsedDuplicates = collapsed
  report.otherAirport = otherAirport

  let written = false
  if (opts.apply && (edits.length || newLots.length)) {
    data.parkingLots = [...lots, ...newLots]
    const edited = applyLotEdits(raw!, edits, null)
    const next = edited === null ? null : appendLots(edited, newLots)
    if (next === null || !reproduces(next, data)) {
      report.note = 'in-place edit did not reproduce the intended file — NOT written'
    } else {
      fs.writeFileSync(file, next, 'utf-8')
      written = true
    }
  }
  return { report, written, hasFile }
}

// ── reporting ────────────────────────────────────────────────────────────────

const money = (n: number | null | undefined) => (typeof n === 'number' ? `$${n.toFixed(2)}` : '—')

export function reportLines(r: SyncReport): string[] {
  const out: string[] = []
  if (r.note) out.push(`- NOTE: ${r.note}`)
  for (const a of r.added) out.push(`- + added: ${a.name} ${money(a.dailyRate)}/day${a.availability && a.availability !== 'available' ? ` (${a.availability})` : ''}`)
  for (const f of r.flippedToSellable) out.push(`- ↑ now sellable: ${f}`)
  for (const g of r.gone) out.push(`- − gone from search -> sellable:false: ${g}`)
  for (const p of r.priceChanges) out.push(`- $ ${p.lot}: ${money(p.from)} -> ${money(p.to)}${p.days !== DEFAULT_DAYS ? ` (${p.days}-day basis)` : ''}`)
  for (const p of r.priceDrift) out.push(`- $~ ${p.lot}: file ${money(p.file)}, live ${money(p.live)}${p.days !== DEFAULT_DAYS ? ` (${p.days}-day basis)` : ''} — NOT written, run refresh-rates`)
  for (const g of r.missingOneDate) out.push(`- ~ missing from search on one check-in date only — NOT marked unsellable: ${g}`)
  for (const a of r.ambiguous) out.push(`- ? unmatched but live "${a.live}" could be it — NOT marked unsellable: "${a.lot}" (check by hand)`)
  for (const c of r.idConflicts) out.push(`- ! id conflict, NOT applied (even with --accept-fuzzy): "${c.lot}" has id ${c.fileId}; live "${c.live}" (matched by ${c.via}) has ${c.liveId} — fix the id by hand if it is the same lot`)
  for (const f of r.needsConfirmation) out.push(`- ? needs confirmation (${f.via}${f.via === 'fuzzy' ? ` ${f.score}` : ''}), NOT applied: "${f.lot}" ~ live "${f.live}" — check, then --accept-fuzzy`)
  for (const x of r.implausible) out.push(`- ! price refused, nothing written: ${x.lot} ${money(x.from)} -> ${money(x.to)} (>${MAX_PLAUSIBLE_RATIO}x move, matched by ${x.via})`)
  for (const x of r.idSet) out.push(`- # reslabLocationId ${x.id} set: "${x.lot}" = live "${x.live}" (matched by ${x.via})`)
  for (const x of r.notAirport) out.push(`- cruise/downtown, noted "do not use in CTAs": ${x}`)
  for (const u of r.unpriced) out.push(`- · no ${u.days}-day price for ${u.lot} — run refresh-rates`)
  for (const c of r.collapsedDuplicates) out.push(`- duplicate listing: ${c}`)
  for (const o of r.otherAirport) out.push(`- skipped (another airport's lot): ${o}`)
  for (const n of r.notAdded) out.push(`- not added: ${n}`)
  const idSetFor = new Set(r.idSet.map((x) => x.lot))
  for (const m of r.matched.filter((x) => x.via !== 'id' && x.via !== 'slug' && x.via !== 'name' && !idSetFor.has(x.lot))) out.push(`- matched by ${m.via}: "${m.lot}" = live "${m.live}"`)
  return out
}

function summaryRow(r: SyncReport, hasFile: boolean): string {
  return `| ${r.code} | ${hasFile ? r.liveCount : `${r.liveCount} (no file)`} | ${r.added.length} | ${r.gone.length} | ${r.flippedToSellable.length} | ${r.priceChanges.length} | ${needsHuman(r)} |`
}

function needsHuman(r: SyncReport): number {
  return r.needsConfirmation.length + r.idConflicts.length + r.ambiguous.length + r.implausible.length + r.unpriced.length + r.notAirport.length
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
  const leadDays = Number(value('--lead') ?? DEFAULT_LEAD_DAYS)
  const defaultDays = Number(value('--days') ?? DEFAULT_DAYS)
  const mdPath = value('--md')
  const only = (value('-a') ?? value('--airport'))?.toUpperCase()
  const today = iso(new Date())

  const codes = only
    ? only.split(',').map((c) => c.trim()).filter(Boolean)
    : fs.readdirSync(DATA_DIR).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')).sort()

  console.log(`lot-sync — ${codes.length} airport(s) via ${SITE}/api/search, ${defaultDays}-day stay from +${leadDays}d, ${apply ? 'APPLYING' : 'DRY RUN (pass --apply to write)'}`)
  const notProd = nonProductionReason()
  if (apply && notProd) {
    console.error(`  refusing --apply: ${notProd}`)
    process.exit(1)
  }
  const results: { report: SyncReport; written: boolean; hasFile: boolean }[] = []
  const failed: string[] = []
  for (const code of codes) {
    const r = await syncAirport(code, { apply, acceptFuzzy, leadDays, defaultDays, today })
    if (!r) {
      failed.push(code)
      continue
    }
    results.push(r)
    const lines = reportLines(r.report)
    console.log(`\n${code}  live ${r.report.liveCount}${r.written ? '  [written]' : ''}${lines.length ? '' : '  in sync'}`)
    for (const l of lines) console.log(`  ${l}`)
  }

  const tot = (f: (r: SyncReport) => number) => results.reduce((a, r) => a + f(r.report), 0)
  console.log(`\n─── summary ───`)
  console.log(
    `  ${results.length} airports: +${tot((r) => r.added.length)} added, ${tot((r) => r.gone.length)} -> sellable:false, ` +
      `${tot((r) => r.flippedToSellable.length)} -> sellable:true, ${tot((r) => r.priceChanges.length)} prices written, ` +
      `${tot((r) => r.priceDrift.length)} price differences left to refresh-rates, ${tot(needsHuman)} need a human`
  )
  if (apply && tot((r) => r.priceDrift.length + r.flippedToSellable.length)) console.log('  next: npm run refresh-rates -- --apply (prices are its job)')
  if (failed.length) console.log(`  not checked (bad/degraded response): ${failed.join(', ')}`)
  if (!apply) console.log('  nothing was written — re-run with --apply')

  fs.mkdirSync(REPORTS_DIR, { recursive: true })
  const json = path.join(REPORTS_DIR, `lot-sync-${today}${apply ? '' : '-dryrun'}.json`)
  fs.writeFileSync(json, JSON.stringify({ generatedAt: new Date().toISOString(), applied: apply, leadDays, defaultDays, failed, airports: results }, null, 2))
  console.log(`  report: ${path.relative(process.cwd(), json)}`)

  if (mdPath) {
    const md: string[] = [
      `# lot-sync ${apply ? '(applied)' : '(dry run)'} — ${today}`,
      '',
      `Live: \`/api/search\`, ${defaultDays}-day stay from +${leadDays}d (10:00 AM -> 2:00 PM), ≤3 calls per airport. dailyRate = pricing.minPrice (pre-tax, fees in).`,
      '',
      '| Airport | Live lots | Added | -> unsellable | -> sellable | Price changes | Needs a human |',
      '|---|---|---|---|---|---|---|',
      ...results.map((r) => summaryRow(r.report, r.hasFile)),
      '',
    ]
    if (failed.length) md.push(`Not checked (bad/degraded response): ${failed.join(', ')}`, '')
    for (const r of results) {
      const lines = reportLines(r.report)
      md.push(`## ${r.report.code}${r.written ? ' (written)' : ''}`, '', ...(lines.length ? lines : ['- in sync']), '')
    }
    fs.mkdirSync(path.dirname(path.resolve(mdPath)), { recursive: true })
    fs.writeFileSync(path.resolve(mdPath), md.join('\n'), 'utf-8')
    console.log(`  markdown: ${path.resolve(mdPath)}`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
