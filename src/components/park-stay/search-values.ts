/**
 * The /park-stay search values and the rules that move between them (CX plan
 * v2 §3, as changed by Tom on 20 Oct 2026: "Hotel check-in date" + "Parking
 * return date", like Airport Parking Reservations). Pure: no React, no
 * fetch, the clock injected.
 *
 * Dates are literal airport-local "YYYY-MM-DD" strings. The customer picks
 * the hotel CHECK-IN date — the `night` URL key, as is — and the parking
 * return date (`returnDate`). Hotel check-out is the next morning (night + 1).
 * Every shift is calendar arithmetic (dates.ts) — never toISOString() or
 * ±86 400 000 ms, which a DST day or a non-UTC browser would shift.
 *
 * The rules mirror the server's validateParkStayWindow() (parking-window.ts)
 * rather than inventing new ones; the server re-validates everything.
 */

import { isIsoDate, shiftIsoDate, todayInZone } from "@/lib/hotels/dates";
import { MAX_ADVANCE_BOOKING_DAYS } from "@/lib/booking-window";
import { PARK_STAY_MAX_ADULTS, PARK_STAY_MAX_NIGHT_AHEAD_DAYS, PARK_STAY_MAX_RETURN_AFTER_NIGHT_DAYS, PARK_STAY_MIN_ADULTS } from "@/lib/hotels/plans";
import { ARRIVAL_TIME_OPTIONS, RETURN_TIME_OPTIONS, SEARCH_PARAM_KEYS, type SearchParamKey } from "./format";

export type ParkStaySearchValues = Record<SearchParamKey, string>;

/** An open airport, as the server page passes it (from @/config/airports). */
export interface ParkStayAirportOption {
  code: string;
  name: string;
  timezone: string;
  latitude: number;
  longitude: number;
}

/** A map hotel's name, passed by the server page (for the `focus` banner). */
export interface ParkStayHotelName {
  key: string;
  airport: string;
  name: string;
}

export const ADULT_OPTIONS: readonly string[] = Array.from({ length: PARK_STAY_MAX_ADULTS - PARK_STAY_MIN_ADULTS + 1 }, (_, i) => String(PARK_STAY_MIN_ADULTS + i));

const HOTEL_KEY_RE = /^[a-z0-9-]{1,64}$/;

type Params = { get(name: string): string | null };

/** `focus` from the URL, or null when absent or not a possible hotel key. */
export function readFocus(params: Params): string | null {
  const raw = params.get("focus");
  return raw !== null && HOTEL_KEY_RE.test(raw) ? raw : null;
}

/**
 * Values that aren't one of the options become "" — shown as MISSING (and
 * highlighted), never as whichever option a <select> would fall back to
 * (review round 1, item 7). The airport must be an open one; dates must be
 * real calendar dates. Nothing is ever filled in. Keys this page doesn't
 * know (an old link's `flight`, say) are simply never read.
 */
export function sanitizeSearchValues(values: ParkStaySearchValues, openAirports: readonly string[]): ParkStaySearchValues {
  const airport = values.airport.toUpperCase();
  return {
    airport: openAirports.includes(airport) ? airport : "",
    night: isIsoDate(values.night) ? values.night : "",
    arrivalTime: ARRIVAL_TIME_OPTIONS.includes(values.arrivalTime) ? values.arrivalTime : "",
    returnDate: isIsoDate(values.returnDate) ? values.returnDate : "",
    returnTime: RETURN_TIME_OPTIONS.includes(values.returnTime) ? values.returnTime : "",
    adults: ADULT_OPTIONS.includes(values.adults) ? values.adults : "",
  };
}

export function isCompleteSearch(values: ParkStaySearchValues): boolean {
  return SEARCH_PARAM_KEYS.every((k) => values[k].length > 0);
}

/** The API query: every search key, in a fixed order, and nothing else (no `focus`, no `seen`). */
export function apiSearchQuery(values: ParkStaySearchValues): string {
  const q = new URLSearchParams();
  for (const k of SEARCH_PARAM_KEYS) q.set(k, values[k]);
  return q.toString();
}

/**
 * The /park-stay URL query: the non-empty search keys, then `focus` when
 * set. Every submit keeps `focus` (review C-H4: the old form rebuilt the URL
 * from SEARCH_PARAM_KEYS only and dropped it).
 */
export function parkStayPageQuery(values: ParkStaySearchValues, focus: string | null): string {
  const q = new URLSearchParams();
  for (const k of SEARCH_PARAM_KEYS) if (values[k].length > 0) q.set(k, values[k]);
  if (focus) q.set("focus", focus);
  return q.toString();
}

