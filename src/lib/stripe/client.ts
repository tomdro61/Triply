/**
 * Stripe Client Configuration
 *
 * Server-side Stripe client for payment processing.
 */

import Stripe from "stripe";

if (!process.env.STRIPE_SECRET_KEY) {
  console.warn("Missing STRIPE_SECRET_KEY environment variable");
}

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "", {
  apiVersion: "2026-01-28.clover",
  typescript: true,
});

/**
 * Break-glass rollback for the manual-capture model. Set to "true" in Vercel to
 * revert new PaymentIntents to immediate capture WITHOUT a redeploy. The booking
 * engine handles both models, so flipping this is safe at any time; PaymentIntents
 * already authorized under the other model continue to work.
 */
const MANUAL_CAPTURE_DISABLED = process.env.DISABLE_MANUAL_CAPTURE === "true";

/**
 * The ONLY payment methods checkout offers — set in code, never left to the
 * Stripe Dashboard. The booking engine authorizes, books, then captures, which
 * is only safe for methods that confirm instantly (runbook § "only instant
 * methods"). Klarna and other buy-now-pay-later methods redirect away; bank
 * debits can sit `processing` for days. Tom turned those off in the Dashboard on
 * 2026-07-06, yet on 2026-10-13 production checkout offered Klarna and a "Bank"
 * tab again — `automatic_payment_methods` shows whatever the Dashboard has on,
 * so the toggle drifted with nothing to notice it.
 *
 * `card` includes Apple Pay and Google Pay (wallets are card payments). Adding
 * a method here needs a staging test of its whole flow first.
 *
 * NOT covered by this list: what LINK offers inside itself. Link turns on
 * "Pay later with Klarna" and Instant Bank Payments (the "Bank — $5 back" tab)
 * automatically; those are controlled ONLY in Dashboard → Settings → Link. That
 * is where the Klarna/Bank tabs seen on 2026-10-13 came from (the standalone
 * Klarna and ACH rows were already Disabled). Link payments confirm instantly
 * whatever funds them, so they are safe for authorize → book → capture; Klarna
 * on Link is switched off there by policy (runbook: no buy-now-pay-later).
 */
export const CHECKOUT_PAYMENT_METHOD_TYPES = ["card", "link"] as const;

/**
 * Create a PaymentIntent for a booking.
 *
 * CARDS ARE AUTHORIZED, NOT CHARGED. `payment_method_options.card.capture_method`
 * puts card payments into `requires_capture` after confirmation: the money is
 * held but not taken, and it is only captured once a ResLab reservation actually
 * exists (see @/lib/booking/create-booking). If anything fails before then — the
 * lot sold out, ResLab rejected us, the customer's browser died — the hold is
 * cancelled and the customer is never charged at all.
 *
 * Scoped to CARD rather than set top-level, deliberately:
 *   - Cards are where the orphan charges come from (3-D Secure redirects), so
 *     they get the full guarantee.
 *   - Apple Pay and Google Pay are card payments (`card.wallet`), so this
 *     option applies to them too.
 *   - Link (its own type) keeps automatic capture, so its teardown is a refund
 *     rather than a cancelled hold — the engine handles both.
 *
 * NOTE: with this option the PaymentIntent's TOP-LEVEL `capture_method` still
 * reads "automatic_async" even for a card that lands in `requires_capture`.
 * Never branch on `pi.capture_method` — branch on `pi.status`.
 */
export async function createPaymentIntent(
  amount: number,
  metadata: Record<string, string>
) {
  return stripe.paymentIntents.create({
    amount: Math.round(amount * 100), // Convert to cents
    currency: "usd",
    payment_method_types: [...CHECKOUT_PAYMENT_METHOD_TYPES],
    ...(MANUAL_CAPTURE_DISABLED
      ? {}
      : { payment_method_options: { card: { capture_method: "manual" as const } } }),
    metadata,
  });
}

/**
 * Retrieve a PaymentIntent
 */
export async function getPaymentIntent(paymentIntentId: string) {
  return stripe.paymentIntents.retrieve(paymentIntentId);
}

/**
 * Create a refund
 *
 * `idempotencyKey` MUST be reason-INDEPENDENT (key on the PaymentIntent alone).
 * Two callers detecting different failure reasons for the same PI — say one
 * seeing `sold_out` and another a ResLab 4xx — would otherwise issue two
 * refunds; the second throws "already refunded", which aborts that caller's
 * terminal DB transition and wedges the pending row in `processing` forever.
 */
export async function createRefund(
  paymentIntentId: string,
  amount?: number, // Amount in dollars, optional for full refund
  idempotencyKey?: string
) {
  return stripe.refunds.create(
    {
      payment_intent: paymentIntentId,
      amount: amount ? Math.round(amount * 100) : undefined,
    },
    idempotencyKey ? { idempotencyKey } : undefined
  );
}

