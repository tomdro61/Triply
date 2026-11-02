import crypto from "crypto";

/**
 * Signed keys for guest confirmation links (/confirmation/{number}?k={key}).
 *
 * Why: the guest link used to carry `?email=<address>`. GA4 and Clarity record
 * every page URL, so every guest confirmation view sent the customer's email
 * address to both (Google's GA terms forbid PII in hits). The key proves the
 * same thing the address did — "this link came from us, for this booking" —
 * without naming anyone.
 *
 * Format: base64url(HMAC-SHA256(secret, "confirmation-link:v1:" + number)),
 * first 32 chars (192 bits). No expiry, matching the email links it replaces
 * (a customer re-opens the confirmation email weeks later at the lot). The
 * domain prefix keeps a signature minted for any other purpose from verifying.
 *
 * Its OWN secret (CONFIRMATION_LINK_SECRET), like REVIEW_SIGNING_SECRET and
 * WAITLIST_SIGNING_SECRET: rotating one must not kill another's links. Read
 * lazily so `next build` works without it. Missing secret → mint returns null
 * and callers fall back to the legacy `?email=` link (the confirmation page
 * then strips it from the address bar before analytics loads), so a deploy
 * before the env is set changes nothing for customers.
 */

const DOMAIN = "confirmation-link:v1:";
const KEY_LENGTH = 32;

function linkSecret(): string | null {
  return process.env.CONFIRMATION_LINK_SECRET || null;
}

/** The key for one booking, or null when CONFIRMATION_LINK_SECRET is unset. */
export function mintConfirmationKey(reservationNumber: string): string | null {
  const secret = linkSecret();
  if (!secret || !reservationNumber) return null;
  return crypto
    .createHmac("sha256", secret)
    .update(DOMAIN + reservationNumber)
    .digest("base64url")
    .slice(0, KEY_LENGTH);
}

/** True only when `key` is this booking's key. Constant-time compare. */
export function verifyConfirmationKey(
  reservationNumber: string,
  key: string | null | undefined
): boolean {
  if (!key) return false;
  const expected = mintConfirmationKey(reservationNumber);
  if (!expected) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(key);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * The query pair that lets a guest open their confirmation: `k=<key>` when
 * the secret is set, else the legacy `email=<address>`.
 */
export function confirmationAuthParam(
  reservationNumber: string,
  email: string
): [name: "k" | "email", value: string] {
  const key = mintConfirmationKey(reservationNumber);
  return key ? ["k", key] : ["email", email];
}
