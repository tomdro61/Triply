/**
 * Which airport's results a lot belongs in.
 *
 * Search lists every lot within AIRPORT_SEARCH_RADIUS_KM of an airport, and JFK
 * and LGA overlap: JFK's results carried two Flushing lots that serve LGA (8.6 mi
 * from JFK, hourly shuttle, none overnight) and LGA's carried all ten JFK lots.
 * A lot now belongs to an airport unless a DIFFERENT airport is strictly closer.
 *
 * Simulated on the live 393-lot list on 2026-10-08: only JFK (−2) and LGA (−10)
 * changed. The tests pin those specific lots, not future ones — a new lot or a
 * new airport can move lots without any test failing, so re-run the simulation
 * (notes/2026-10-08-search-recommended-sort-plan.md) when adding an airport.
 *
 * Shared by search, the sitemap and the admin lot counts, so all three agree.
 * Kill switch: SEARCH_OWN_AIRPORT_FILTER=off (+ redeploy) restores the plain
 * radius list everywhere.
 */
import { productionAirports, type Airport } from "@/config/airports";
import { calculateDistance } from "@/lib/utils/geo";

/** The airport fields the rule reads. */
export type OwnershipAirport = Pick<
  Airport,
  "code" | "latitude" | "longitude" | "isSeaport" | "reslabLocationId" | "isTest"
>;

/**
 * Lots that genuinely serve more than one airport (e.g. a shuttle to both),
 * keyed by ResLab location id → the airport codes it is ALSO listed at. Empty
 * today; add a lot here with a dated reason rather than loosening the rule.
 */
export const LOT_AIRPORT_OVERRIDES: ReadonlyMap<number, readonly string[]> = new Map();

/** Off for "off" / "false" / "0" / "no" (any case); on otherwise. */
export function isOwnAirportFilterEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !["off", "false", "0", "no"].includes((env.SEARCH_OWN_AIRPORT_FILTER ?? "").trim().toLowerCase());
}

/**
 * Airports outside the rule, as searched airport and as competitor: a cruise
 * port (its lots serve the airport next door too) and a single-location test
 * airport.
 */
export function isExemptFromOwnership(airport: OwnershipAirport): boolean {
  return airport.isSeaport === true || airport.isTest === true || airport.reslabLocationId !== undefined;
}

/**
 * True unless another non-exempt airport is strictly closer to the lot. A tie
 * keeps the lot, as does an exempt searched airport. Unusable coordinates keep
 * the lot (defensive: the radius filter already drops them, so this is
 * unreachable from search, sitemap or admin).
 */
export function lotBelongsToAirport(
  lot: { reslabLocationId?: number; latitude: number; longitude: number },
  airport: OwnershipAirport,
  competitors: readonly OwnershipAirport[] = productionAirports
): boolean {
  if (isExemptFromOwnership(airport)) return true;
  if (lot.reslabLocationId !== undefined && LOT_AIRPORT_OVERRIDES.get(lot.reslabLocationId)?.includes(airport.code)) {
    return true;
  }
  if (!Number.isFinite(lot.latitude) || !Number.isFinite(lot.longitude)) return true;
  const own = calculateDistance(airport.latitude, airport.longitude, lot.latitude, lot.longitude);
  return competitors.every(
    (other) =>
      other.code === airport.code ||
      isExemptFromOwnership(other) ||
      calculateDistance(other.latitude, other.longitude, lot.latitude, lot.longitude) >= own
  );
}

/** Same rule for a raw ResLab location (string coordinates). */
export function locationBelongsToAirport(
  loc: { id: number; latitude: string; longitude: string },
  airport: OwnershipAirport,
  competitors: readonly OwnershipAirport[] = productionAirports
): boolean {
  return lotBelongsToAirport(
    { reslabLocationId: loc.id, latitude: parseFloat(loc.latitude), longitude: parseFloat(loc.longitude) },
    airport,
    competitors
  );
}
