/**
 * Pure helpers for the funnel GA4 events (gtag.ts): the checkout_* events,
 * begin_checkout's value, and the date arithmetic the search event reuses.
 *
 * Why the funnel is instrumented (2026-10-06): of the people who opened
 * /checkout, 58% never reached the payment step and nothing said where they
 * left — the URL doesn't change between steps, and begin_checkout then fired
 * only once the PaymentIntent existed. (Since 2026-11-12 begin_checkout fires
 * with checkout_view; add_payment_info marks the payment step.)
 *
 * Privacy rule: these events carry field KEYS and fixed reason buckets only —
 * never what a customer typed and never a raw server message.
 */
import { STALE_CHECKOUT_MESSAGE } from "@/lib/parkguard/plans";
import type { CheckoutCostData } from "@/types/checkout";

export type CheckoutFunnelStep = "details" | "vehicle" | "payment";

export type CheckoutFailureReason =
  | "missing_times" // /checkout opened without check-in/out times
  | "no_lot" // /checkout opened without a lot id
  | "not_found" // 404 — the lot doesn't exist (any more)
  | "sold_out" // 409 / sold-out screen
  | "invalid_input" // 400 — the request was refused as invalid
  | "stale_quote" // the price/plan moved since the page loaded
  | "not_bookable" // a direct lot whose online booking isn't open yet
  | "unavailable" // 5xx — ResLab or our server failed
  | "network" // the request never got an HTTP answer
  | "client" // the form refused before sending (missing lot data)
  | "other";

/**
 * One reason bucket for a failed /api/checkout/lot call (load or PaymentIntent
 * creation). Keyed on the HTTP status first: the API's messages are mostly
 * generic ("Failed to create payment intent"), so text matching only picks
 * out the two cases whose status is shared with others.
 */
export function bucketCheckoutFailure(input: {
  status?: number;
  message?: string;
  code?: string;
  error?: unknown;
}): CheckoutFailureReason {
  const { status, message = "", code } = input;
  if (code === "direct_not_bookable_yet" || /not open yet/i.test(message)) return "not_bookable";
  if (message === STALE_CHECKOUT_MESSAGE || /out of date/i.test(message)) return "stale_quote";
  if (status === 404) return "not_found";
  if (status === 409 || /sold out/i.test(message)) return "sold_out";
  if (status === 400) return "invalid_input";
  if (status !== undefined && status >= 500) return "unavailable";
  if (status === undefined) {
    // fetch() rejects with a TypeError when no HTTP response arrived at all.
    if (input.error instanceof TypeError) return "network";
    if (input.error !== undefined) return "client";
  }
  return "other";
}

const GA4_PARAM_MAX = 100;

/**
 * Sorted, de-duplicated, comma-joined field keys, cut at a comma so it fits
 * GA4's 100-character parameter limit. Keys only — callers pass error-map
 * keys or data-funnel-field attribute values, never input values.
 */
export function fieldList(keys: Iterable<string>): string {
  const sorted = [...new Set([...keys].filter(Boolean))].sort();
  let out = "";
  for (const key of sorted) {
    const next = out ? `${out},${key}` : key;
    if (next.length > GA4_PARAM_MAX) break;
    out = next;
  }
  return out;
}

/**
 * Whole days from `today` to the check-in date, both literal YYYY-MM-DD
 * strings — calendar arithmetic only, no timezone conversion of the booking
 * date. Null if either doesn't parse.
 */
export function leadDays(checkin: string, today: string): number | null {
  const toUtc = (d: string) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
    return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : NaN;
  };
  const diff = (toUtc(checkin) - toUtc(today)) / 86_400_000;
  return Number.isFinite(diff) ? Math.round(diff) : null;
}

/** The visitor's own calendar date, YYYY-MM-DD (for lead_days only). */
export function deviceToday(now: Date = new Date()): string {
  // Built by hand: locale date formats (even en-CA) aren't guaranteed to be
  // YYYY-MM-DD in every browser.
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** The parts of the checkout load's cost data the analytics read. */
type LoadCostData = Pick<CheckoutCostData, "costsToken" | "grandTotal" | "serviceFee" | "soldOut" | "direct">;

/** How a checkout load that got an HTTP answer is reported. */
export type CheckoutLoadReport =
  | { failed: Extract<CheckoutFailureReason, "no_lot" | "sold_out"> }
  | { lotId: string; lotName: string; priced: 0 | 1; total: number | undefined };

/**
 * Decides what a loaded /checkout reports: a failure (no lot in the answer, or
 * sold out) sends checkout_load_failed; anything else sends checkout_view and
 * begin_checkout, with a total only when the load is priced.
 */
export function checkoutLoadReport(
  data: { lot?: { id: string; name: string } | null; costData?: LoadCostData | null } | null | undefined
): CheckoutLoadReport {
  if (!data?.lot) return { failed: "no_lot" };
  if (data.costData?.soldOut) return { failed: "sold_out" };
  return {
    lotId: data.lot.id,
    lotName: data.lot.name,
    priced: isPricedLoad(data.costData) ? 1 : 0,
    total: checkoutLoadValue(data.costData),
  };
}

/**
 * Whether a checkout load came back with a real price. A ResLab lot is priced
 * when it has a costs token (without one the page fell back to an estimate);
 * a direct lot never has a token and is priced by its own terms.
 */
export function isPricedLoad(costData: LoadCostData | null | undefined): boolean {
  if (!costData || costData.soldOut) return false;
  return costData.costsToken != null || costData.direct != null;
}

/**
 * The online total the customer sees when /checkout loads (the form's
 * priceBreakdown.total at that moment): the grand total, which includes any
 * part of the parking due at the lot, plus the service fee. No Park Guard and
 * no promo: neither is chosen yet. Not included: a direct lot's oversized-
 * vehicle surcharge, which is paid at the lot and shown as a separate "trip
 * total". Undefined when the load is not priced.
 */
export function checkoutLoadValue(costData: LoadCostData | null | undefined): number | undefined {
  if (!costData || !isPricedLoad(costData)) return undefined;
  const total = costData.grandTotal + costData.serviceFee;
  return Number.isFinite(total) ? Math.round(total * 100) / 100 : undefined;
}