// ───────────────────────── date limits ─────────────────────────

/** Hotel check-out: the morning after check-in. Null for a non-date. */
export function checkoutDateFor(night: string): string | null {
  return isIsoDate(night) ? shiftIsoDate(night, 1) : null;
}

export interface ParkStayDateBounds {
  /** Today at the airport: the earliest check-in (`night_past` below it). */
  today: string;
  /** The latest check-in (`night_too_far` above it). */
  checkinMax: string;
}

/** Only sets the picker limits before an airport is chosen (every open airport is Eastern today). */
export const FALLBACK_TIME_ZONE = "America/New_York";

/** The chosen airport's IANA time zone, or the fallback when none is chosen yet. */
export function airportTimeZone(airports: readonly ParkStayAirportOption[], code: string): string {
  return airports.find((a) => a.code === code.toUpperCase())?.timezone ?? FALLBACK_TIME_ZONE;
}

export function parkStayDateBounds(timeZone: string, now: Date): ParkStayDateBounds {
  const today = todayInZone(timeZone, now);
  return { today, checkinMax: shiftIsoDate(today, PARK_STAY_MAX_NIGHT_AHEAD_DAYS) };
}

/** The latest parking return for a check-in (plans.ts: 60 days after the night — not parking's 100). */
export function returnMaxForNight(night: string): string | null {
  return isIsoDate(night) ? shiftIsoDate(night, PARK_STAY_MAX_RETURN_AFTER_NIGHT_DAYS) : null;
}

/**
 * The latest day the shared DateRangePicker may offer. It takes ONE maxDate
 * for both legs and doesn't say which leg is open, so: no check-in yet → the
 * check-in limit; otherwise the later of the check-in limit and check-in +
 * 60, so reopening the check-in leg never blocks a valid check-in (review
 * recheck M1). checkSearchDates() names whichever rule a pick then breaks
 * (e.g. a return more than 60 days after check-in).
 */
export function pickerMaxDate(input: { night: string; returnDate: string }, bounds: ParkStayDateBounds): string {
  const returnMax = returnMaxForNight(input.night);
  if (returnMax === null) return bounds.checkinMax;
  return returnMax > bounds.checkinMax ? returnMax : bounds.checkinMax;
}

export type DatesProblem = { field: "airport" | "night" | "return"; message: string };

export const RETURN_BEFORE_CHECKIN = "Parking return date must be on or after your hotel check-in date.";
/** The server's own rule (parking-window.ts `return_before_departure`): the return is on or after the hotel check-out day. */
export const RETURN_BEFORE_CHECKOUT = "Parking return date must be on or after your hotel check-out day (the morning after check-in).";

/**
 * The header's own date rules — the same rules as validateParkStayWindow(),
 * checked before a submit so the customer gets the reason at once:
 * check-in from today (airport-local) to today + 100; return on or after the
 * check-out day (night + 1) and within 60 days of the night. A return before
 * the check-in is an error, never swapped.
 */
export function checkSearchDates(input: { airport: string; night: string; returnDate: string }, bounds: ParkStayDateBounds): DatesProblem | null {
  if (input.airport.length === 0) return { field: "airport", message: "Choose an airport." };
  if (!isIsoDate(input.night)) return { field: "night", message: "Choose your hotel check-in date." };
  if (input.night < bounds.today) return { field: "night", message: "The hotel check-in date can't be in the past." };
  if (input.night > bounds.checkinMax) {
    return { field: "night", message: `The hotel check-in date must be within ${PARK_STAY_MAX_NIGHT_AHEAD_DAYS} days.` };
  }
  if (!isIsoDate(input.returnDate)) return { field: "return", message: "Choose your parking return date." };
  if (input.returnDate < input.night) return { field: "return", message: RETURN_BEFORE_CHECKIN };
  const checkout = checkoutDateFor(input.night);
  if (checkout !== null && input.returnDate < checkout) return { field: "return", message: RETURN_BEFORE_CHECKOUT };
  const max = returnMaxForNight(input.night);
  if (max !== null && input.returnDate > max) {
    return { field: "return", message: `Parking can be booked up to ${PARK_STAY_MAX_RETURN_AFTER_NIGHT_DAYS} days after the hotel check-in date.` };
  }
  return null;
}

// ───────────────────────── the header's state ─────────────────────────

/** The header's fields: the six search keys (from SANITISED URL values). */
export type HeaderFields = ParkStaySearchValues;

export type SubmitResult = { ok: true; href: string } | { ok: false; problem: DatesProblem };

