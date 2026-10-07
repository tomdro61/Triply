/**
 * ResLab channel lots per airport for /admin/numbers. Server-only: it reuses
 * search's own radius filter, so it imports search.ts (kept out of the
 * client-safe ./monthly-numbers.ts for that reason).
 *
 * Counts the RESLAB channel only. Direct lots (src/lib/direct) are listed
 * beside ResLab lots by searchParking once DIRECT_BOOKING_OPEN; add them here
 * (fetchListableDirectLots + twin suppression) when that flips — until then
 * the page labels this card "ResLab channel lots".
 */
import type { ReslabLocation } from "@/lib/reslab/client";
import { locationsNearPoint, AIRPORT_SEARCH_RADIUS_KM } from "@/lib/reslab/search";

export interface AirportPoint {
  code: string;
  city: string;
  latitude: number;
  longitude: number;
}

export interface AirportLots {
  code: string;
  city: string;
  lots: number;
}

/**
 * Lots we can sell per airport: channel locations within search's own radius
 * (locationsNearPoint, AIRPORT_SEARCH_RADIUS_KM) minus the lots search hides.
 * Sorted fewest-first so the airports we can't really sell are at the top.
 */
export function lotsPerAirport(
  locations: readonly ReslabLocation[],
  airports: AirportPoint[],
  blockedIds: ReadonlySet<number>
): AirportLots[] {
  const visible = locations.filter((l) => !blockedIds.has(l.id));
  return airports
    .map((a) => ({
      code: a.code,
      city: a.city,
      lots: locationsNearPoint(visible, a.latitude, a.longitude, AIRPORT_SEARCH_RADIUS_KM).length,
    }))
    .sort((x, y) => x.lots - y.lots || x.code.localeCompare(y.code));
}
