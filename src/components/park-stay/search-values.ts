/**
 * The /park-stay search values and the rules that move between them (CX plan
 * v2 §2–3). Pure: no React, no fetch, the clock injected.
 *
 * Dates are literal airport-local "YYYY-MM-DD" strings. The customer picks a
 * FLIGHT date; the hotel night is the night before (flight − 1) or, for a
 * flight just after midnight, the one before that (flight − 2). The night is
 * what the API gets (`night`); the flight rides along as a PAGE-ONLY key
 * (`flight`, like `focus`) so changing the night never loses the flight date
 * (review round 1, item 1). Every shift is calendar arithmetic (dates.ts) —
 * never toISOString() or ±86 400 000 ms, which a DST day or a non-UTC browser
 * would shift.
 */

import { isIsoDate, shiftIsoDate, todayInZone } from "@/lib/hotels/dates";
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
 * real calendar dates. Nothing is ever filled in.
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

/** The API query: every search key, in a fixed order, and nothing else (no `flight`, `focus` or `seen`). */
export function apiSearchQuery(values: ParkStaySearchValues): string {
  const q = new URLSearchParams();
  for (const k of SEARCH_PARAM_KEYS) q.set(k, values[k]);
  return q.toString();
}

/** The page-only URL keys: kept through every submit, never sent to the API. */
export interface PageExtras {
  flight: string | null;
  focus: string | null;
}

/**
 * The /park-stay URL query: the non-empty search keys, then `flight` and
 * `focus` when set. Every submit keeps both (review C-H4: the old form
 * rebuilt the URL from SEARCH_PARAM_KEYS only and dropped `focus`).
 */
export function parkStayPageQuery(values: ParkStaySearchValues, extras: PageExtras): string {
  const q = new URLSearchParams();
  for (const k of SEARCH_PARAM_KEYS) if (values[k].length > 0) q.set(k, values[k]);
  if (extras.flight && isIsoDate(extras.flight)) q.set("flight", extras.flight);
  if (extras.focus) q.set("focus", extras.focus);
  return q.toString();
}

// ───────────────────────── night ↔ flight ─────────────────────────

/** The default flight (departure) date for a hotel night: the morning after. Null for a non-date. */
export function flightDateForNight(night: string): string | null {
  return isIsoDate(night) ? shiftIsoDate(night, 1) : null;
}

/** The default hotel night for a flight date: the night before. Null for a non-date. */
export function nightForFlightDate(flight: string): string | null {
  return isIsoDate(flight) ? shiftIsoDate(flight, -1) : null;
}

/**
 * The flight date to show for a URL: its `flight` when that is a real date
 * the night can belong to (night + 1, or night + 2 for the red-eye choice);
 * otherwise night + 1. Null when the night isn't a date.
 */
export function resolveFlight(flightParam: string | null, night: string): string | null {
  if (!isIsoDate(night)) return null;
  if (flightParam !== null && isIsoDate(flightParam) && (flightParam === shiftIsoDate(night, 1) || flightParam === shiftIsoDate(night, 2))) {
    return flightParam;
  }
  return shiftIsoDate(night, 1);
}

export interface ParkStayDateBounds {
  /** Today at the airport. The hotel night may be today, never earlier (`night_past`). */
  today: string;
  /** Tomorrow at the airport — a flight today would make the night yesterday (review L-H1). */
  flightMin: string;
  /** The night may be up to PARK_STAY_MAX_NIGHT_AHEAD_DAYS ahead, so the flight one day more. */
  flightMax: string;
}

export function parkStayDateBounds(timeZone: string, now: Date): ParkStayDateBounds {
  const today = todayInZone(timeZone, now);
  return {
    today,
    flightMin: shiftIsoDate(today, 1),
    flightMax: shiftIsoDate(today, PARK_STAY_MAX_NIGHT_AHEAD_DAYS + 1),
  };
}

/** The latest return date for a night (plans.ts: 60 days after the night — not parking's 100). */
export function returnMaxForNight(night: string): string | null {
  return isIsoDate(night) ? shiftIsoDate(night, PARK_STAY_MAX_RETURN_AFTER_NIGHT_DAYS) : null;
}

/**
 * The nights offered for a FLIGHT (never for the night): the night before
 * (the default) and the one before that — for a flight just after midnight,
 * the night the customer actually sleeps at the hotel. Never before today.
 */
export function nightChoices(flight: string, today: string): string[] {
  if (!isIsoDate(flight)) return [];
  return [shiftIsoDate(flight, -1), shiftIsoDate(flight, -2)].filter((n) => n >= today);
}

/**
 * The latest day the shared DateRangePicker may offer. It takes ONE maxDate
 * for both legs, so it follows the phase: no flight yet → the flight limit;
 * flight picked, return cleared (the picker is on the return leg) → night +
 * 60; both set (either leg may be reopened) → the later of the two, and
 * checkSearchDates() names whichever rule a pick then breaks.
 */
export function pickerMaxDate(input: { flight: string; night: string; returnDate: string }, bounds: ParkStayDateBounds): string {
  const returnMax = isIsoDate(input.flight) ? returnMaxForNight(input.night) : null;
  if (returnMax === null) return bounds.flightMax;
  if (input.returnDate.length === 0) return returnMax;
  return returnMax > bounds.flightMax ? returnMax : bounds.flightMax;
}

export type DatesProblem = { field: "airport" | "flight" | "night" | "return"; message: string };

export const RETURN_BEFORE_FLIGHT = "Return date must be on or after your flight date.";

/**
 * The header's own date rules, checked before a submit so the customer gets
 * the reason at once. The server re-validates everything (parking-window.ts).
 * A reversed range is an error, never swapped.
 */
