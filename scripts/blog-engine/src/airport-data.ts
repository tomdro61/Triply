import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.resolve(__dirname, '..', 'data', 'airports')

export interface AirportData {
  code: string
  fullName: string
  lastVerified: string
  terminals: { name: string; airlines: string[] }[]
  roads: string[]
  transit: string[]
  neighborhoods: string[]
  authority: string
  parkingRates: string
  shuttleInfo: string
  distanceFromCity: string
  liveSources?: Record<string, Record<string, string> | string>
  onAirportParking?: Record<string, Record<string, unknown> | string>
  parkingLots?: Record<string, unknown>[]
  currency?: string  // "CAD" for Canadian airports (PR #96); USD when absent
  evCharging?: Record<string, unknown>
  lounges?: Record<string, unknown>[]
  construction?: unknown
  construction2026?: Record<string, unknown>
  emergencyContacts?: Record<string, string>
  [key: string]: unknown  // Allow dynamic access for construction2026, etc.
}

/** Lots the writer may name: anything not explicitly marked `sellable: false`. A lot without the field is kept (older data files predate the flag). */
export function filterSellableLots<T extends { sellable?: unknown }>(lots: T[]): T[] {
  return lots.filter((l) => l.sellable !== false)
}

/** Production Canadian airports. The data file's `currency: "CAD"` is the primary signal; this list is the fallback so a missing or unreadable file never hands a Canadian airport US-only sources (review of #96). */
export const CANADIAN_AIRPORT_CODES: ReadonlySet<string> = new Set(['YYZ', 'YUL', 'YYC', 'YOW', 'YVR', 'YEG', 'YHZ', 'YWG'])

export function isCanadianAirport(code: string, data?: { currency?: string } | null): boolean {
  return data?.currency === 'CAD' || CANADIAN_AIRPORT_CODES.has(code.toUpperCase())
}

/** Price prefix for prompts: `C$` for Canadian airports, `$` otherwise. */
export function currencySymbol(data: { code?: string; currency?: string }): string {
  return isCanadianAirport(data.code ?? '', data) ? 'C$' : '$'
}

export function loadAirportData(code: string): AirportData | null {
  const filepath = path.join(DATA_DIR, `${code.toUpperCase()}.json`)
  if (!fs.existsSync(filepath)) {
    return null
  }

  // "(verify)" marks a research figure for a human check; writers copied it into live posts (YYZ/YUL, Oct 2026)
  const data: AirportData = JSON.parse(fs.readFileSync(filepath, 'utf-8').replace(/\s*\((?:verify|Verify|VERIFY)\)/g, ''))

  // Writers only see lots we can sell — unsellable lots ended up recommended in new articles (PHX, 13 Oct 2026)
  if (Array.isArray(data.parkingLots)) data.parkingLots = filterSellableLots(data.parkingLots)

  // Cruise ports (POE) list cruiseLines per terminal instead of airlines
  for (const t of data.terminals as ({ airlines?: string[]; cruiseLines?: string[] } & AirportData['terminals'][number])[]) {
    if (!Array.isArray(t.airlines)) t.airlines = Array.isArray(t.cruiseLines) ? t.cruiseLines : []
  }

  // Warn if data is stale (>90 days old)
  const lastVerified = new Date(data.lastVerified)
  const daysSinceVerified = Math.floor((Date.now() - lastVerified.getTime()) / (1000 * 60 * 60 * 24))
  if (daysSinceVerified > 90) {
    console.warn(
      `  \u26a0\ufe0f ${code}.json last verified ${data.lastVerified} (${daysSinceVerified} days ago) \u2014 consider updating rates before generating.`
    )
  }

  return data
}

/**
 * Age in days of an airport's verified rate data, or null if there is no data file
 * (or its lastVerified is unparseable). Deliberately QUIET — unlike loadAirportData
 * it does not warn, so callers that check staleness per-article (e.g. the perf loop's
 * rate-staleness guard) don't spam one warning line per page.
 */
export function rateAgeDays(code: string, now: Date = new Date()): number | null {
  const filepath = path.join(DATA_DIR, `${code.toUpperCase()}.json`)
  if (!fs.existsSync(filepath)) return null
  try {
    const { lastVerified } = JSON.parse(fs.readFileSync(filepath, 'utf-8')) as { lastVerified?: string }
    if (!lastVerified) return null
    const ms = now.getTime() - new Date(lastVerified).getTime()
    return Number.isFinite(ms) ? Math.floor(ms / (1000 * 60 * 60 * 24)) : null
  } catch {
    return null
  }
}

/**
 * Per-lot freshness (2026-09-28). The file-level `lastVerified` cannot say which prices
 * are current: most catalogued lots are not lots we sell, so they can never be
 * re-verified. refresh-rates therefore marks each lot:
 *   - `sellable`          false when the lot was absent from every sampled live search,
 *                         true when it matched one by name/address. Untouched on a fuzzy match.
 *   - `sellableCheckedOn` the date that judgement was made.
 *   - `rateVerified`      the date the lot's prices were last re-verified live.
 * A price may be promoted into a SERP title/meta only if it belongs to a lot that is
 * not `sellable: false` AND whose `rateVerified` is within the window.
 */