/**
 * Create a refund from an amount already expressed in CENTS.
 *
 * The sibling `createRefund` takes DOLLARS and ×100s internally — passing a
 * cents value to it refunds 100× (a $103.07 refund becomes $10,307). This
 * variant passes `amountCents` straight to Stripe with NO conversion, so callers
 * that compute in cents (e.g. self-cancel `refund-math`) cannot hit that trap.
 *
 * `idempotencyKey` MUST be reason-independent (key on the PaymentIntent alone) —
 * see `createRefund` above for why.
 */
export async function createRefundCents(
  paymentIntentId: string,
  amountCents: number,
  idempotencyKey?: string
) {
  return stripe.refunds.create(
    {
      payment_intent: paymentIntentId,
      amount: amountCents, // already cents — NO * 100
    },
    idempotencyKey ? { idempotencyKey } : undefined
  );
}

/**
 * Capture a previously authorized PaymentIntent.
 *
 * Valid ONLY from status `requires_capture`. This is the moment the customer's
 * money actually moves — it must never run before a ResLab reservation exists.
 */
/**
 * `attempt` (direct lots, §10 F-4): Stripe replays a key's FIRST result for
 * 24 h, a 5xx included, so a bounded retry needs a fresh key per attempt.
 * Attempt 0 keeps the original key. Safe: a PaymentIntent captures once; a
 * second capture errors and the caller re-reads the PaymentIntent.
 */
export async function capturePaymentIntent(paymentIntentId: string, attempt = 0) {
  return stripe.paymentIntents.capture(paymentIntentId, undefined, {
    idempotencyKey: attempt > 0 ? `capture:${paymentIntentId}:${attempt}` : `capture:${paymentIntentId}`,
  });
}

/**
 * Cancel an authorized-but-uncaptured PaymentIntent, releasing the hold.
 *
 * INVALID on `processing` and `succeeded` — Stripe throws. Callers must branch
 * on the live PI status first; see `releasePayment` in @/lib/booking/create-booking.
 */
export async function cancelPaymentIntent(paymentIntentId: string) {
  return stripe.paymentIntents.cancel(paymentIntentId, {
    idempotencyKey: `cancel:${paymentIntentId}`,
  });
}

/**
 * Has any money been refunded on this PaymentIntent?
 *
 * Gate G1: a refund can succeed and the process then die before the terminal DB
 * write lands (Stripe and Postgres are not one transaction). The row stays
 * `processing`, a re-drive picks it up, and without this check we would book a
 * customer who has already been refunded — charged, refunded, then given an
 * unpaid reservation. ANY refund means the PI is permanently un-bookable.
 */
export type RefundState =
  /** A charge exists and carries a refund. Certain. */
  | "refunded"
  /** No money has been returned. Certain. */
  | "none"
  /** We cannot tell. Callers must refuse to fulfil, but must NOT record a
   *  terminal status asserting money moved — that turns a transient unknown into
   *  a permanent lie about the customer's card. */
  | "unknown";

export function paymentIntentRefundState(pi: Stripe.PaymentIntent): RefundState {
  // safety-removed: the original `if (!charge || typeof charge === "string") return false`
  // WAS the defect. It made this gate fail OPEN — "cannot determine" was reported as
  // "no refund", so a refunded customer could be re-fulfilled, which is precisely
  // what gate G1 exists to prevent. Replaced by an explicit tri-state so callers
  // can refuse on "unknown" without asserting anything false about the money.
  if (!pi.latest_charge) {
    // A PaymentIntent that has not yet produced a charge cannot carry a refund,
    // and that covers every state except one. `requires_payment_method`,
    // `requires_confirmation`, `requires_action`, `requires_capture`,
    // `processing` and `canceled` are all pre-capture — no money has moved, so
    // "none" is a fact, not an assumption. (An earlier version treated the
    // pre-payment states as undeterminable and escalated a customer who was
    // simply mid-3-D-Secure.)
    //
    // `succeeded` with no charge is the genuine anomaly: money moved but we
    // cannot see where. Fail CLOSED — blocking a fulfilment is recoverable,
    // booking a customer whose money was already returned is not.
    return pi.status === "succeeded" ? "unknown" : "none";
  }

  // Unexpanded. Reporting "none" here would silently open the gate, so callers
  // MUST retrieve with expand: ["latest_charge"] — enforce it loudly rather than
  // guess.
  if (typeof pi.latest_charge === "string") {
    throw new Error(
      `paymentIntentRefundState requires a PaymentIntent retrieved with expand:["latest_charge"] (got an unexpanded charge id on ${pi.id})`
    );
  }

  return (pi.latest_charge.amount_refunded ?? 0) > 0 ? "refunded" : "none";
}