export function checkSearchDates(
  input: { airport: string; flight: string; night: string; returnDate: string },
  bounds: ParkStayDateBounds
): DatesProblem | null {
  if (input.airport.length === 0) return { field: "airport", message: "Choose an airport." };
  if (!isIsoDate(input.flight)) return { field: "flight", message: "Choose your flight date." };
  if (input.flight < bounds.flightMin) {
    return { field: "flight", message: "Park & Stay starts the night before your flight, so the flight must be tomorrow or later." };
  }
  if (input.flight > bounds.flightMax) {
    return { field: "flight", message: `Flights can be searched up to ${PARK_STAY_MAX_NIGHT_AHEAD_DAYS + 1} days ahead.` };
  }
  if (!isIsoDate(input.night) || input.night < bounds.today || !nightChoices(input.flight, bounds.today).includes(input.night)) {
    return { field: "night", message: "Choose the night you'll stay at the hotel." };
  }
  if (!isIsoDate(input.returnDate)) return { field: "return", message: "Choose your return date." };
  if (input.returnDate < input.flight) return { field: "return", message: RETURN_BEFORE_FLIGHT };
  const max = returnMaxForNight(input.night);
  if (max !== null && input.returnDate > max) {
    return { field: "return", message: `Park & Stay can be booked up to ${PARK_STAY_MAX_RETURN_AFTER_NIGHT_DAYS} days after the hotel night.` };
  }
  return null;
}

// ───────────────────────── the header's state ─────────────────────────

export interface HeaderFields {
  airport: string;
  flight: string;
  night: string;
  returnDate: string;
  arrivalTime: string;
  returnTime: string;
  adults: string;
}

/** The header's starting fields, from SANITISED URL values and the URL's `flight`. */
export function initialHeaderFields(values: ParkStaySearchValues, flightParam: string | null): HeaderFields {
  return {
    airport: values.airport,
    flight: resolveFlight(flightParam, values.night) ?? "",
    night: values.night,
    returnDate: values.returnDate,
    arrivalTime: values.arrivalTime,
    returnTime: values.returnTime,
    adults: values.adults,
  };
}

export type SubmitResult = { ok: true; href: string } | { ok: false; problem: DatesProblem };

/**
 * Where a submit goes: the date rules first; then /park-stay with every set
 * search key plus the page-only `flight` and `focus`. Missing details still
 * navigate (the URL then shows exactly what is set; the results stay idle
 * with the highlight).
 */
export function submitHref(fields: HeaderFields, bounds: ParkStayDateBounds, focus: string | null): SubmitResult {
  const problem = checkSearchDates(fields, bounds);
  if (problem) return { ok: false, problem };
  const values: ParkStaySearchValues = {
    airport: fields.airport,
    night: fields.night,
    arrivalTime: fields.arrivalTime,
    returnDate: fields.returnDate,
    returnTime: fields.returnTime,
    adults: fields.adults,
  };
  return { ok: true, href: `/park-stay?${parkStayPageQuery(values, { flight: fields.flight, focus })}` };
}

/**
 * The shared DateRangePicker SWAPS a return picked before the flight
 * (date-picker.tsx: onStartChange(earlier day) then onEndChange(old start)
 * in the same click). Park & Stay never swaps silently (review round 1,
 * item 2): the header remembers the start it just received and, when the
 * very next end is the old flight and the new start is earlier, rejects the
 * pick. A normal first click sends onEndChange("") after the start — not a
 * swap; a normal second click sends an end with no start before it.
 */
export function isPickerSwap(pending: { start: string; prevFlight: string } | null, end: string): boolean {
  return pending !== null && end !== "" && pending.prevFlight !== "" && pending.start < pending.prevFlight && end === pending.prevFlight;
}

// ───────────────────────── missing details ─────────────────────────

export const DETAIL_KEYS = ["arrivalTime", "returnTime", "adults"] as const satisfies readonly SearchParamKey[];
export type DetailKey = (typeof DETAIL_KEYS)[number];

/** The detail fields flagged missing (highlighted). */
export function missingDetails(values: Pick<ParkStaySearchValues, DetailKey>): DetailKey[] {
  return DETAIL_KEYS.filter((k) => values[k].length === 0);
}

export const DETAILS_PROMPT = "Add when you'll reach the hotel and the number of guests to see prices.";

/** The highlight prompt, or null when nothing is missing. Never a guessed value (plan §3). */
export function detailsPrompt(missing: readonly DetailKey[]): string | null {
  if (missing.length === 0) return null;
  if (missing.length === 1 && missing[0] === "returnTime") return "Add when you'll collect your car to see prices.";
  return DETAILS_PROMPT;
}

// ───────────────────────── the toggle back to parking ─────────────────────────

/**
 * "Parking only": /search?airport&checkin=<flight>&checkout=<returnDate>.
 * The check-in is the FLIGHT date (from resolveFlight — the URL's `flight`
 * or night + 1), the day the car would go to an airport lot. /search reads
 * exactly airport, checkin and checkout (search/page.tsx), so nothing else is
 * carried — no times it would ignore. Built from the URL values (what was
 * searched), never from a half-edited form. Null when the values can't make
 * a valid parking search (never swapped).
 */
export function parkingOnlyHref(values: Pick<ParkStaySearchValues, "airport" | "returnDate">, flight: string | null): string | null {
  if (!/^[A-Za-z]{3}$/.test(values.airport)) return null;
  if (flight === null || !isIsoDate(flight) || !isIsoDate(values.returnDate) || values.returnDate < flight) return null;
  const q = new URLSearchParams({ airport: values.airport.toUpperCase(), checkin: flight, checkout: values.returnDate });
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