/** Price fields refresh-rates actually re-verifies. Taxes are deliberately excluded. */
function lotPriceFields(lot: Record<string, unknown>): number[] {
  const out: number[] = []
  for (const [k, v] of Object.entries(lot)) {
    if (typeof v !== 'number' || !Number.isFinite(v)) continue
    if (k === 'dailyRate' || k === 'reservationRate' || /^totalFor\d+Days$/.test(k)) out.push(v)
  }
  return out
}

/** True when this lot's prices may be quoted in a title: sellable and verified within maxDays. */
export function lotRateIsFresh(lot: Record<string, unknown>, maxDays: number, now: Date = new Date()): boolean {
  if (lot.sellable === false) return false
  if (typeof lot.rateVerified !== 'string') return false
  const ms = now.getTime() - new Date(lot.rateVerified).getTime()
  if (!Number.isFinite(ms)) return false
  return Math.floor(ms / 86_400_000) <= maxDays
}

/** Every price (dailyRate / reservationRate / totalForNDays) on a lot that passes lotRateIsFresh. */
export function freshLotPrices(lots: Record<string, unknown>[], maxDays: number, now: Date = new Date()): number[] {
  return lots.filter((l) => lotRateIsFresh(l, maxDays, now)).flatMap(lotPriceFields)
}

/** The parkingLots of an airport file, or null if there is no readable file. Quiet, like rateAgeDays. */
export function loadParkingLots(code: string): Record<string, unknown>[] | null {
  const filepath = path.join(DATA_DIR, `${code.toUpperCase()}.json`)
  if (!fs.existsSync(filepath)) return null
  try {
    const { parkingLots } = JSON.parse(fs.readFileSync(filepath, 'utf-8')) as { parkingLots?: unknown }
    return Array.isArray(parkingLots) ? (parkingLots as Record<string, unknown>[]) : []
  } catch {
    return null
  }
}

function titleDollarFigures(s: string): string[] {
  // Same extraction as perf-recommend's dollarFigures, so both guards see the same numbers.
  return (s.match(/\$\s?\d[\d,]*(?:\.\d{1,2})?/g) || []).map((x) => x.replace(/[^\d.]/g, ''))
}

/**
 * Pure core of the guard (used by perf-recommend and ctr-rescue): the first dollar figure
 * in `fields` that is not already published on the page AND does not equal a price on a
 * sellable lot verified within `maxDays`. Null means every new price is backed.
 */
export function unverifiedTitlePrice(
  fields: (string | undefined)[],
  onPage: { title: string; metaTitle: string; metaDescription: string },
  lots: Record<string, unknown>[],
  maxDays: number,
  now: Date = new Date(),
): { price: string; reason: string } | null {
  const published = new Set(titleDollarFigures([onPage.title, onPage.metaTitle, onPage.metaDescription].join(' ')))
  const fresh = freshLotPrices(lots, maxDays, now)
  for (const field of fields.filter(Boolean) as string[]) {
    for (const price of titleDollarFigures(field)) {
      if (published.has(price)) continue
      const n = Number(price)
      if (fresh.some((p) => p === n)) continue
      const ageNote = fresh.length
        ? `not the price of any sellable lot verified in the last ${maxDays}d`
        : `no sellable lot at this airport was verified in the last ${maxDays}d`
      return { price, reason: ageNote }
    }
  }
  return null
}

export function getEntityPatterns(data: AirportData): RegExp[] {
  const patterns: RegExp[] = []

  // Terminal patterns
  for (const t of data.terminals) {
    const escaped = t.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    patterns.push(new RegExp(escaped, 'i'))
  }

  // Airline patterns (combine all into one alternation)
  const allAirlines = data.terminals.flatMap((t) => t.airlines)
  if (allAirlines.length > 0) {
    const escaped = allAirlines.map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    patterns.push(new RegExp(`(${escaped.join('|')})`, 'i'))
  }

  // Roads
  if (data.roads.length > 0) {
    const escaped = data.roads.map((r) => r.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    patterns.push(new RegExp(`(${escaped.join('|')})`, 'i'))
  }

  // Transit
  if (data.transit.length > 0) {
    const escaped = data.transit.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    patterns.push(new RegExp(`(${escaped.join('|')})`, 'i'))
  }

  // Neighborhoods
  if (data.neighborhoods.length > 0) {
    const escaped = data.neighborhoods.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    patterns.push(new RegExp(`(${escaped.join('|')})`, 'i'))
  }

  // Authority
  if (data.authority) {
    patterns.push(new RegExp(data.authority.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'))
  }

  return patterns
}
