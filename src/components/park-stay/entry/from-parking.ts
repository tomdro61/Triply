/**
 * Parking search → Park & Stay (CX plan §12.1, with §11's "hotel check-in
 * date" + "parking return date" and §12.5's R12-H3 / R12-M7). Pure, the clock
 * injected; it lives in the LAZY chunk, so none of it (nor plans.ts) is in the
 * /search page's first-load JS. The page hands over only the raw URL strings.
 *
 * - Hotel check-in (`night`) = parking check-in − 1: you sleep at the hotel
 *   the night before your parking starts. Parking return = parking check-out.
 * - Built from the URL (what was searched), never the header's edit state.
 * - Never throws: every date is checked with isIsoDate() before any shift.
 * - "hidden" = no switch at all (not an open airport, or the URL lacks two
 *   usable dates). "disabled" = shown greyed out with a visible reason.
 * - The parking-card badge (R12-M7) uses exactly this answer: it shows only
 *   when the Park & Stay side is enabled.
 */

import { getAirportByCode } from "@/config/airports";
import { isIsoDate, shiftIsoDate, todayInZone } from "@/lib/hotels/dates";
import { PARK_STAY_MAX_NIGHT_AHEAD_DAYS, PARK_STAY_MAX_RETURN_AFTER_NIGHT_DAYS } from "@/lib/hotels/plans";
import type { ParkStayAccess, ParkStayAccessHotel } from "@/lib/hotels/access";

export const NEEDS_NIGHT_BEFORE = "Park & Stay needs a hotel night before your parking starts.";
export const NIGHT_TOO_FAR = `Park & Stay hotel check-in dates go up to ${PARK_STAY_MAX_NIGHT_AHEAD_DAYS} days ahead.`;
export const RETURN_TOO_FAR = `Park & Stay covers parking up to ${PARK_STAY_MAX_RETURN_AFTER_NIGHT_DAYS} days after the hotel night.`;

/** The raw /search URL values, exactly as `searchParams.get()` returned them. */
export interface RawParkingSearch {
  airport: string | null;
  checkin: string | null;
  checkout: string | null;
}

/**
 * `parkingHref` is the searched parking page itself (the switch's current
 * side); `href` the Park & Stay search it maps to.
 */
export type FromParking =
  | { kind: "hidden" }
  | { kind: "disabled"; reason: string; airport: string; parkingHref: string }
  | { kind: "enabled"; href: string; airport: string; parkingHref: string };

const HIDDEN: FromParking = { kind: "hidden" };

/** The open airport the URL names (upper-cased), or null. */
export function openAirportFor(raw: string | null, access: Pick<ParkStayAccess, "airports">): string | null {
  if (raw === null) return null;
  const code = raw.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) return null;
  return access.airports.some((a) => a.code.toUpperCase() === code) ? code : null;
}

export function parkStayFromParking(raw: RawParkingSearch, access: Pick<ParkStayAccess, "airports">, now: Date): FromParking {
  const airport = openAirportFor(raw.airport, access);
  if (airport === null) return HIDDEN;
  const checkin = raw.checkin ?? "";
  const checkout = raw.checkout ?? "";
  if (!isIsoDate(checkin) || !isIsoDate(checkout) || checkout < checkin) return HIDDEN;
  const timeZone = getAirportByCode(airport)?.timezone;
  if (!timeZone) return HIDDEN;
  let today: string;
  try {
    today = todayInZone(timeZone, now);
  } catch {
    return HIDDEN;
  }
  if (!isIsoDate(today)) return HIDDEN;

  const parkingHref = `/search?${new URLSearchParams({ airport, checkin, checkout }).toString()}`;
  const night = shiftIsoDate(checkin, -1);
  const disabled = (reason: string): FromParking => ({ kind: "disabled", reason, airport, parkingHref });
  if (night < today) return disabled(NEEDS_NIGHT_BEFORE);
  if (night > shiftIsoDate(today, PARK_STAY_MAX_NIGHT_AHEAD_DAYS)) return disabled(NIGHT_TOO_FAR);
  if (checkout > shiftIsoDate(night, PARK_STAY_MAX_RETURN_AFTER_NIGHT_DAYS)) return disabled(RETURN_TOO_FAR);

  // The /park-stay key order (format.ts SEARCH_PARAM_KEYS); arrival time,
  // return time and guests get their starting values there (withSearchDefaults).
  const q = new URLSearchParams({ airport, night, returnDate: checkout });
  return { kind: "enabled", href: `/park-stay?${q.toString()}`, airport, parkingHref };
}

/**
 * The "Add a night" link on a parking card, or null: only when the switch's
 * Park & Stay side is enabled (R12-M7) and the lot is the hotel's own lot at
 * the searched airport under THIS deployment's ResLab account (a null id —
 * staging — never matches).
 */
export function lotBadgeHref(side: FromParking, hotels: readonly ParkStayAccessHotel[], reslabLocationId: number | null | undefined): string | null {
  if (side.kind !== "enabled" || typeof reslabLocationId !== "number") return null;
  const hotel = hotels.find((h) => h.reslabLotId !== null && h.reslabLotId === reslabLocationId && h.airport.toUpperCase() === side.airport);
  if (!hotel) return null;
  return `${side.href}&${new URLSearchParams({ focus: hotel.key }).toString()}`;
}
