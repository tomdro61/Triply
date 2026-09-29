/**
 * Sellable lots per airport for /admin/numbers. Server-only: it reuses search's
 * own radius filter, so it imports search.ts (kept out of the client-safe
 * ./monthly-numbers.ts for that reason).
 */
import type { ReslabLocation } from "@/lib/reslab/client";
import { filterLocationsNearPoint } from "@/lib/reslab/search";

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
 * (filterLocationsNearPoint, 15 km) minus the lots search hides. Sorted
 * fewest-first so the airports we can't really sell are at the top.
 */
export function lotsPerAirport(
  locations: ReslabLocation[],
  airports: AirportPoint[],
  blockedIds: ReadonlySet<number>
): AirportLots[] {
  const visible = locations.filter((l) => !blockedIds.has(l.id));
  return airports
    .map((a) => ({
      code: a.code,
      city: a.city,
      lots: filterLocationsNearPoint(visible, a.latitude, a.longitude).length,
    }))
    .sort((x, y) => x.lots - y.lots || x.code.localeCompare(y.code));
}
