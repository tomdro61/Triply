import type Stripe from "stripe";
import { stripe } from "./client";
import { capturePaymentError } from "@/lib/sentry";

/** What a PaymentIntent holds right now, in words a customer can be shown. */
export type MoneyOnCard =
  | { kind: "hold"; amountCents: number; currency: string }
  | { kind: "captured"; amountCents: number; currency: string }
  /** Captured, then refunded in full. */
  | { kind: "refunded"; amountCents: number; currency: string }
  /** Still settling, canceled, partially refunded, or the read failed: say nothing numeric. */
  | { kind: "unknown" };

/** One bounded read of the PaymentIntent, for everything an alert needs. */
export interface CardState {
  money: MoneyOnCard;
  /** `metadata.customerEmail`, which every checkout PaymentIntent carries; null when absent or the read failed. */
  customerEmail: string | null;
  /** null when the read failed. */
  livemode: boolean | null;
  /** `metadata.reconciliation_alerted_at` is set: this payment was alerted before. */
  alreadyAlerted: boolean;
}

const READ_OPTS = { timeout: 4_000, maxNetworkRetries: 0 } as const;
export const ALERTED_METADATA_KEY = "reconciliation_alerted_at";

function moneyFrom(fresh: Stripe.PaymentIntent): MoneyOnCard {
  if (fresh.status === "requires_capture" && fresh.amount_capturable > 0) {
    return { kind: "hold", amountCents: fresh.amount_capturable, currency: fresh.currency };
  }
  if (fresh.status === "succeeded" && fresh.amount_received > 0) {
    const charge = fresh.latest_charge;
    const refunded = charge && typeof charge === "object" ? (charge as Stripe.Charge).amount_refunded ?? 0 : 0;
    if (refunded <= 0) return { kind: "captured", amountCents: fresh.amount_received, currency: fresh.currency };
    if (refunded >= fresh.amount_received) return { kind: "refunded", amountCents: refunded, currency: fresh.currency };
    return { kind: "unknown" };
  }
  return { kind: "unknown" };
}

/**
 * Read the card AFTER whatever just happened to it — never from a snapshot
 * taken before fulfilment, because the engine captures inside that call and
 * some of its unresolved outcomes come after a successful capture (review
 * finding, Oct 28 2026). Bounded at 4 s with no retries: the SDK default
 * (80 s + retries) outlives a route's 60 s, and a function killed mid-read
 * never reaches the catch. The figure is optional; a fast "unknown" is the
 * right trade.
 *
 * `succeeded` keeps its `amount_received` after a refund, so the charge is
 * expanded and `amount_refunded` read: a full refund is "refunded", a partial
 * one is "unknown" (never "charged $X" for money already returned).
 */
export async function readCard(piId: string): Promise<CardState> {
  try {
    const fresh = await stripe.paymentIntents.retrieve(piId, { expand: ["latest_charge"] }, READ_OPTS);
    const email = (fresh.metadata?.customerEmail ?? "").trim();
    return {
      money: moneyFrom(fresh),
      customerEmail: email.includes("@") ? email : null,
      livemode: fresh.livemode,
      alreadyAlerted: typeof fresh.metadata?.[ALERTED_METADATA_KEY] === "string" && fresh.metadata[ALERTED_METADATA_KEY] !== "",
    };
  } catch (error) {
    capturePaymentError(error instanceof Error ? error : new Error(String(error)), {
      stripePaymentIntentId: piId,
      fingerprint: ["money-on-card-read-failed"],
    });
    return { money: { kind: "unknown" }, customerEmail: null, livemode: null, alreadyAlerted: false };
  }
}

export async function moneyOnCard(piId: string): Promise<MoneyOnCard> {
  return (await readCard(piId)).money;
}

/**
 * Durable "this payment was alerted" marker, on the PaymentIntent itself (no
 * table needed; metadata is writable in every status). Best-effort, bounded;
 * false when the write failed — the caller treats that as "may alert again".
 */
export async function markAlerted(piId: string, at: Date = new Date()): Promise<boolean> {
  try {
    await stripe.paymentIntents.update(piId, { metadata: { [ALERTED_METADATA_KEY]: at.toISOString() } }, READ_OPTS);
    return true;
  } catch (error) {
    capturePaymentError(error instanceof Error ? error : new Error(String(error)), {
      stripePaymentIntentId: piId,
      fingerprint: ["money-on-card-mark-alerted-failed"],
    });
    return false;
  }
}

export function formatMoneyOnCard(money: MoneyOnCard): string | null {
  if (money.kind === "unknown") return null;
  const amount = (money.amountCents / 100).toFixed(2);
  const currency = money.currency.toUpperCase();
  return currency === "USD" ? `$${amount}` : `${amount} ${currency}`;
}
