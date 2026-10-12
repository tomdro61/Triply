/**
 * Pure helpers for the confirmation page's Payment summary
 * (plan notes/2026-10-12-cost-breakdown-plan.md §2), shared by both branches
 * of `GET /api/reservations/[id]` (ResLab in the route, direct in
 * `@/lib/direct/reservation-view`). No I/O here — the Stripe read and the
 * Sentry report live in `./read-card-payment`.
 */
import { toCents, type MoneyInput } from "./cost-breakdown";

/**
 * Why the card side is not known. `released` and `not_settled` are states of
 * the PaymentIntent, not faults: neither is reported to Sentry.
 */
export type CardUnknownClass =
  | "no_payment_intent"
  | "stripe_read_failed"
  | "not_settled"
  | "released"
  | "charge_unreadable";

/**
 * What Stripe says about the booking's PaymentIntent — THE ANCHOR for the page.
 * `discountPercent` is the promo percent checkout stamped on the PaymentIntent
 * (`metadata.discountPercent`), null when absent or unusable.
 */
export type CardPayment =
  | { ok: true; chargedCents: number; refundedCents: number; discountPercent: number | null }
  | {
      ok: false;
      reasonClass: CardUnknownClass;
      reason: string;
      /** PaymentIntent status / amount_received when Stripe answered; null when it did not. */
      status: string | null;
      amountReceived: number | null;
      discountPercent: number | null;
    };

/** `metadata.discountPercent` → a usable percent (0 < p ≤ 100) or null. */
export function parseDiscountPercent(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n <= 100 ? n : null;
}

/**
 * The promo discount the code's PERCENT gives on the base checkout used, in
 * cents — worked out independently of the charge, so the breakdown can check
 * the stored discount against it (core rule: within 1¢, checked whenever
 * EITHER side has a promo).
 *   ResLab  round(sub_total × pct / 100)                — /api/checkout/lot
 *   Direct  min(grand, round(subtotal × pct / 100))     — direct/pricing.ts
 * Computed whenever the PaymentIntent carries a usable percent — even if the
 * booking recorded no discount (that disagreement is exactly what the core
 * must catch). null when there is no percent, or the base is unknown.
 */
export function expectedPromoCents(args: {
  discountPercent: number | null;
  base: MoneyInput;
  /** Direct only: the discount never exceeds the pre-discount total. */
  cap?: MoneyInput;
}): number | null {
  if (args.discountPercent === null) return null;
  const base = toCents(args.base);
  if (base === null) return null;
  const expected = Math.round((base * args.discountPercent) / 100);
  if (args.cap === undefined) return expected;
  const cap = toCents(args.cap);
  return cap === null ? null : Math.min(cap, expected);
}

/** `Plan ${code}` from `protection_plan_code`; the stored name only when there is no code. */
export function protectionPlanName(code: string | null | undefined, storedName: string): string {
  return code ? `Plan ${code}` : storedName;
}

/**
 * The card side as the page shows it when the breakdown is refused:
 *   charged   Stripe's own amount (the ONLY figure ever called "charged"),
 *             with refunds and the net when anything was refunded
 *   released  Stripe says the PaymentIntent was canceled — nothing was charged
 *   unknown   no figure at all (never a computed amount labelled as charged)
 */
export type CardSummary =
  | { status: "charged"; chargedCents: number; refundedCents: number; netPaidCents: number | null }
  | { status: "released" }
  | { status: "unknown" };

/**
 * Released ONLY when Stripe says the PaymentIntent is `canceled`. A
 * `requires_capture` / `processing` PaymentIntent is a LIVE hold even on a
 * cancelled booking (an admin cancel can leave one; a lot can cancel before
 * capture) — never "released".
 */
export function isReleasedHold(payment: CardPayment): boolean {
  return !payment.ok && payment.reasonClass === "released";
}

/** How a refused breakdown is reported: one Sentry issue per CLASS, never per booking. */
export interface FallbackReport {
  reasonClass: string;
  reason: string;
  level: "warning" | "error";
}

/**
 * The reason for a refused breakdown, naming the upstream cause when there is
 * one (the core only sees nulls), and whether / how to report it:
 *   released hold, cancelled booking        state, not a fault → no report
 *   released hold, LIVE booking             error  released_on_live_booking
 *   live hold (not settled), cancelled      error  live_hold_on_cancelled_booking
 *   not settled, live booking               state (capture pending) → no report
 *   Stripe read failed                      warning
 */
export function describeFallback(args: {
  rowReadFailed: boolean;
  payment: CardPayment;
  cancelled: boolean;
  coreReason: string;
}): { reason: string; report: FallbackReport | null } {
  const { rowReadFailed, payment, cancelled, coreReason } = args;
  if (rowReadFailed) {
    const reason = "booking row read failed";
    return { reason, report: { reasonClass: "row_read_failed", reason, level: "error" } };
  }
  if (!payment.ok) {
    if (isReleasedHold(payment)) {
      if (cancelled) return { reason: "the card hold was released", report: null };
      const reason = "the card hold was released but the booking is live (nothing charged)";
      return { reason, report: { reasonClass: "released_on_live_booking", reason, level: "error" } };
    }
    if (payment.reasonClass === "not_settled") {
      if (!cancelled) return { reason: payment.reason, report: null };
      const reason = `${payment.reason} on a cancelled booking — a live hold remains`;
      return { reason, report: { reasonClass: "live_hold_on_cancelled_booking", reason, level: "error" } };
    }
    return {
      reason: payment.reason,
      report: {
        reasonClass: payment.reasonClass,
        reason: payment.reason,
        level: payment.reasonClass === "stripe_read_failed" ? "warning" : "error",
      },
    };
  }
  const reasonClass = `breakdown_${coreReason.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "")}`;
  return { reason: coreReason, report: { reasonClass, reason: coreReason, level: "error" } };
}

export function cardSummary(payment: CardPayment): CardSummary {
  if (payment.ok) {
    return {
      status: "charged",
      chargedCents: payment.chargedCents,
      refundedCents: payment.refundedCents,
      netPaidCents: payment.refundedCents > 0 ? payment.chargedCents - payment.refundedCents : null,
    };
  }
  return isReleasedHold(payment) ? { status: "released" } : { status: "unknown" };
}
