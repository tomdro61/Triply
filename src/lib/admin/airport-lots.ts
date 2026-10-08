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
import type { Airport } from "@/config/airports";
import type { ReslabLocation } from "@/lib/reslab/client";
import { locationsNearPoint, AIRPORT_SEARCH_RADIUS_KM } from "@/lib/reslab/search";
import {
  isOwnAirportFilterEnabled,
  locationBelongsToAirport,
  type OwnershipAirport,
} from "@/lib/search/airport-ownership";

export type AdminAirport = OwnershipAirport & Pick<Airport, "city">;

export interface AirportLots {
  code: string;
  city: string;
  lots: number;
}

/**
 * Lots we can sell per airport: channel locations within search's own radius
 * (locationsNearPoint, AIRPORT_SEARCH_RADIUS_KM) that no other airport is
 * closer to (search's own-airport rule), minus the lots search hides. Sorted
 * fewest-first so the airports we can't really sell are at the top.
 *
 * `airports` is also the competitor set for the own-airport rule; the route
 * passes `productionAirports`, the same set search and the sitemap use.
 */
export function lotsPerAirport(
  locations: readonly ReslabLocation[],
  airports: readonly AdminAirport[],
  blockedIds: ReadonlySet<number>
): AirportLots[] {
  const visible = locations.filter((l) => !blockedIds.has(l.id));
  const ownOnly = isOwnAirportFilterEnabled();
  return airports
    .map((a) => ({
      code: a.code,
      city: a.city,
      lots: locationsNearPoint(visible, a.latitude, a.longitude, AIRPORT_SEARCH_RADIUS_KM).filter(
        (loc) => !ownOnly || locationBelongsToAirport(loc, a, airports)
      ).length,
    }))
    .sort((x, y) => x.lots - y.lots || x.code.localeCompare(y.code));
}
