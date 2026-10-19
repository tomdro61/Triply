/**
 * Park & Stay search inputs and the parking window (plan v3 §4, PRD M2 as
 * amended by D3). Pure: the clock is injected (`now`), nothing reads the
 * environment, nothing imports ResLab.
 *
 * - The customer gives the hotel NIGHT, their ARRIVAL time at the hotel
 *   (parking starts then), and their RETURN date and time (parking ends
 *   then). All required; there is no fixed 4 PM start — a start time we chose
 *   could add a whole 24-hour block, which would be a silent default (§4.2).
 * - Departure = hotel check-out = night + 1 (shown, not asked).
 * - Every date is a literal airport-local "YYYY-MM-DD" string; every time a
 *   strictly parsed "h:mm AM|PM". ResLab receives "YYYY-MM-DD HH:mm:ss"
 *   built from those literals, never through a Date.
 * - "Today" is today at the AIRPORT (B8), and the notice period is judged in
 *   the LOT's own timezone (the reslabLotPricingWindow rule).
 */

import { isValidTimeZone, parseTime12Strict, SAME_DAY_LEAD_MINUTES, zonedWallClock } from "@/lib/utils/time";
import { isIsoDate, isoDayDiff, shiftIsoDate, todayInZone } from "./dates";
import {
  PARK_STAY_ARRIVAL_FIRST_MINUTES,
  PARK_STAY_ARRIVAL_LAST_MINUTES,
  PARK_STAY_MAX_NIGHT_AHEAD_DAYS,
  PARK_STAY_MAX_RETURN_AFTER_NIGHT_DAYS,
  PARK_STAY_TIME_SLOT_MINUTES,
} from "./plans";

export interface ParkStayWindowInput {
  night: string;
  arrivalTime: string;
  returnDate: string;
  returnTime: string;
  airportTimeZone: string;
  now: Date;
}

export interface ParkStayWindow {
  /** Hotel check-in date. */
  night: string;
  /** Hotel check-out = departure day = night + 1. */
  departureDate: string;
  arrivalTime: string;
  arrivalMinutes: number;
  returnDate: string;
  returnTime: string;
  returnMinutes: number;
  /** ResLab `from_date` / `to_date`: "YYYY-MM-DD HH:mm:ss", airport-local literals. */
  fromDate: string;
  toDate: string;
}

export type ParkStayWindowField = "night" | "arrivalTime" | "returnDate" | "returnTime";

export type ParkStayWindowError = {
  field: ParkStayWindowField;
  code:
    | "night_invalid"
    | "night_past"
    | "night_too_far"
    | "arrival_invalid"
    | "arrival_off_grid"
    | "return_date_invalid"
    | "return_before_departure"
    | "return_too_far"
    | "return_time_invalid";
  message: string;
};

export type ParkStayWindowResult = { ok: true; window: ParkStayWindow } | { ok: false; error: ParkStayWindowError };

