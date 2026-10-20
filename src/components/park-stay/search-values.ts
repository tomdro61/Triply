/**
 * The /park-stay search values and the rules that move between them (CX plan
 * v2 §2–3). Pure: no React, no fetch, the clock injected.
 *
 * Dates are literal airport-local "YYYY-MM-DD" strings. The customer picks a
 * FLIGHT date; the hotel night is the night before (flight − 1), editable,
 * and the night is what the URL carries (`night`). Every shift is calendar
 * arithmetic (dates.ts) — never toISOString() or ±86 400 000 ms, which a DST
 * day or a non-UTC browser would shift.
 */

import { isIsoDate, shiftIsoDate, todayInZone } from "@/lib/hotels/dates";
import { PARK_STAY_MAX_NIGHT_AHEAD_DAYS, PARK_STAY_MAX_RETURN_AFTER_NIGHT_DAYS } from "@/lib/hotels/plans";
import { SEARCH_PARAM_KEYS, type SearchParamKey } from "./format";

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

const HOTEL_KEY_RE = /^[a-z0-9-]{1,64}$/;

/** `focus` from the URL, or null when absent or not a possible hotel key. */
export function readFocus(params: { get(name: string): string | null }): string | null {
  const raw = params.get("focus");
  return raw !== null && HOTEL_KEY_RE.test(raw) ? raw : null;
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
 * The /park-stay URL for a submit: the non-empty search keys, then `focus`
 * when there is one. Every submit keeps `focus` (review C-H4) — the old form
 * rebuilt the URL from SEARCH_PARAM_KEYS only and dropped it.
 */
export function parkStayPageQuery(values: ParkStaySearchValues, focus: string | null): string {
  const q = new URLSearchParams();
  for (const k of SEARCH_PARAM_KEYS) if (values[k].length > 0) q.set(k, values[k]);
  if (focus) q.set("focus", focus);
  return q.toString();
}

// ───────────────────────── night ↔ flight ─────────────────────────

/** The flight (departure) date for a hotel night: the morning after. Null for a non-date. */
export function flightDateForNight(night: string): string | null {
  return isIsoDate(night) ? shiftIsoDate(night, 1) : null;
}

/** The default hotel night for a flight date: the night before. Null for a non-date. */
export function nightForFlightDate(flight: string): string | null {
  return isIsoDate(flight) ? shiftIsoDate(flight, -1) : null;
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
 * The nights offered for a flight: the night before (the default) and the one
 * before that — for a flight just after midnight, the night the customer
 * actually sleeps at the hotel. Never a night before today.
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

export type DatesProblem ={ field: "airport" | "flight" | "night" | "return"; message: string };

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
  if (!isIsoDate(input.night) || input.night < bounds.today || input.night >= input.flight) {
    return { field: "night", message: "Choose the night you'll stay at the hotel." };
  }
  if (!isIsoDate(input.returnDate)) return { field: "return", message: "Choose your return date." };
  if (input.returnDate < input.flight) return { field: "return", message: "Your return date must be on or after your flight date." };
  const max = returnMaxForNight(input.night);
  if (max !== null && input.returnDate > max) {
    return { field: "return", message: `Park & Stay can be booked up to ${PARK_STAY_MAX_RETURN_AFTER_NIGHT_DAYS} days after the hotel night.` };
  }
  return null;
}

// ───────────────────────── missing details ─────────────────────────

export const DETAIL_KEYS = ["arrivalTime", "returnTime", "adults"] as const satisfies readonly SearchParamKey[];
export type DetailKey = (typeof DETAIL_KEYS)[number];

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
 * "Parking only": /search?airport&checkin=<night + 1>&checkout=<returnDate>.
 * /search reads exactly airport, checkin and checkout (search/page.tsx), so
 * nothing else is carried — no times it would ignore. Built from the URL
 * values (what was searched), never from a half-edited form. Null when the
 * values can't make a valid parking search.
 */
export function parkingOnlyHref(values: Pick<ParkStaySearchValues, "airport" | "night" | "returnDate">): string | null {
  if (!/^[A-Za-z]{3}$/.test(values.airport)) return null;
  const checkin = flightDateForNight(values.night);
  if (checkin === null || !isIsoDate(values.returnDate) || values.returnDate < checkin) return null;
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
