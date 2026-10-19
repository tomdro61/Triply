/**
 * Server-side I/O for the confirmation page's Payment summary
 * (plan notes/2026-10-12-cost-breakdown-plan.md §2–§3):
 *
 *   readCardPayment              the ANCHOR — Stripe `amount_received` on the
 *                                booking's PaymentIntent, the latest charge's
 *                                `amount_refunded`, and the promo percent
 *                                checkout stamped (`metadata.discountPercent`).
 *                                One bounded attempt; any doubt → not ok.
 *   reportCostBreakdownFallback  one Sentry issue per REASON CLASS (the
 *                                reservation number rides as context), and at
 *                                most one event per booking + class per warm
 *                                instance.
 */
import * as Sentry from "@sentry/nextjs";
import { stripe } from "@/lib/stripe/client";
import { parseDiscountPercent, type CardPayment, type FallbackReport } from "./confirmation-payment";

/** Same budget as the other request-path PaymentIntent reads. */
export const CONFIRMATION_PI_TIMEOUT_MS = 4_000;

/** "StripeConnectionError/ECONNRESET" — the caught error's type and code, for the reason. */
function stripeErrorLabel(error: unknown): string {
  if (!(error instanceof Error)) return "unknown error";
  const type = "type" in error && typeof error.type === "string" ? error.type : error.name;
  const code = "code" in error && typeof error.code === "string" ? error.code : null;
  return code ? `${type}/${code}` : type;
}

/**
 * Only a `succeeded` PaymentIntent has a meaningful `amount_received`. A
 * `canceled` one is a released hold; `requires_capture` / `processing` /
 * `requires_*` are not settled. None of those is "$0 charged".
 */
export async function readCardPayment(piId: string | null | undefined): Promise<CardPayment> {
  const unknown = (
    reasonClass: Extract<CardPayment, { ok: false }>["reasonClass"],
    reason: string,
    extra: { status?: string; amountReceived?: number; discountPercent?: number | null } = {}
  ): CardPayment => ({
    ok: false,
    reasonClass,
    reason,
    status: extra.status ?? null,
    amountReceived: extra.amountReceived ?? null,
    discountPercent: extra.discountPercent ?? null,
  });

  if (!piId) return unknown("no_payment_intent", "booking has no PaymentIntent");
  let pi: Awaited<ReturnType<typeof stripe.paymentIntents.retrieve>>;
  try {
    // maxNetworkRetries 0: the client's default 2 retries would turn the 4 s
    // bound into ~13.5 s on the confirmation page's request path.
    pi = await stripe.paymentIntents.retrieve(
      piId,
      { expand: ["latest_charge"] },
      { timeout: CONFIRMATION_PI_TIMEOUT_MS, maxNetworkRetries: 0 }
    );
  } catch (error) {
    return unknown("stripe_read_failed", `Stripe PaymentIntent read failed (${stripeErrorLabel(error)})`);
  }
  const discountPercent = parseDiscountPercent(pi.metadata?.discountPercent);
  const seen = { status: pi.status, amountReceived: pi.amount_received, discountPercent };
  if (pi.status === "canceled") return unknown("released", "PaymentIntent is canceled (hold released)", seen);
  if (pi.status !== "succeeded") return unknown("not_settled", `PaymentIntent is ${pi.status}, not succeeded`, seen);
  if (!Number.isSafeInteger(pi.amount_received) || pi.amount_received <= 0) {
    return unknown("charge_unreadable", "PaymentIntent has no amount received", seen);
  }
  const charge = pi.latest_charge;
  // A succeeded PaymentIntent always has a charge; without one (or without
  // the expansion) the refund figure is unknowable — refuse rather than claim
  // "nothing refunded".
  if (charge === null) return unknown("charge_unreadable", "PaymentIntent has no charge", seen);
  if (typeof charge === "string") return unknown("charge_unreadable", "PaymentIntent charge was not expanded", seen);
  if (!Number.isSafeInteger(charge.amount_refunded) || charge.amount_refunded < 0) {
    return unknown("charge_unreadable", "charge refund amount unreadable", seen);
  }
  return { ok: true, chargedCents: pi.amount_received, refundedCents: charge.amount_refunded, discountPercent };
}

const REPORTED_LIMIT = 1_000;
const reported = new Set<string>();

/** Tests only. */
export function __resetCostBreakdownReportsForTests(): void {
  reported.clear();
}

/**
 * The page fell back to the plain summary. Fingerprint = the reason CLASS, so
 * one cause is one issue however many bookings it hits; the reservation number
 * and the full reason ride as context / tags.
 */
export function reportCostBreakdownFallback(
  reservationNumber: string,
  report: FallbackReport,
  context: { inventorySource: "reslab" | "direct"; stripePaymentIntentId?: string | null },
  /** The original exception, when the fallback was caused by one (grouping stays by class). */
  cause?: unknown
): void {
  const key = reservationNumber.slice(0, 64);
  // Per booking AND class: a transient Stripe warning must not mask a later,
  // persistent breakdown error for the same booking on this instance.
  const dedupeKey = `${key}:${report.reasonClass}`;
  if (reported.has(dedupeKey)) return;
  if (reported.size >= REPORTED_LIMIT) reported.clear();
  reported.add(dedupeKey);
  Sentry.withScope((scope) => {
    scope.setLevel(report.level);
    scope.setFingerprint(["cost-breakdown-fallback", report.reasonClass]);
    scope.setTag("cost_breakdown.reason", report.reasonClass);
    scope.setTag("inventory_source", context.inventorySource);
    if (context.stripePaymentIntentId) scope.setTag("payment.intentId", context.stripePaymentIntentId);
    scope.setContext("booking", { confirmationNumber: key, reason: report.reason });
    Sentry.captureException(
      cause instanceof Error
        ? cause
        : new Error(`Confirmation page cost breakdown fell back to the plain summary: ${report.reasonClass}`)
    );
  });
}
