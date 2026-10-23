/**
 * Which airports Park & Stay is open for in this process: allowlisted by the
 * flags (`PARK_STAY_AIRPORTS`), present in the airport config, AND carrying
 * at least one enabled hotel in the map (plan v3 §4.1). An allowlisted airport
 * with no enabled hotel answers 404, like a non-allowlisted one.
 */

import { airportsByCode, type Airport } from "@/config/airports";
import { isParkStayEnabledFor, parkStayFlags } from "./flags";
import { enabledHotelLotsFor, HOTEL_LOTS } from "./hotel-lots";

export function parkStayAirport(code: string): Airport | null {
  const upper = code.toUpperCase();
  if (!isParkStayEnabledFor(upper)) return null;
  const airport = airportsByCode[upper];
  if (!airport || !airport.enabled || airport.isTest) return null;
  return enabledHotelLotsFor(upper).length > 0 ? airport : null;
}

/** Every open airport, in the map's order (for the page's airport picker). */
export function parkStayAirports(): Airport[] {
  if (!parkStayFlags().enabled) return [];
  const codes = [...new Set(HOTEL_LOTS.map((e) => e.airport))];
  return codes.map((c) => parkStayAirport(c)).filter((a): a is Airport => a !== null);
}
