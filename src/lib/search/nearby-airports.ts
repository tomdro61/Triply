import { getAirportByCode, productionAirports, type Airport } from "@/config/airports";
import { calculateDistance } from "@/lib/utils/geo";

/** Furthest an airport can be and still be offered as an alternative, in miles. */
export const NEARBY_MAX_MILES = 400;

/**
 * Up to `limit` other production airports nearest to `code`, closest first,
 * within NEARBY_MAX_MILES. Seaports are skipped (POE is not an alternative to
 * an airport trip). Used by the empty search state so a zero-result search has
 * a next step instead of a dead end (customer-army audit 2026-11-06, item 5).
 *
 * This knows locations, not inventory: a suggestion can itself have no lots
 * for the dates. The link searches the same dates, so the customer finds out
 * in one tap.
 */
export function nearbyAirports(code: string, limit = 3): { airport: Airport; miles: number }[] {
  const from = getAirportByCode(code);
  if (!from) return [];
  return productionAirports
    .filter((a) => a.code !== from.code && !a.isSeaport && !a.isTest)
    .map((airport) => ({
      airport,
      miles: calculateDistance(from.latitude, from.longitude, airport.latitude, airport.longitude, false),
    }))
    .filter((x) => x.miles <= NEARBY_MAX_MILES)
    .sort((a, b) => a.miles - b.miles)
    .slice(0, limit);
}
