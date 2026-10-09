import { fetchDirectLot, isSellable, type DirectLot } from "./store";
import { computeDirectQuote, directDays, wallClockMinutes, type DirectQuote } from "./pricing";
import { zonedWallClock, SAME_DAY_LEAD_MINUTES } from "@/lib/utils/time";

/**
 * The ONE place a direct-lot checkout is validated and priced (plan A-28), so
 * GET (the checkout page) and POST (the PaymentIntent) can never disagree.
 * Reads the lot fresh (no request cache) — POST charges from what this returns.
 *
 * Refuses, with a customer-safe message:
 *   503  the lot could not be read (or its row is broken) — unknown, not "gone"
 *   404  no such lot, or not sellable here (draft / inactive / other environment)
 *   400  reversed or unparseable range, below the minimum stay, inside the
 *        lot's notice period (checked in the AIRPORT's wall clock)
 */
export type DirectCheckoutQuote =
  | { ok: true; lot: DirectLot; days: number; quote: DirectQuote }
  | { ok: false; status: 400 | 404 | 503; error: string; code: string };

export interface DirectCheckoutQuoteInput {
  payloadId: number;
  /** "YYYY-MM-DD HH:MM:SS" airport-local wall clock, as the route builds it. Never parsed as a Date. */
  fromDate: string;
  toDate: string;
  discountPercent?: number;
  endpoint: string;
  now?: Date;
}

export async function quoteDirectCheckout(input: DirectCheckoutQuoteInput): Promise<DirectCheckoutQuote> {
  const { payloadId, fromDate, toDate, discountPercent = 0, endpoint, now = new Date() } = input;

  const lookup = await fetchDirectLot(payloadId, endpoint);
  if (lookup.status === "unavailable" || lookup.status === "invalid") {
    return { ok: false, status: 503, error: "Parking data is temporarily unavailable", code: "direct_unavailable" };
  }
  if (lookup.status === "not_found" || !isSellable(lookup.lot)) {
    return { ok: false, status: 404, error: "Lot not found", code: "direct_not_found" };
  }
  const lot = lookup.lot;

  const range = directDays(fromDate, toDate);
  if (!range.ok) {
    return { ok: false, status: 400, error: "Your pick-up must be after your drop-off.", code: range.reason };
  }
  if (range.days < lot.minStayDays) {
    return {
      ok: false,
      status: 400,
      error: `This lot has a ${lot.minStayDays}-day minimum stay.`,
      code: "below_min_stay",
    };
  }

  // Lead time: both ends in the airport's wall clock (no timezone conversion
  // of the booking time — only "now" is read in the airport's zone).
  const clock = zonedWallClock(lot.timezone, now);
  const nowMinutes = wallClockMinutes(`${clock.date} 00:00`);
  const checkinMinutes = wallClockMinutes(fromDate);
  if (nowMinutes === null || checkinMinutes === null) {
    return { ok: false, status: 400, error: "Invalid drop-off time.", code: "invalid_datetime" };
  }
  const leadMinutes = Math.max(SAME_DAY_LEAD_MINUTES, Math.round(lot.minLeadHours * 60));
  if (checkinMinutes - (nowMinutes + Math.floor(clock.secondsOfDay / 60)) < leadMinutes) {
    return {
      ok: false,
      status: 400,
      error:
        lot.minLeadHours > 0
          ? `This lot needs at least ${lot.minLeadHours} hour${lot.minLeadHours === 1 ? "" : "s"} notice. Please choose a later drop-off time.`
          : "Please choose a later drop-off time.",
      code: "inside_notice_period",
    };
  }

  const quote = computeDirectQuote({
    rateCents: lot.rateCents,
    days: range.days,
    taxRatePercent: lot.taxRatePercent,
    discountPercent,
  });
  return { ok: true, lot, days: range.days, quote };
}
