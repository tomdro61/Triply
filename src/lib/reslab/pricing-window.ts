/**
 * The window a ResLab lot is PRICED with when the customer hasn't picked
 * times yet (search results, the lot page). Shared so the two can't disagree:
 * before 2026-10-06 search priced a same-day lot at its own notice-adjusted
 * time while the lot page priced it at now + 30 min, which ResLab refused —
 * so a lot listed with a price in search showed $0.00/day on its own page.
 *
 * Pricing only: results are "from $X" estimates and the customer must choose
 * real times before checkout; /api/checkout/lot prices with those and never
 * goes through here.
 */
import type { ReslabLocation } from "@/lib/reslab/client";
import {
  bookableCheckinTimes,
  convertTo24Hour,
  isValidTimeZone,
  resolvePricingTimes,
  SAME_DAY_LEAD_MINUTES,
  type PricingTimes,
} from "@/lib/utils/time";

export interface PricingWindowInput {
  checkin: string; // YYYY-MM-DD
  checkout: string; // YYYY-MM-DD
  airportTimeZone: string;
  /** Raw caller/URL times ("h:mm AM"); either may be absent. */
  checkinTime?: string;
  checkoutTime?: string;
  now?: Date;
}

export interface PricingWindow {
  fromDate: string; // "YYYY-MM-DD HH:mm:ss", airport-local, never converted
  toDate: string;
}

/**
 * A supplied check-in time that can no longer be booked today (an old shared
 * link, chat relaying "9 AM" at 3 PM) can't price — ResLab 422s it and the
 * search would read as an outage. Dropped for PRICING only, so the default
 * applies; the customer's own pick is gated separately in the time pickers.
 */
export function usableCheckinTime(
  checkinTime: string | undefined,
  checkin: string,
  airportTimeZone: string,
  now: Date = new Date()
): string | undefined {
  if (!checkinTime) return undefined;
  return bookableCheckinTimes([checkinTime], checkin, airportTimeZone, 0, now).length > 0
    ? checkinTime
    : undefined;
}

/** Airport-level pricing times (see resolvePricingTimes), with a passed
 *  supplied check-in time dropped first. */
export function airportPricingTimes(input: PricingWindowInput): PricingTimes {
  const now = input.now ?? new Date();
  return resolvePricingTimes({
    checkinDate: input.checkin,
    checkoutDate: input.checkout,
    timeZone: input.airportTimeZone,
    checkinTime: usableCheckinTime(input.checkinTime, input.checkin, input.airportTimeZone, now),
    checkoutTime: input.checkoutTime,
    now,
  });
}

export function toPricingWindow(
  checkin: string,
  checkout: string,
  times: { checkinTime: string; checkoutTime: string }
): PricingWindow {
  return {
    fromDate: `${checkin} ${convertTo24Hour(times.checkinTime)}:00`,
    toDate: `${checkout} ${convertTo24Hour(times.checkoutTime)}:00`,
  };
}

/**
 * One ResLab lot's pricing window, or null when the lot can't take a booking
 * for that check-in (the date has passed there, or it is today and no slot
 * clears the lot's notice period). Judged in the lot's own timezone — ResLab
 * checks "in the future" in lot-local time; an invalid zone falls back to the
 * airport's — with the lot's `hours_before_reservation` as the minimum lead.
 * A caller's check-in time is used only if THIS lot can still take it today;
 * otherwise the lot prices from its own earliest slot (pricing only — the
 * customer's pick is gated separately in the time pickers).
 */
export function reslabLotPricingWindow(
  location: Pick<ReslabLocation, "hours_before_reservation" | "timezone">,
  input: PricingWindowInput
): PricingWindow | null {
  const now = input.now ?? new Date();
  const { checkin, checkout, airportTimeZone, checkoutTime } = input;
  const lotZone = location.timezone?.code;
  const timeZone = isValidTimeZone(lotZone) ? lotZone : airportTimeZone;
  const notice = location.hours_before_reservation || 0;
  const checkinTime =
    input.checkinTime &&
    bookableCheckinTimes([input.checkinTime], checkin, timeZone, notice, now).length > 0
      ? input.checkinTime
      : undefined;
  const times = resolvePricingTimes({
    checkinDate: checkin,
    checkoutDate: checkout,
    timeZone,
    checkinTime,
    checkoutTime,
    leadMinutes: Math.max(SAME_DAY_LEAD_MINUTES, notice * 60),
    now,
  });
  return times.ok ? toPricingWindow(checkin, checkout, times) : null;
}
