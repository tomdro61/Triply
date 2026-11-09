/**
 * The promo discount rule, in one pure module
 * (plan notes/2026-11-06-promo-fixed-amount-plan.md, Part 0).
 *
 * The SAME function will run on the server (the authority, POST
 * /api/checkout/lot) and in the browser (at Apply time, for the display), so
 * the two can never price a code differently. No I/O, no server imports: the
 * browser bundle imports this file.
 *
 * Everything is INTEGER CENTS. The discount comes off the PARKING paid online
 * and never out of Triply's service fee: a pay-at-the-lot booking whose online
 * parking is smaller than a fixed code's value is refused (decision D1), and a
 * percent code is capped at the online parking (fixes bug 6 — today a percent
 * code on a pay-at-lot lot eats the fee).
 *
 * Callers: POST /api/checkout/lot (both paths, via computeDirectQuote for
 * direct lots), /api/promo/validate (the rule only — it has no cart) and the
 * checkout client (at Apply).
 */
import { z } from "zod";
import { toCents } from "@/lib/booking/cost-breakdown";

/** A promo code's rule: exactly one of `percent` / `amountCents` is set. */
export interface PromoRule {
  /** Normalised (`normalisePromoCode`). */
  code: string;
  /** 0 < percent ≤ 100, for a percent code; null for a fixed one. */
  percent: number | null;
  /** The fixed amount off, in cents (> 0), for a fixed code; null for a percent one. */
  amountCents: number | null;
  /** Minimum `Cart.parkingCents` for the code to apply; 0 = none. */
  minSubtotalCents: number;
}

/** The cart a code is applied to, in cents — the server's own figures, never the browser's. */
export interface Cart {
  /**
   * What the customer sees as "Parking" — the figure the minimum is judged on.
   *   ResLab  sub_total + fees_total (the service-fee base)
   *   Direct  rate × days
   */
  parkingCents: number;
  /**
   * The base a PERCENT code is taken of, unchanged from today's rule so a
   * percent code prices as it does now (to within half a cent, D6):
   *   ResLab  sub_total (/api/checkout/lot)
   *   Direct  subtotal = rate × days (direct/pricing.ts)
   * Separate from `parkingCents` because ResLab's fees are in the minimum's
   * base but not in the percent's.
   */
  percentBaseCents: number;
  /**
   * The parking paid ONLINE, before any discount — the most a discount may take:
   *   ResLab  grand_total − due_at_location
   *   Direct  grand total (subtotal + tax)
   */
  onlineParkingCents: number;
  /** ISO currency the cart is priced in. Only USD is discounted. */
  currency: string;
}

export type PromoRefusal = "below_minimum" | "not_applicable" | "currency";

/**
 * The promo pricing the checkout page speaks, sent as a REQUEST HEADER on the
 * checkout POST. Pages loaded before PR 2 send none: they price a percent code
 * themselves (uncapped, unrounded), know no fixed codes, and never read the
 * server's verdict — so the POST refuses their code as a stale page (reload)
 * rather than charge an amount their Pay button doesn't show (Codex, PR 2
 * round 1). A header, not a body field, because an older server ignores it:
 * a rolled-back deploy's `.strict()` direct-lot schema would refuse an unknown
 * body key (Codex, round 2).
 */
export const PROMO_PRICING_VERSION = 2;
export const PROMO_PRICING_HEADER = "x-promo-pricing";

export type PromoDiscountResult = { cents: number } | { refused: PromoRefusal };

/**
 * What POST /api/checkout/lot tells the checkout about the code it was sent
 * (null: no code). `appliedCents` is the discount on the PaymentIntent — the
 * server's figure wins over the page's. `refused` is the code's own verdict
 * (lookup.ts) or the cart's (PromoRefusal); `message` is the customer's text.
 */
export type CheckoutPromoOutcome =
  | { code: string; kind: "percent" | "fixed"; appliedCents: number }
  | { code: string; refused: string; message: string };

