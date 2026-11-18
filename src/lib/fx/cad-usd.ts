/**
 * Canadian dollars → US dollars for ResLab lots priced in CAD (Toronto,
 * Montreal, Calgary, Ottawa).
 *
 * Rules this file exists to hold:
 *  - ONE rate per booking. It is chosen when the PaymentIntent is created,
 *    stamped on it, and fulfilment and the confirmation page convert with
 *    THAT rate — never with the current constant. Accounting converts
 *    ResLab's Canadian-dollar figures with the rate stored on the booking row
 *    (lib/accounting/reconcile.ts, `inUsDollars`): an estimate, because ResLab
 *    invoices at its own rate on the invoice date.
 *  - The rate is a code constant, changed by a PR. No outside service sits on
 *    the money path, and the page, the charge and the booking cannot disagree.
 *  - Integer arithmetic only: cents × micro-rate ÷ 1,000,000, half-up.
 *  - Refuse, never repair: a ResLab answer whose parts do not add up to its
 *    total is refused before any charge (stricter than a US lot, whose parts
 *    only the confirmation page's cost breakdown checks).
 *  - toUsd, readFxStamp and the conversion helpers are pure and never throw:
 *    `fromReslab` calls toUsd after a reservation number is recorded, where a
 *    throw would strand a live booking.
 */

export interface FxRate {
  /** Names the rate; a checkout page sends it back so a rate change mid-checkout is refused.
   *  A new rate MUST get a new id: the stale-page checks compare ids only. */
  id: string;
  /** US-dollar millionths per one Canadian dollar (0.725000 → 725_000). */
  micros: number;
}

export interface FxRateSetting extends FxRate {
  /** Last day (UTC, inclusive) the rate may be used for a NEW booking. After
   *  it, Canadian lots hide themselves until a PR sets a fresh rate. */
  validUntil: string;
}

/**
 * The rate for NEW bookings, or `null` for no rate on purpose: Canadian lots
 * are hidden everywhere and nothing warns.
 *
 * To put those lots on sale, replace `null` with
 * `{ id, micros, validUntil }`: a NEW id (never one used before), the figure,
 * and the last day it may be used. To stop on purpose, set it back to `null`:
 * a past `validUntil` is "expired", which the daily digest flags every day.
 * The test "the shipped setting" in __tests__/cad-usd.test.ts pins this value
 * and must change with it.
 */
const CAD_USD: FxRateSetting | null = null;

/** Days ahead of the last valid day that the daily digest starts warning. */
export const CAD_RATE_WARN_DAYS = 7;

/**
 * Whether Park Guard protection is offered on a lot whose price we convert
 * (today: lots in Canada). Off until Park Guard confirms a plan applies to a
 * vehicle parked in Canada. Enforced in the checkout POST and /update-pi; the
 * checkout page hides the selector from the same constant. Before turning
 * it on: the plan selector (components/checkout/protection-plan.tsx) prints
 * its prices with a bare "$" and needs the "US$" label first.
 */
export const PARK_GUARD_ON_CONVERTED_LOTS = false;

const MICROS = 1_000_000;
/** 0.5 < rate < 1.0 — also catches a rate entered upside down (USD→CAD is above 1). */
const MIN_MICROS = 500_000;
const MAX_MICROS = 1_000_000;

export function isUsableRate(rate: { id?: unknown; micros?: unknown } | null | undefined): rate is FxRate {
  return (
    !!rate &&
    typeof rate.id === "string" &&
    rate.id.length > 0 &&
    // The checkout and quote schemas cap the id they carry at 40 characters.
    rate.id.length <= 40 &&
    typeof rate.micros === "number" &&
    Number.isSafeInteger(rate.micros) &&
    rate.micros > MIN_MICROS &&
    rate.micros < MAX_MICROS
  );
}

/** Midnight UTC of a real calendar day written YYYY-MM-DD, in ms; null for anything else ("2026-02-30", "soon"). */
function utcDayMs(day: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const ms = Date.parse(`${day}T00:00:00Z`);
  return Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== day ? null : ms;
}

