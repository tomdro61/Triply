/**
 * Stripe reads for direct-lot payouts (Phase 6a). Integer cents, strict: any
 * doubt is reported as an error, which routes the booking to a manual decision
 * — never to a $0 payout.
 *
 * Deliberately NOT the accounting page's `fetchStripeSlices` (plan §3 proposed
 * extracting it): that closure works in float dollars and reads a missing
 * charge as "$0 refunded". This follows `readCardPayment`'s rules instead (a
 * succeeded PI must have an expanded charge with a readable refund figure) and
 * also returns the processing fee for the internal margin column.
 */
import { stripe } from "@/lib/stripe/client";
import type { PayoutStripe } from "./payout";

/** An admin page, not a customer request path — room for one retry. */
const PAYOUT_PI_TIMEOUT_MS = 8_000;
const PAYOUT_STRIPE_CONCURRENCY = 10;
/** One charge rarely has more than one dispute; more than this goes to a person. */
const MAX_DISPUTES = 10;

export interface PayoutStripeRead extends PayoutStripe {
  /** Stripe's processing fee on the charge (cents); null = unknown. */
  feeCents: number | null;
}

const failed = (error: string): PayoutStripeRead => ({
  error,
  amountReceivedCents: null,
  amountRefundedCents: null,
  piStatus: null,
  disputed: null,
  disputes: null,
  feeCents: null,
});

function errorLabel(error: unknown): string {
  if (!(error instanceof Error)) return "unknown error";
  const type = "type" in error && typeof error.type === "string" ? error.type : error.name;
  const code = "code" in error && typeof error.code === "string" ? error.code : null;
  return code ? `${type}/${code}` : type;
}

/** Never throws for a Stripe-side failure; a malformed reply may (readPayoutStripeMany catches it). */
export async function readPayoutStripe(piId: string): Promise<PayoutStripeRead> {
  let pi: Awaited<ReturnType<typeof stripe.paymentIntents.retrieve>>;
  try {
    pi = await stripe.paymentIntents.retrieve(
      piId,
      { expand: ["latest_charge.balance_transaction"] },
      { timeout: PAYOUT_PI_TIMEOUT_MS, maxNetworkRetries: 1 }
    );
  } catch (error) {
    return failed(`read failed (${errorLabel(error)})`);
  }
  if (!Number.isSafeInteger(pi.amount_received) || pi.amount_received < 0) return failed("amount received unreadable");
  const charge = pi.latest_charge;
  if (charge === null) {
    // No charge: only sensible when nothing was received (a released hold) — nothing to dispute either.
    if (pi.amount_received !== 0) return failed("money received but no charge");
    return { error: null, amountReceivedCents: 0, amountRefundedCents: 0, piStatus: pi.status, disputed: false, disputes: "", feeCents: null };
  }
  if (charge === undefined) return failed("charge missing from the reply");
  if (typeof charge === "string") return failed("charge was not expanded");
  if (!Number.isSafeInteger(charge.amount_refunded) || charge.amount_refunded < 0) return failed("refund amount unreadable");
  if (typeof charge.disputed !== "boolean") return failed("dispute flag unreadable");
  // The flag stays true once a dispute is won, so read the disputes themselves:
  // their status is what a person's decision on a disputed booking is bound to.
  let disputes = "";
  if (charge.disputed) {
    let list: Awaited<ReturnType<typeof stripe.disputes.list>>;
    try {
      list = await stripe.disputes.list(
        { payment_intent: piId, limit: MAX_DISPUTES },
        { timeout: PAYOUT_PI_TIMEOUT_MS, maxNetworkRetries: 1 }
      );
    } catch (error) {
      return failed(`disputes unreadable (${errorLabel(error)})`);
    }
    if (list.has_more) return failed(`more than ${MAX_DISPUTES} disputes`);
    if (list.data.length === 0) return failed("disputed, but no dispute found");
    disputes = list.data.map((d) => `${d.id}:${d.status}:${d.amount}`).sort().join(",");
  }
  const bt = charge.balance_transaction;
  const feeCents = bt && typeof bt === "object" && Number.isSafeInteger(bt.fee) ? bt.fee : null;
  return {
    error: null,
    amountReceivedCents: pi.amount_received,
    amountRefundedCents: charge.amount_refunded,
    piStatus: pi.status,
    disputed: charge.disputed,
    disputes,
    feeCents,
  };
}

/** Reads every PI with bounded concurrency; one failure never aborts the others. */
export async function readPayoutStripeMany(piIds: string[]): Promise<Map<string, PayoutStripeRead>> {
  const out = new Map<string, PayoutStripeRead>();
  let next = 0;
  const worker = async () => {
    while (true) {
      const idx = next++; // one synchronous step — each worker claims a unique index
      if (idx >= piIds.length) return;
      let read: PayoutStripeRead;
      try {
        read = await readPayoutStripe(piIds[idx]);
      } catch (error) {
        // A reply shaped unlike the SDK's types — that booking only goes to a person.
        read = failed(`unreadable reply (${errorLabel(error)})`);
      }
      out.set(piIds[idx], read);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PAYOUT_STRIPE_CONCURRENCY, piIds.length) }, worker));
  return out;
}
