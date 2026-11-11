import { getAirportByCode } from "@/config/airports";
import { isOwnAirportFilterEnabled, locationBelongsToAirport } from "@/lib/search/airport-ownership";
import { calculateDistance } from "@/lib/utils/geo";
import type { ReslabLocation } from "./client";

/**
 * Which of several visible same-name ResLab locations a lot page under this
 * airport renders. findLotBySlug uses it to pick the lot; resolveLotUrl uses
 * it to check that a 308 lands on the lot it means, so the two can never
 * disagree.
 *
 * A lot this airport OWNS beats a nearer same-name lot another airport owns:
 * the sitemap lists /<airport>/…/<slug> for the owned one, and the page must
 * render (and canonical) that lot, not its namesake (audit, 10 Nov 2026).
 * Same rule as the sitemap's reslabLocationsFor, and like it, off with the
 * own-airport kill switch. Then the nearest; unparseable coordinates never
 * win.
 */
export function pickSameNameLot(
  matches: readonly ReslabLocation[],
  airport: { latitude: number; longitude: number; code?: string },
): ReslabLocation | undefined {
  if (matches.length <= 1) return matches[0];
  const dist = (loc: ReslabLocation) => {
    const d = calculateDistance(airport.latitude, airport.longitude, parseFloat(loc.latitude), parseFloat(loc.longitude), false);
    return Number.isNaN(d) ? Infinity : d;
  };
  const urlAirport = airport.code ? getAirportByCode(airport.code) : undefined;
  const owned =
    urlAirport && isOwnAirportFilterEnabled() ? matches.filter((loc) => locationBelongsToAirport(loc, urlAirport)) : [];
  const pool = owned.length > 0 ? owned : matches;
  return pool.reduce((best, loc) => (dist(loc) < dist(best) ? loc : best), pool[0]);
}