/** "$25" for whole dollars, "$24.50" otherwise. */
const dollarsLabel = (cents: number): string => (cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`);

/** The code's offer as the customer reads it: "$5 off" / "10% off". */
export function promoRuleLabel(rule: PromoRule): string {
  return rule.amountCents !== null ? `${dollarsLabel(rule.amountCents)} off` : `${rule.percent}% off`;
}

/** Why a code gives no discount on this cart, in the customer's words — the same text in the widget and the checkout notice. */
export function promoRefusalMessage(refusal: PromoRefusal, rule: Pick<PromoRule, "minSubtotalCents">): string {
  switch (refusal) {
    case "below_minimum":
      return `This code needs at least ${dollarsLabel(rule.minSubtotalCents)} of parking.`;
    case "not_applicable":
      return "This code isn't valid for pay-at-the-lot bookings.";
    case "currency":
      return "This code can't be used at this lot.";
  }
}

/** The ONE promo-code normaliser: what `promo_codes.code` holds (migration 049 pins it). */
export function normalisePromoCode(raw: string): string {
  return raw.trim().toUpperCase();
}

const isNonNegCents = (n: number) => Number.isSafeInteger(n) && n >= 0;

/**
 * The discount `rule` gives on `cart`, in cents (always > 0), or why it gives
 * none. Rules, in order:
 *   1. not USD                                   → refused: currency
 *   2. parkingCents < minimum (both kinds)        → refused: below_minimum
 *   3. fixed: onlineParkingCents < amount         → refused: not_applicable (D1)
 *      fixed: otherwise                           → the amount
 *   4. percent: min(round(base × pct / 100), onlineParkingCents)
 *      — a result of 0 (no online parking, or a base too small to round to a
 *      cent) is refused: not_applicable, so `{ cents }` is never 0 and every
 *      stamped `discountCents` is positive (the readers refuse ≤ 0).
 *
 * The cart is assumed USD-priced only when it says so — a lot priced in CAD
 * (the Nov 3 bug, #154) gets no discount rather than a USD figure off a CAD
 * total.
 *
 * Throws on a malformed rule or cart: both come from our own code (the rule
 * from `parsePromoRule`, the cart from the server's price), so a bad one is a
 * programming error, never a customer's — and money must not be guessed.
 */
export function promoDiscountCents(rule: PromoRule, cart: Cart): PromoDiscountResult {
  const kind = ruleKind(rule);
  if (!isNonNegCents(cart.parkingCents) || !isNonNegCents(cart.percentBaseCents) || !isNonNegCents(cart.onlineParkingCents)) {
    throw new Error(
      `promoDiscountCents: cart figures must be non-negative whole cents (parking ${cart.parkingCents}, base ${cart.percentBaseCents}, online ${cart.onlineParkingCents})`
    );
  }

  if (cart.currency.trim().toUpperCase() !== "USD") return { refused: "currency" };
  if (cart.parkingCents < rule.minSubtotalCents) return { refused: "below_minimum" };

  if (kind.fixed) {
    // D1: the fixed amount must fit inside the parking paid online, or it
    // would come out of the service fee.
    if (cart.onlineParkingCents < kind.amountCents) return { refused: "not_applicable" };
    return { cents: kind.amountCents };
  }

  // D6: rounded to whole cents, so every reader works in cents. Today's ResLab
  // discount is unrounded (Stripe rounds the whole charge); this differs from
  // it by at most half a cent.
  const cents = Math.min(Math.round((cart.percentBaseCents * kind.percent) / 100), cart.onlineParkingCents);
  return cents > 0 ? { cents } : { refused: "not_applicable" };
}

/** The rule's one kind, checked — throws on a rule `parsePromoRule` would have refused. */
function ruleKind(rule: PromoRule): { fixed: true; amountCents: number } | { fixed: false; percent: number } {
  if (!isNonNegCents(rule.minSubtotalCents)) {
    throw new Error(`promoDiscountCents: rule ${rule.code} minSubtotalCents must be non-negative whole cents (${rule.minSubtotalCents})`);
  }
  const { percent, amountCents } = rule;
  if (percent !== null && amountCents === null) {
    if (!(Number.isFinite(percent) && percent > 0 && percent <= 100)) {
      throw new Error(`promoDiscountCents: rule ${rule.code} percent out of range (${percent})`);
    }
    return { fixed: false, percent };
  }
  if (amountCents !== null && percent === null) {
    if (!(Number.isSafeInteger(amountCents) && amountCents > 0)) {
      throw new Error(`promoDiscountCents: rule ${rule.code} amountCents must be a positive whole number (${amountCents})`);
    }
    return { fixed: true, amountCents };
  }
  throw new Error(`promoDiscountCents: rule ${rule.code} must have exactly one of percent / amountCents`);
}

/**
 * A `promo_codes` row as the Supabase client returns it (untyped). The new
 * columns (`discount_amount`, `min_subtotal`, migration 049) are optional so a
 * row read before 049 — or a select that does not name them — parses as a
 * percent code with no minimum. DECIMAL columns may arrive as a number or a
 * decimal string.
 */
const dollarsSchema = z.union([z.number(), z.string()]);
const promoRowSchema = z.object({
  code: z.string(),
  discount_percent: z.number().nullable().optional(),
  discount_amount: dollarsSchema.nullable().optional(),
  min_subtotal: dollarsSchema.nullable().optional(),
});

export type ParsedPromoRule = { ok: true; rule: PromoRule } | { ok: false; reason: string };

/**
 * A `promo_codes` row → `PromoRule`, dollars converted to cents once. A row
 * with both kinds or neither, a non-positive or out-of-range value, or an
 * unreadable amount is refused with the reason — the caller reports it
 * (Sentry) and treats the code as unusable, never as a guess.
 */
export function parsePromoRule(row: unknown): ParsedPromoRule {
  const parsed = promoRowSchema.safeParse(row);
  if (!parsed.success) return { ok: false, reason: `promo_codes row malformed: ${parsed.error.issues.map((i) => i.path.join(".") || "(row)").join(", ")}` };
  const r = parsed.data;

  const code = normalisePromoCode(r.code);
  if (code === "") return { ok: false, reason: "promo_codes row has an empty code" };

  const percent = r.discount_percent ?? null;
  const amountRaw = r.discount_amount ?? null;
  if (percent !== null && amountRaw !== null) return { ok: false, reason: `promo code ${code} has both a percent and an amount` };
  if (percent === null && amountRaw === null) return { ok: false, reason: `promo code ${code} has neither a percent nor an amount` };

  let amountCents: number | null = null;
  if (amountRaw !== null) {
    amountCents = toCents(amountRaw);
    if (amountCents === null || amountCents <= 0) return { ok: false, reason: `promo code ${code} has an unusable amount (${JSON.stringify(amountRaw)})` };
  }
  if (percent !== null && !(Number.isFinite(percent) && percent > 0 && percent <= 100)) {
    return { ok: false, reason: `promo code ${code} has a percent out of range (${percent})` };
  }

  let minSubtotalCents = 0;
  const minRaw = r.min_subtotal ?? null;
  if (minRaw !== null) {
    const min = toCents(minRaw);
    if (min === null) return { ok: false, reason: `promo code ${code} has an unusable minimum (${JSON.stringify(minRaw)})` };
    minSubtotalCents = min;
  }

  return { ok: true, rule: { code, percent, amountCents, minSubtotalCents } };
}
