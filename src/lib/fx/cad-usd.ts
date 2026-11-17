/**
 * Canadian dollars → US dollars for ResLab lots priced in CAD (Toronto,
 * Montreal, Calgary, Ottawa).
 *
 * Rules this file exists to hold:
 *  - ONE rate per booking. It is chosen when the PaymentIntent is created,
 *    stamped on it, and fulfilment and the confirmation page convert with
 *    THAT rate — never with the current constant. (Accounting does not read
 *    it yet: its ResLab figures for a converted booking are still Canadian
 *    dollars. Do not set a rate below until it does.)
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

interface FxRateSetting extends FxRate {
  /** Last day (UTC, inclusive) the rate may be used for a NEW booking. After
   *  it, Canadian lots hide themselves until a PR sets a fresh rate. */
  validUntil: string;
}

/**
 * The rate for NEW bookings. A `validUntil` in the past means no rate:
 * `currentCadRate` returns null and Canadian lots are hidden everywhere.
 * Setting a real figure and date here is what puts those lots on sale.
 */
const CAD_USD: FxRateSetting = { id: "unset", micros: 700_000, validUntil: "2026-01-01" };

/**
 * Whether Park Guard protection is offered on a lot whose price we convert
 * (today: lots in Canada). Off until Park Guard confirms a plan applies to a
 * vehicle parked in Canada. Enforced in the checkout POST and /update-pi; the
 * checkout page hides the selector from the same constant.
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

/** The rate a new Canadian booking may use today, or null (expired / not set / not sane). */
export function currentCadRate(now: Date = new Date(), setting: FxRateSetting = CAD_USD): FxRate | null {
  const today = now.toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(setting.validUntil) || today > setting.validUntil) return null;
  const rate = { id: setting.id, micros: setting.micros };
  return isUsableRate(rate) ? rate : null;
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
export const FX_KEYS = { currency: "reslabCurrency", rateId: "fxRateId", rateMicros: "fxRateMicros" } as const;

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
