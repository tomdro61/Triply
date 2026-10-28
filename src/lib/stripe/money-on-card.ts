import { stripe } from "./client";
import { capturePaymentError } from "@/lib/sentry";

/** What a PaymentIntent holds right now, in words a customer can be shown. */
export type MoneyOnCard =
  | { kind: "hold"; amountCents: number; currency: string }
  | { kind: "captured"; amountCents: number; currency: string }
  /** Still settling, canceled, refunded, or the read failed: say nothing numeric. */
  | { kind: "unknown" };

/**
 * Read the card AFTER whatever just happened to it — never from a snapshot
 * taken before fulfilment, because the engine captures inside that call and
 * some of its unresolved outcomes come after a successful capture (review
 * finding, Oct 28 2026). Bounded at 4 s with no retries: the SDK default
 * (80 s + retries) outlives a route's 60 s, and a function killed mid-read
 * never reaches the catch. The figure is optional; a fast "unknown" is the
 * right trade.
 */
export async function moneyOnCard(piId: string): Promise<MoneyOnCard> {
  try {
    const fresh = await stripe.paymentIntents.retrieve(piId, {}, { timeout: 4_000, maxNetworkRetries: 0 });
    if (fresh.status === "requires_capture" && fresh.amount_capturable > 0) {
      return { kind: "hold", amountCents: fresh.amount_capturable, currency: fresh.currency };
    }
    if (fresh.status === "succeeded" && fresh.amount_received > 0) {
      return { kind: "captured", amountCents: fresh.amount_received, currency: fresh.currency };
    }
    return { kind: "unknown" };
  } catch (error) {
    capturePaymentError(error instanceof Error ? error : new Error(String(error)), {
      stripePaymentIntentId: piId,
      fingerprint: ["money-on-card-read-failed"],
    });
    return { kind: "unknown" };
  }
}

export function formatMoneyOnCard(money: MoneyOnCard): string | null {
  if (money.kind === "unknown") return null;
  const amount = (money.amountCents / 100).toFixed(2);
  const currency = money.currency.toUpperCase();
  return currency === "USD" ? `$${amount}` : `${amount} ${currency}`;
}