/**
 * Where the rate for new bookings stands. `currentCadRate` is derived from
 * this, so what is on sale and what the warning says cannot disagree.
 */
export type CadRateStatus =
  /** No rate on purpose (the setting is null). Lots hidden, no warning. */
  | { kind: "off" }
  /** A rate was set but its id, figure or date is not usable (or the clock is not a real time). Lots hidden. */
  | { kind: "unusable" }
  /** A rate was set and its last day has passed. Lots hidden. */
  | { kind: "expired"; validUntil: string }
  /** On sale. `daysLeft` = whole UTC days to the last valid day (0 on that day). */
  | { kind: "live"; rate: FxRate; validUntil: string; daysLeft: number };

export function cadRateStatus(now: Date = new Date(), setting: FxRateSetting | null = CAD_USD): CadRateStatus {
  if (setting === null) return { kind: "off" };
  const rate = { id: setting.id, micros: setting.micros };
  const lastDay = utcDayMs(setting.validUntil);
  const today = Number.isNaN(now.getTime()) ? null : utcDayMs(now.toISOString().slice(0, 10));
  if (!isUsableRate(rate) || lastDay === null || today === null) return { kind: "unusable" };
  if (today > lastDay) return { kind: "expired", validUntil: setting.validUntil };
  return { kind: "live", rate, validUntil: setting.validUntil, daysLeft: Math.round((lastDay - today) / 86_400_000) };
}

/** The rate a new Canadian booking may use today, or null (expired / not set / not sane). */
export function currentCadRate(now: Date = new Date(), setting: FxRateSetting | null = CAD_USD): FxRate | null {
  const status = cadRateStatus(now, setting);
  return status.kind === "live" ? status.rate : null;
}

/**
 * The daily digest's line about the rate, or null when there is nothing to
 * say (no rate on purpose, or more than CAD_RATE_WARN_DAYS left). The last
 * valid day ends at midnight UTC, which is 7:00 PM Eastern (EST) or 8:00 PM
 * (EDT), so on the last day the flag says TONIGHT.
 */
export function cadRateFlag(status: CadRateStatus): string | null {
  const lots = "Toronto, Montreal, Calgary and Ottawa lots";
  const effect = "their pages return 404 and drop out of the sitemap at its next rebuild, until a PR sets a new rate (src/lib/fx/cad-usd.ts)";
  switch (status.kind) {
    case "off":
      return null;
    case "unusable":
      return `Canadian exchange rate is set but not usable. ${lots} are off sale: ${effect}.`;
    case "expired":
      return `Canadian exchange rate expired after ${status.validUntil} (UTC). ${lots} are off sale: ${effect}.`;
    case "live": {
      if (status.daysLeft > CAD_RATE_WARN_DAYS) return null;
      const when =
        status.daysLeft === 0
          ? "TONIGHT (midnight UTC, the evening in US Eastern time)"
          : `in ${status.daysLeft} day${status.daysLeft === 1 ? "" : "s"} (last day ${status.validUntil}, ending midnight UTC)`;
      return `Canadian exchange rate expires ${when}. After that, ${lots} come off sale: ${effect}.`;
    }
  }
}

/** Whole CAD cents → whole USD cents, half-up. null when an input is not a non-negative whole number. */
export function cadCentsToUsdCents(cadCents: number, rate: FxRate): number | null {
  if (!Number.isSafeInteger(cadCents) || cadCents < 0 || !isUsableRate(rate)) return null;
  const product = cadCents * rate.micros;
  if (!Number.isSafeInteger(product)) return null;
  return Math.floor((product + MICROS / 2) / MICROS);
}

/** Dollars with at most two decimals → whole cents; null for anything else (NaN, negative, 3+ decimals). */
function wholeCents(dollars: unknown): number | null {
  if (typeof dollars !== "number" || !Number.isFinite(dollars) || dollars < 0) return null;
  const cents = Math.round(dollars * 100);
  if (!Number.isSafeInteger(cents) || Math.abs(dollars * 100 - cents) > 1e-6) return null;
  return cents;
}

