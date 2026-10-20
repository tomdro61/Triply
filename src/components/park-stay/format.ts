/**
 * Display helpers for Park & Stay. Dates are literal "YYYY-MM-DD" strings
 * (airport-local); the weekday is computed with Date.UTC calendar math, never
 * by parsing the string as an instant.
 */

import { minutesTo12Hour } from "@/lib/utils/time";
import {
  PARK_STAY_ARRIVAL_FIRST_MINUTES,
  PARK_STAY_ARRIVAL_LAST_MINUTES,
  PARK_STAY_TIME_SLOT_MINUTES,
} from "@/lib/hotels/plans";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatCents(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

/** "2026-11-15" → "Sun 15 Nov". Returns the input unchanged if it isn't a date. */
export function formatIsoDay(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const weekday = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
  return `${DAYS[weekday]} ${d} ${MONTHS[mo - 1]}`;
}

/** "2026-11-15 18:00:00" → "Sun 15 Nov, 6:00 PM". */
export function formatReslabDateTime(value: string): string {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2})/.exec(value);
  if (!m) return value;
  return `${formatIsoDay(m[1])}, ${minutesTo12Hour(Number(m[2]) * 60 + Number(m[3]))}`;
}

function slots(first: number, last: number): string[] {
  const out: string[] = [];
  for (let t = first; t <= last; t += PARK_STAY_TIME_SLOT_MINUTES) out.push(minutesTo12Hour(t));
  return out;
}

/** Arrival at the hotel: 12:00 PM – 11:30 PM on the :00/:30 grid (plan v3 §4.1). */
export const ARRIVAL_TIME_OPTIONS: readonly string[] = slots(PARK_STAY_ARRIVAL_FIRST_MINUTES, PARK_STAY_ARRIVAL_LAST_MINUTES);
/** Collecting the car: the parking pickers' 12:00 AM – 11:30 PM grid. */
export const RETURN_TIME_OPTIONS: readonly string[] = slots(0, 23 * 60 + 30);

export const SEARCH_PARAM_KEYS = ["airport", "night", "arrivalTime", "returnDate", "returnTime", "adults"] as const;
export type SearchParamKey = (typeof SEARCH_PARAM_KEYS)[number];
