/**
 * Hotel-night derivation from the parking window — pure calendar-string
 * arithmetic, no timezone, no Date parsing of the input.
 *
 * Booking dates are literal airport-local strings ("YYYY-MM-DD"). Deriving the
 * hotel night by `new Date(fromDate)` / `toISOString()` / ±86 400 000 ms is
 * banned in this codebase (the May 2026 timezone bugs): `new Date("2026-05-10")`
 * is UTC midnight, which is the previous evening in every US timezone, and a
 * DST day is not 86 400 000 ms long. `Date.UTC(y, m−1, d ± 1)` + `getUTC*` is
 * exact for calendar math and cannot be shifted by the server's TZ.
 *
 * Plan: notes/2026-09-18-park-and-stay-plan-v2.md §1.
 */

import type { ParkStayNight } from "./plans";

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface HotelNight {
  /** "YYYY-MM-DD" hotel check-in (calendar day, airport-local). */
  checkin: string;
  /** "YYYY-MM-DD" hotel check-out — always checkin + 1 day (one night, A4). */
  checkout: string;
}

function assertIsoDate(label: string, value: string): void {
  if (!ISO_DATE_RE.test(value)) {
    throw new Error(`${label} must be YYYY-MM-DD, got ${JSON.stringify(value)}`);
  }
}

/** Calendar-day shift with no timezone involvement. */
export function shiftIsoDate(iso: string, days: number): string {
  assertIsoDate("date", iso);
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  const d = Number(iso.slice(8, 10));
  const t = new Date(Date.UTC(y, m - 1, d + days));
  const yy = t.getUTCFullYear();
  const mm = String(t.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(t.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/**
 * The hotel night for a parking window.
 *   before → check in the night BEFORE parking starts (checkin = from − 1, checkout = from)
 *   after  → check in the night the traveller gets BACK (checkin = to, checkout = to + 1)
 *
 * `parkingFrom` / `parkingTo` are the parking dates only ("YYYY-MM-DD"); the
 * times are irrelevant to which calendar night is booked.
 */
export function deriveHotelNight(
  parkingFrom: string,
  parkingTo: string,
  night: ParkStayNight
): HotelNight {
  assertIsoDate("parkingFrom", parkingFrom);
  assertIsoDate("parkingTo", parkingTo);
  if (night === "before") {
    return { checkin: shiftIsoDate(parkingFrom, -1), checkout: parkingFrom };
  }
  return { checkin: parkingTo, checkout: shiftIsoDate(parkingTo, 1) };
}

/**
 * Today's calendar date in an IANA timezone, as "YYYY-MM-DD". The only place a
 * real clock meets a timezone in this module; `Intl` is exact and needs no
 * library. Used to refuse a "night before" whose check-in is already in the
 * past AT THE AIRPORT (36 % of bookings are same-day).
 */
export function todayInZone(timeZone: string, now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/**
 * Is a derived hotel check-in bookable today? "before" is unavailable when the
 * check-in is before today in the airport's timezone. Lexicographic compare is
 * exact for YYYY-MM-DD.
 */
export function isHotelCheckinBookable(
  checkin: string,
  airportTimeZone: string,
  now: Date = new Date()
): boolean {
  assertIsoDate("checkin", checkin);
  return checkin >= todayInZone(airportTimeZone, now);
}
