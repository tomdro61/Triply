import { signWaitlistId, verifyWaitlistToken } from "@/lib/waitlist/unsubscribe-token";

/**
 * Unsubscribe tokens for checkout-recovery emails.
 *
 * Reuses the waitlist HMAC (WAITLIST_SIGNING_SECRET) rather than adding a new
 * secret, with a domain prefix so a token minted for a waitlist row id can
 * never verify here (or the reverse), even though both are UUIDs. A missing
 * secret throws WaitlistConfigError, exactly like the waitlist routes — callers
 * branch on isWaitlistConfigError.
 */
const DOMAIN = "checkout-recovery:";

export function signRecoveryId(id: string): string {
  return signWaitlistId(`${DOMAIN}${id}`);
}

export function verifyRecoveryToken(id: string, token: string): boolean {
  return verifyWaitlistToken(`${DOMAIN}${id}`, token);
}

/**
 * The link's subject is the Stripe PaymentIntent id (`checkout_recovery_emails`
 * is UNIQUE on it), NOT the ledger row id: a released-and-retried claim gets
 * a new row id, which would change the email body under the same Resend
 * idempotency key (409) and leave an already-delivered email pointing at a
 * deleted row (404 on unsubscribe — a commercial email with no working
 * opt-out). The PaymentIntent id is stable across every retry.
 */
export function recoveryUnsubscribeUrl(paymentIntentId: string): string {
  const base = process.env.NEXT_PUBLIC_APP_URL || "https://www.triplypro.com";
  const url = new URL("/api/checkout-recovery/unsubscribe", base);
  url.searchParams.set("id", paymentIntentId);
  url.searchParams.set("token", signRecoveryId(paymentIntentId));
  return url.toString();
}
