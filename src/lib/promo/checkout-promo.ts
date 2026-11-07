/**
 * The checkout page's promo decisions, pure and browser-safe so they can be
 * tested without rendering the form (promo plan Part 2, /sketch-flow Nov 7):
 *   - the page's cart, from the checkout GET's prices;
 *   - /api/promo/validate's answer → the code's rule;
 *   - what the page does with the POST's verdict on the code it sent — the
 *     server priced the PaymentIntent, so its figure wins.
 * No I/O; the form owns the state and the Sentry calls.
 */
import { z } from "zod";
import type { CheckoutCostData } from "@/types/checkout";
import { normalisePromoCode, type Cart, type CheckoutPromoOutcome, type PromoRule } from "./discount";

const isCents = (n: number) => Number.isSafeInteger(n) && n >= 0;

/**
 * The page's cart, in cents, from the checkout GET's prices — the same figures
 * the POST prices from (ResLab /costs; a direct lot's quote), so a code applies
 * here exactly as it will there unless the price moves in between. null when
 * the page has no usable price (the GET's fallback without ResLab figures): a
 * code cannot be checked then.
 */
export function cartFromCostData(costData: CheckoutCostData | null | undefined): Cart | null {
  if (!costData) return null;
  const c = (dollars: number) => Math.round(dollars * 100);
  const cart: Cart = {
    parkingCents: c(costData.subtotal + costData.feesTotal),
    percentBaseCents: c(costData.subtotal),
    onlineParkingCents: c(costData.grandTotal) - c(costData.dueAtLocation),
    // Display only: the POST refuses any lot not priced in USD before it prices a code.
    currency: "USD",
  };
  return isCents(cart.parkingCents) && isCents(cart.percentBaseCents) && isCents(cart.onlineParkingCents) ? cart : null;
}

const validatedRuleSchema = z
  .object({
    valid: z.literal(true),
    code: z.string().min(1),
    discountPercent: z.number().gt(0).lte(100).nullable(),
    discountCents: z.number().int().positive().nullable(),
    minSubtotalCents: z.number().int().nonnegative(),
  })
  .refine((d) => (d.discountPercent === null) !== (d.discountCents === null), "exactly one of discountPercent / discountCents");

/** /api/promo/validate's `valid: true` answer → the code's rule; null when the answer is malformed. */
export function ruleFromValidateResponse(data: unknown): PromoRule | null {
  const parsed = validatedRuleSchema.safeParse(data);
  if (!parsed.success) return null;
  const d = parsed.data;
  return { code: normalisePromoCode(d.code), percent: d.discountPercent, amountCents: d.discountCents, minSubtotalCents: d.minSubtotalCents };
}

const outcomeSchema = z.union([
  z.object({ code: z.string(), kind: z.enum(["percent", "fixed"]), appliedCents: z.number().int().positive() }),
  z.object({ code: z.string(), refused: z.string(), message: z.string() }),
]);

export type CheckoutPromoDecision =
  /** The PaymentIntent carries the code: show `appliedCents` (the server's figure). */
  | { action: "keep"; appliedCents: number; report: string | null }
  /** The PaymentIntent carries NO discount: drop the code, tell the customer, stay before payment. */
  | { action: "drop"; notice: string; report: string | null };

const NOT_CHARGED = "Your total has been updated — please review it and continue. You have not been charged.";

/**
 * What the page does with the POST's `promo` for the code it SENT (`sent`,
 * which the page priced at `pageCents`).
 *   applied            keep it, showing the server's amount. A different
 *                      amount than the page's is a moved price for a percent
 *                      code; for a fixed code it can only be a bug or a code
 *                      edited since Apply, so it is reported.
 *   refused            drop it; the notice says why (the customer's reason).
 *   missing/malformed, or another code
 *                      drop it and report: the page cannot tell what the
 *                      PaymentIntent carries, so it is not used (the next
 *                      Continue creates one without the code).
 */
export function decideCheckoutPromo(sent: PromoRule, pageCents: number, raw: unknown): CheckoutPromoDecision {
  const parsed = outcomeSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      action: "drop",
      notice: `Your promo code ${sent.code} couldn't be applied. ${NOT_CHARGED}`,
      report: `checkout POST returned no usable promo verdict for ${sent.code}: ${JSON.stringify(raw)}`,
    };
  }
  const outcome: CheckoutPromoOutcome = parsed.data;
  if (normalisePromoCode(outcome.code) !== sent.code) {
    return {
      action: "drop",
      notice: `Your promo code ${sent.code} couldn't be applied. ${NOT_CHARGED}`,
      report: `checkout POST answered for promo code ${outcome.code}, not the ${sent.code} sent`,
    };
  }
  if ("refused" in outcome) {
    // The code's own refusals carry no full stop; the cart's do.
    const reason = /[.!?]$/.test(outcome.message) ? outcome.message : `${outcome.message}.`;
    return { action: "drop", notice: `Your promo code ${sent.code} couldn't be applied: ${reason} ${NOT_CHARGED}`, report: null };
  }
  const report =
    sent.amountCents !== null && outcome.appliedCents !== pageCents
      ? `fixed promo code ${sent.code} applied ${outcome.appliedCents} cents on the PaymentIntent, ${pageCents} on the page`
      : null;
  return { action: "keep", appliedCents: outcome.appliedCents, report };
}

/**
 * A "latest answer wins" gate for an async call the customer can overtake —
 * Apply's validate request, which Remove and Continue overtake: `begin()`
 * returns a check that is true only while nothing began or was invalidated
 * since.
 */
export interface LatestGate {
  begin(): () => boolean;
  invalidate(): void;
}

export function createLatestGate(): LatestGate {
  let current = 0;
  return {
    begin() {
      const mine = ++current;
      return () => mine === current;
    },
    invalidate() {
      current += 1;
    },
  };
}