function hhmmss(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`;
}

function fail(field: ParkStayWindowField, code: ParkStayWindowError["code"], message: string): ParkStayWindowResult {
  return { ok: false, error: { field, code, message } };
}

/** Is `minutes` an offered arrival slot (12:00 PM – 11:30 PM on the :00/:30 grid)? */
export function isArrivalSlot(minutes: number): boolean {
  return (
    minutes >= PARK_STAY_ARRIVAL_FIRST_MINUTES &&
    minutes <= PARK_STAY_ARRIVAL_LAST_MINUTES &&
    minutes % PARK_STAY_TIME_SLOT_MINUTES === 0
  );
}

/** Validate the four window inputs (§4.1). Never substitutes a value. */
export function validateParkStayWindow(input: ParkStayWindowInput): ParkStayWindowResult {
  const { night, arrivalTime, returnDate, returnTime, airportTimeZone, now } = input;

  if (!isIsoDate(night)) return fail("night", "night_invalid", "Choose the night of your hotel stay (YYYY-MM-DD).");
  const today = todayInZone(airportTimeZone, now);
  if (night < today) return fail("night", "night_past", "The hotel night can't be in the past.");
  if (night > shiftIsoDate(today, PARK_STAY_MAX_NIGHT_AHEAD_DAYS)) {
    return fail("night", "night_too_far", `The hotel night must be within ${PARK_STAY_MAX_NIGHT_AHEAD_DAYS} days.`);
  }

  const arrivalMinutes = parseTime12Strict(arrivalTime);
  if (arrivalMinutes === null) return fail("arrivalTime", "arrival_invalid", "Choose when you arrive at the hotel (h:mm AM/PM).");
  if (!isArrivalSlot(arrivalMinutes)) {
    return fail("arrivalTime", "arrival_off_grid", "Arrival must be between 12:00 PM and 11:30 PM, on the hour or half hour.");
  }

  if (!isIsoDate(returnDate)) return fail("returnDate", "return_date_invalid", "Choose the date you return (YYYY-MM-DD).");
  const departureDate = shiftIsoDate(night, 1);
  if (returnDate < departureDate) {
    return fail("returnDate", "return_before_departure", "Your return must be on or after your departure day (the morning after the hotel night).");
  }
  if (returnDate > shiftIsoDate(night, PARK_STAY_MAX_RETURN_AFTER_NIGHT_DAYS)) {
    return fail("returnDate", "return_too_far", `Your return must be within ${PARK_STAY_MAX_RETURN_AFTER_NIGHT_DAYS} days of the hotel night.`);
  }

  const returnMinutes = parseTime12Strict(returnTime);
  if (returnMinutes === null) return fail("returnTime", "return_time_invalid", "Choose when you collect your car (h:mm AM/PM).");

  return {
    ok: true,
    window: {
      night,
      departureDate,
      arrivalTime,
      arrivalMinutes,
      returnDate,
      returnTime,
      returnMinutes,
      fromDate: `${night} ${hhmmss(arrivalMinutes)}`,
      toDate: `${returnDate} ${hhmmss(returnMinutes)}`,
    },
  };
}

/** Wall-clock minutes from parking start to parking end (literal strings, no DST math). */
export function parkingMinutes(w: ParkStayWindow): number {
  return isoDayDiff(w.night, w.returnDate) * 1440 + w.returnMinutes - w.arrivalMinutes;
}

/** Number of 24-hour blocks an hourly lot bills (ResLab `calculateDays` hourly rule). */
export function parking24hBlocks(w: ParkStayWindow): number {
  return Math.ceil(parkingMinutes(w) / 1440);
}

/** The lot facts the per-hotel rules need — a narrow shape so this module never imports ResLab. */
export interface LotWindowFacts {
  hoursBeforeReservation: number;
  minimumBookingDays: number;
  dailyOrHourly: "daily" | "hourly";
  /** The lot's IANA zone, or null; an invalid zone falls back to the airport's. */
  timeZone: string | null;
}

/** Days ResLab counts for the stay: hourly → 24-hour blocks; daily → calendar days inclusive. */
export function bookedDays(w: ParkStayWindow, lot: Pick<LotWindowFacts, "dailyOrHourly">): number {
  return lot.dailyOrHourly === "daily" ? isoDayDiff(w.night, w.returnDate) + 1 : parking24hBlocks(w);
}

export type LotWindowVerdict = "ok" | "notice_period" | "min_stay";

/**
 * §4.3, applied to EVERY night (not only tonight):
 *  1. Notice: the parking start must be at least now + max(SAME_DAY_LEAD_MINUTES,
 *     hours_before_reservation × 60), measured in the lot's own timezone.
 *  2. Minimum stay: minimum_booking_days > 0 and fewer days than that → hidden.
 */
export function lotWindowVerdict(
  w: ParkStayWindow,
  lot: LotWindowFacts,
  airportTimeZone: string,
  now: Date
): LotWindowVerdict {
  const zone = isValidTimeZone(lot.timeZone) ? lot.timeZone : airportTimeZone;
  const wall = zonedWallClock(zone, now);
  const hours = Number.isFinite(lot.hoursBeforeReservation) && lot.hoursBeforeReservation > 0 ? lot.hoursBeforeReservation : 0;
  const leadMinutes = Math.max(SAME_DAY_LEAD_MINUTES, hours * 60);
  const minutesUntilStart = isoDayDiff(wall.date, w.night) * 1440 + w.arrivalMinutes - wall.secondsOfDay / 60;
  if (minutesUntilStart < leadMinutes) return "notice_period";
  const minDays = Number.isFinite(lot.minimumBookingDays) && lot.minimumBookingDays > 0 ? lot.minimumBookingDays : 0;
  if (minDays > 0 && bookedDays(w, lot) < minDays) return "min_stay";
  return "ok";
}