/**
 * Where a submit goes: the date rules first; then /park-stay with every set
 * search key plus `focus`. Missing details still navigate (the URL then
 * shows exactly what is set; the results stay idle with the highlight).
 */
export function submitHref(fields: HeaderFields, bounds: ParkStayDateBounds, focus: string | null): SubmitResult {
  const problem = checkSearchDates(fields, bounds);
  if (problem) return { ok: false, problem };
  return { ok: true, href: `/park-stay?${parkStayPageQuery(fields, focus)}` };
}

/**
 * The shared DateRangePicker SWAPS a return picked before the start
 * (date-picker.tsx: onStartChange(earlier day) then onEndChange(old start)
 * in the same click). Park & Stay never swaps silently: the header
 * remembers the start it just received and, when the very next end is the
 * old check-in and the new start is earlier, rejects the pick. A normal
 * first click sends onEndChange("") after the start — not a swap; a normal
 * second click sends an end with no start before it.
 */
export function isPickerSwap(pending: { start: string; prevStart: string } | null, end: string): boolean {
  return pending !== null && end !== "" && pending.prevStart !== "" && pending.start < pending.prevStart && end === pending.prevStart;
}

// ───────────────────────── missing details ─────────────────────────

export const DETAIL_KEYS = ["arrivalTime", "returnTime", "adults"] as const satisfies readonly SearchParamKey[];
export type DetailKey = (typeof DETAIL_KEYS)[number];

/** The detail fields flagged missing (highlighted). */
export function missingDetails(values: Pick<ParkStaySearchValues, DetailKey>): DetailKey[] {
  return DETAIL_KEYS.filter((k) => values[k].length === 0);
}

export const DETAILS_PROMPT = "Add when you'll reach the hotel, your return time and the number of guests to see prices.";
const DETAILS_PROMPT_NO_RETURN_TIME = "Add when you'll reach the hotel and the number of guests to see prices.";

/**
 * The highlight prompt, or null when nothing is missing. It names the return
 * time only while that is missing. Never a guessed value (plan §3).
 */
export function detailsPrompt(missing: readonly DetailKey[]): string | null {
  if (missing.length === 0) return null;
  return missing.includes("returnTime") ? DETAILS_PROMPT : DETAILS_PROMPT_NO_RETURN_TIME;
}

// ───────────────────────── the toggle back to parking ─────────────────────────

/**
 * "Parking only": /search?airport&checkin=<night + 1>&checkout=<returnDate>.
 * The parking check-in is the hotel check-out day, the morning after the
 * hotel night. /search reads exactly airport, checkin and checkout
 * (search/page.tsx), so nothing else is carried — no times it would ignore.
 * Built from the URL values (what was searched), never from a half-edited
 * form. Null when the values can't make a valid parking search (never swapped),
 * or when the parking check-in would fall past ResLab's 100-day check-in
 * window counted from `today` at the airport (review recheck L3).
 */
export function parkingOnlyHref(
  values: Pick<ParkStaySearchValues, "airport" | "night" | "returnDate">,
  today: string
): string | null {
  if (!/^[A-Za-z]{3}$/.test(values.airport)) return null;
  const checkin = checkoutDateFor(values.night);
  if (checkin === null || !isIsoDate(values.returnDate) || values.returnDate < checkin) return null;
  if (!isIsoDate(today) || checkin > shiftIsoDate(today, MAX_ADVANCE_BOOKING_DAYS)) return null;
  const q = new URLSearchParams({ airport: values.airport.toUpperCase(), checkin, checkout: values.returnDate });
  return `/search?${q.toString()}`;
}

// ───────────────────────── focus ─────────────────────────

/**
 * The banner when the `focus` hotel isn't among the offers of a finished
 * search (review L-H4: never a silent swap). Null when there is no focus, it
 * is shown, or it names another airport's hotel (a kept `focus` after the
 * airport changed — it means nothing here). A partial answer says we
 * couldn't check, not that there are no rooms.
 */
export function focusBanner(input: {
  focus: string | null;
  airport: string;
  offerKeys: readonly string[];
  partial: boolean;
  hotels: readonly ParkStayHotelName[];
}): string | null {
  const { focus, offerKeys } = input;
  if (!focus || offerKeys.includes(focus)) return null;
  const hotel = input.hotels.find((h) => h.key === focus);
  if (hotel && hotel.airport.toUpperCase() !== input.airport.toUpperCase()) return null;
  const name = hotel?.name ?? "That hotel";
  const others = offerKeys.length > 0 ? " Here are the other hotels." : "";
  return input.partial ? `We couldn't check ${name} right now.${others}` : `${name} has no rooms we can offer for these dates.${others}`;
}
