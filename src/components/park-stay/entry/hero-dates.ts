/**
 * The homepage "Park & Stay" tab's form rules (CX plan §2 as changed by §11
 * and §12.3): airport (only the access airports), "Hotel check-in date" (the
 * `night` URL key) and "Parking return date" (`returnDate`). Pure, the clock
 * injected. The rules are the /park-stay header's own (search-values.ts),
 * which mirror the server's validateParkStayWindow():
 *
 * - check-in from TODAY at the airport (its time zone, @/config/airports) to
 *   today + 100;
 * - return on or after the hotel check-out day and within 60 days of the
 *   check-in — an error, never a swap.
 *
 * Arrival time, return time and guests are asked on /park-stay, highlighted,
 * never defaulted here.
 */

import { getAirportByCode } from "@/config/airports";
import type { ParkStayAccess } from "@/lib/hotels/access";
import {
  airportTimeZone,
  checkSearchDates,
  parkStayDateBounds,
  parkStayPageQuery,
  pickerMaxDate,
  type ParkStayAirportOption,
  type SubmitResult,
} from "../search-values";

/** The access airports, with their time zone and point from the airport config (an unknown code is dropped). */
export function accessAirportOptions(access: Pick<ParkStayAccess, "airports">): ParkStayAirportOption[] {
  const out: ParkStayAirportOption[] = [];
  for (const a of access.airports) {
    const info = getAirportByCode(a.code);
    if (!info) continue;
    out.push({ code: info.code, name: a.name, timezone: info.timezone, latitude: info.latitude, longitude: info.longitude });
  }
  return out;
}

export interface HeroDateLimits {
  /** Today at the airport: the earliest check-in. */
  min: string;
  /** The latest day the picker may offer (pickerMaxDate: check-in limit, or check-in + 60 once chosen). */
  max: string;
}

export function heroDateLimits(input: { airport: string; night: string; returnDate: string }, airports: readonly ParkStayAirportOption[], now: Date): HeroDateLimits {
  const bounds = parkStayDateBounds(airportTimeZone(airports, input.airport), now);
  return { min: bounds.today, max: pickerMaxDate(input, bounds) };
}

/**
 * Where "Search" goes: the date rules first (an airport must be chosen), then
 * /park-stay?airport&night&returnDate — the three things asked here, nothing
 * else.
 */
export function heroSubmit(input: { airport: string; night: string; returnDate: string }, airports: readonly ParkStayAirportOption[], now: Date): SubmitResult {
  const airport = airports.some((a) => a.code === input.airport.toUpperCase()) ? input.airport.toUpperCase() : "";
  const bounds = parkStayDateBounds(airportTimeZone(airports, airport), now);
  const problem = checkSearchDates({ airport, night: input.night, returnDate: input.returnDate }, bounds);
  if (problem) return { ok: false, problem };
  const query = parkStayPageQuery({ airport, night: input.night, returnDate: input.returnDate, arrivalTime: "", returnTime: "", adults: "" }, null);
  return { ok: true, href: `/park-stay?${query}` };
}
