/**
 * Search's "Recommended" order and result badges. Pure — no I/O — so the rules
 * are pinned by unit tests (__tests__/ranking.test.ts).
 *
 * Why: the default sort was labelled "Recommended" but sorted by distance. At
 * JFK (as of 2026-10-08) that put the lot with 16 of JFK's 22 bookings — also
 * the cheapest, with a shuttle every 10 minutes — 8th of 10, under lots costing
 * up to 2.8× as much.
 *
 * Recommended = the airport's clear booking leader first (rules in
 * pickMostBookedLot), then everything else cheapest-first by the total the
 * card shows. Plan: notes/2026-10-08-search-recommended-sort-plan.md.
 */
import type { UnifiedLot } from "@/types/lot";
import { customerTotalFromPricing } from "@/lib/utils/service-fee";
import { DIRECT_BOOKING_OPEN } from "@/lib/direct/flag";

/** A lot needs at least this many kept bookings in the window to be "most booked". */
export const MOST_BOOKED_MIN = 3;
/** The leader is pinned only if its total is within this multiple of the median shown. */
export const PIN_PRICE_GUARD = 1.25;

/**
 * The comparable price of a lot: the "$X total" its card shows (grand total incl.
 * tax, plus the service fee). The grand total includes any due-at-lot part, so a
 * pay-at-lot lot compares fairly. Infinity when it can't be computed (sorts last).
 */
export function lotTotal(lot: UnifiedLot): number {
  return customerTotalFromPricing(lot.pricing) ?? Number.POSITIVE_INFINITY;
}

/** Cheapest total first; then closest; then id, so the order is deterministic. */
export function compareByTotal(a: UnifiedLot, b: UnifiedLot): number {
  const ta = lotTotal(a);
  const tb = lotTotal(b);
  if (ta !== tb) return ta < tb ? -1 : 1;
  const da = a.distanceFromAirport ?? Number.POSITIVE_INFINITY;
  const db = b.distanceFromAirport ?? Number.POSITIVE_INFINITY;
  if (da !== db) return da < db ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Most expensive total first; unpriced lots still last. */
export function compareByTotalDesc(a: UnifiedLot, b: UnifiedLot): number {
  const fa = Number.isFinite(lotTotal(a));
  const fb = Number.isFinite(lotTotal(b));
  if (fa !== fb) return fa ? -1 : 1;
  return compareByTotal(b, a);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((x, y) => x - y);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * The airport's booking leader, or null. The leader is chosen across EVERY lot
 * considered for the airport (sold-out ones included), so a runner-up never
 * inherits "Most booked" because the real leader is sold out for these dates.
 * All of these must hold, else no pin:
 *   - at least MOST_BOOKED_MIN bookings, and strictly more than the runner-up
 *     (a tie is not a "most");
 *   - the leader is among the returned lots;
 *   - its total is within PIN_PRICE_GUARD × the median total returned (never
 *     pin an outlier price to the top).
 */
export function pickMostBookedLot(
  returned: readonly UnifiedLot[],
  consideredIds: Iterable<number>,
  counts: ReadonlyMap<number, number>
): UnifiedLot | null {
  let bestId: number | null = null;
  let best = 0;
  let second = 0;
  for (const id of new Set(consideredIds)) {
    const n = counts.get(id) ?? 0;
    if (n > best) {
      second = best;
      best = n;
      bestId = id;
    } else if (n > second) {
      second = n;
    }
  }
  if (bestId === null || best < MOST_BOOKED_MIN || best <= second) return null;

  const leader = returned.find((l) => l.source === "reslab" && l.reslabLocationId === bestId);
  if (!leader) return null;

  const med = median(returned.map(lotTotal).filter(Number.isFinite));
  const total = lotTotal(leader);
  if (med === null || !Number.isFinite(total) || total > PIN_PRICE_GUARD * med) return null;
  return leader;
}

/**
 * The pinned lot (by id) first, then everything else cheapest-first. A pinnedId
 * that is not among `lots` pins nothing — this never adds a lot to the results.
 */
export function rankRecommended(lots: readonly UnifiedLot[], pinnedId: string | null): UnifiedLot[] {
  const pinned = pinnedId === null ? undefined : lots.find((l) => l.id === pinnedId);
  const rest = lots.filter((l) => l !== pinned).sort(compareByTotal);
  return pinned ? [pinned, ...rest] : rest;
}

/**
 * The lowest-total lot a customer can book right now, or null. Null whenever the
 * result is not complete (partial pricing, a thin list, ResLab or the direct-lot
 * read down): a "lowest" among the lots that happened to load is not a real
 * lowest — same rule as search_events' cheapest_price_cents.
 */
export function lowestTotalLot(lots: readonly UnifiedLot[], opts: { resultComplete: boolean }): UnifiedLot | null {
  if (!opts.resultComplete) return null;
  const bookable = lots.filter(
    (l) => Number.isFinite(lotTotal(l)) && (l.source !== "direct" || DIRECT_BOOKING_OPEN)
  );
  if (bookable.length === 0) return null;
  return [...bookable].sort(compareByTotal)[0];
}
