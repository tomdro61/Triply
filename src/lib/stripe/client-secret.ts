import { timingSafeEqual } from "node:crypto";
import { stripe } from "@/lib/stripe/client";
import { bounded } from "@/lib/utils/bounded";

/**
 * A PaymentIntent's client secret as a credential: unguessable, scoped to one
 * PaymentIntent, and only the paying customer's browser receives it (Stripe
 * hands it to checkout, and appends it to the 3-D Secure return URL). Holding
 * a bare `pi_` id proves nothing; holding its secret proves you paid.
 */

/** Constant-time string comparison; false for different lengths. */
export function secretsMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // timingSafeEqual throws on length mismatch, which would itself leak length.
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Bounded well inside the booking route's budget; it runs after the booking is made. */
export const CLIENT_SECRET_CHECK_TIMEOUT_MS = 3_000;

/**
 * Reads the PaymentIntent and says whether `given` is its client secret.
 * `unknown` when Stripe could not be read in time — never treated as a match.
 * Never throws.
 */
export async function paymentIntentSecretMatches(
  paymentIntentId: string,
  given: string
): Promise<"match" | "mismatch" | { unknown: string }> {
  try {
    const pi = await bounded(
      stripe.paymentIntents.retrieve(
        paymentIntentId,
        {},
        { timeout: CLIENT_SECRET_CHECK_TIMEOUT_MS, maxNetworkRetries: 0 }
      ),
      CLIENT_SECRET_CHECK_TIMEOUT_MS + 500,
      "Stripe PaymentIntent read (client secret check)"
    );
    return pi.client_secret && secretsMatch(given, pi.client_secret) ? "match" : "mismatch";
  } catch (err) {
    return { unknown: err instanceof Error ? err.message : String(err) };
  }
}