/**
 * One amount as ResLab sends it: a number, or a numeric string. NaN for
 * anything else (missing, empty, text).
 */
export function reslabAmount(value: unknown): number {
  return typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
}

/**
 * One ResLab amount in whole cents, or null when it is missing or is not a
 * non-negative amount in whole cents. Accounting reads a Canadian
 * reservation's settlement figures through this: an unreadable figure stays
 * unknown, it never becomes 0.
 */
export function reslabAmountCents(value: unknown): number | null {
  return wholeCents(reslabAmount(value));
}

/**
 * One CAD amount as ResLab sends it → US dollars at `rate`. null for anything
 * `reslabAmountCents` refuses: the caller decides what an unconvertible figure
 * means.
 */
export function cadDollarsToUsd(value: unknown, rate: FxRate): number | null {
  const cents = reslabAmountCents(value);
  if (cents === null) return null;
  const usdCents = cadCentsToUsdCents(cents, rate);
  return usdCents === null ? null : usdCents / 100;
}

/**
 * The money parts of one ResLab price, in dollars. Both ResLab shapes map onto
 * it: cost / min-price (`sub_total`, `fees_total`, `tax_total`,
 * `due_at_location`) and reservation history (`subtotal`, `total_fees`,
 * `total_tax`, `due_at_location_total`). ResLab's own sum is
 * grand = subtotal + fees − long-stay discount + tax (cost-breakdown.ts).
 */
export interface ReslabMoneyParts {
  subtotal: number;
  feesTotal: number;
  taxTotal: number;
  longTermDiscount: number;
  grandTotal: number;
  dueAtLocation: number;
}

export type FxUnusable =
  | "bad_rate"
  | "bad_amount"
  | "parts_do_not_add_up"
  | "due_above_total";

export type FxResult =
  | { ok: true; usd: ReslabMoneyParts; usdCents: Record<keyof ReslabMoneyParts, number> }
  | { ok: false; reason: FxUnusable };

/**
 * Convert one ResLab price from CAD to USD.
 *
 * 1. Every part must be a non-negative amount in whole cents.
 * 2. The CAD parts must add up to the CAD total EXACTLY — a ResLab answer that
 *    does not is refused, not repaired.
 * 3. Each part is converted on its own (`feesTotal` as ONE figure: the fee list
 *    is never summed, and a percentage fee's `amount` is a percent, not money).
 * 4. The USD total is derived from the converted parts, so the same exact sum
 *    holds in USD and both ResLab shapes give the same figures.
 * 5. The pay-at-lot amount may not exceed the total (refused, never capped).
 */
export function toUsd(cad: ReslabMoneyParts, rate: FxRate): FxResult {
  if (!isUsableRate(rate)) return { ok: false, reason: "bad_rate" };
  const sub = wholeCents(cad?.subtotal);
  const fees = wholeCents(cad?.feesTotal);
  const tax = wholeCents(cad?.taxTotal);
  const ltd = wholeCents(cad?.longTermDiscount);
  const grand = wholeCents(cad?.grandTotal);
  const due = wholeCents(cad?.dueAtLocation);
  if (sub === null || fees === null || tax === null || ltd === null || grand === null || due === null) {
    return { ok: false, reason: "bad_amount" };
  }
  if (sub + fees - ltd + tax !== grand) return { ok: false, reason: "parts_do_not_add_up" };
  if (due > grand) return { ok: false, reason: "due_above_total" };

  const uSub = cadCentsToUsdCents(sub, rate);
  const uFees = cadCentsToUsdCents(fees, rate);
  const uTax = cadCentsToUsdCents(tax, rate);
  const uLtd = cadCentsToUsdCents(ltd, rate);
  const uDue = cadCentsToUsdCents(due, rate);
  if (uSub === null || uFees === null || uTax === null || uLtd === null || uDue === null) {
    return { ok: false, reason: "bad_amount" };
  }
  const uGrand = uSub + uFees - uLtd + uTax;
  // Rounding each part can leave the discount a cent above what it reduces, or
  // the pay-at-lot share a cent above the derived total. Both are refused.
  if (uGrand < 0) return { ok: false, reason: "parts_do_not_add_up" };
  if (uDue > uGrand) return { ok: false, reason: "due_above_total" };

  const usdCents = { subtotal: uSub, feesTotal: uFees, taxTotal: uTax, longTermDiscount: uLtd, grandTotal: uGrand, dueAtLocation: uDue };
  return {
    ok: true,
    usdCents,
    usd: {
      subtotal: uSub / 100,
      feesTotal: uFees / 100,
      taxTotal: uTax / 100,
      longTermDiscount: uLtd / 100,
      grandTotal: uGrand / 100,
      dueAtLocation: uDue / 100,
    },
  };
}

// ---------------------------------------------------------------------------
// The stamp on the PaymentIntent
// ---------------------------------------------------------------------------

/** PaymentIntent metadata keys. `reslabCurrency` is written for EVERY ResLab
 *  PaymentIntent ("USD" or "CAD"), so a missing key only ever means "created
 *  before this shipped" — never "probably a US lot". */
export const FX_KEYS = {
  currency: "reslabCurrency",
  rateId: "fxRateId",
  rateMicros: "fxRateMicros",
  /** Converted PaymentIntents only: the wording version of the "charged in
   *  US dollars" sentence that the checkout page sent with its payment request
   *  (its bundle's CURRENCY_NOTICE_VERSION; the POST refuses any other).
   *  Written by the checkout POST, not by fxStampMetadata. A record for a
   *  dispute; nothing reads it to decide money. */
  notice: "currencyNotice",
} as const;

export function fxStampMetadata(rate: FxRate | null): Record<string, string> {
  if (rate === null) return { [FX_KEYS.currency]: "USD" };
  return { [FX_KEYS.currency]: "CAD", [FX_KEYS.rateId]: rate.id, [FX_KEYS.rateMicros]: String(rate.micros) };
}

export type FxStamp =
  /** A US lot: no conversion. */
  | { kind: "usd" }
  | { kind: "cad"; rate: FxRate }
  /** No stamp at all: a PaymentIntent created before the stamp existed. */
  | { kind: "absent" }
  /** A stamp that cannot be trusted (unknown currency, missing or insane rate). */
  | { kind: "invalid" };

export function readFxStamp(metadata: Record<string, string | undefined> | null | undefined): FxStamp {
  const currency = metadata?.[FX_KEYS.currency];
  const rateId = metadata?.[FX_KEYS.rateId];
  const rateMicros = metadata?.[FX_KEYS.rateMicros];
  if (currency === undefined) {
    // Rate keys with no currency key is a half-written stamp, not "absent".
    return rateId === undefined && rateMicros === undefined ? { kind: "absent" } : { kind: "invalid" };
  }
  if (currency === "USD") {
    return rateId === undefined && rateMicros === undefined ? { kind: "usd" } : { kind: "invalid" };
  }
  if (currency !== "CAD" || rateMicros === undefined || !/^\d{6}$/.test(rateMicros)) return { kind: "invalid" };
  const rate = { id: rateId, micros: Number(rateMicros) };
  return isUsableRate(rate) ? { kind: "cad", rate } : { kind: "invalid" };
}

/** The rate as stored on the booking row (`bookings.fx_rate numeric(10,6)`): exact, six decimals. */
export function rateToColumn(rate: FxRate): string {
  return (rate.micros / MICROS).toFixed(6);
}

/** Read `bookings.fx_rate` back. null for anything that is not an exact, sane six-decimal rate. */
export function rateFromColumn(value: unknown, id = "booking"): FxRate | null {
  const text = typeof value === "number" ? value.toFixed(6) : typeof value === "string" ? value.trim() : "";
  const m = /^0\.(\d{1,6})$/.exec(text);
  if (!m) return null;
  const rate = { id, micros: Number(m[1].padEnd(6, "0")) };
  return isUsableRate(rate) ? rate : null;
}
