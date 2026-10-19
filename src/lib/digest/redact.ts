/**
 * Strip customer identifiers from free text before it reaches Discord, Sentry
 * or a model prompt (plan v2 §2 / §6). Conservative by design: false positives
 * cost a word in a diagnostic; false negatives cost a customer's email in a
 * team channel.
 */

import { isReslabConfirmationNumber, isTriplyConfirmationNumber } from "@/lib/direct/confirmation-number";

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
// US-style phone numbers with optional country code and common separators.
const PHONE = /(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g;
// Stripe PaymentIntent / charge / customer ids.
const STRIPE_ID = /\b(?:pi|ch|cus|pm|re)_[A-Za-z0-9]{8,}\b/g;
// Licence-plate-shaped tokens: 5–8 chars, letters AND digits, all caps.
const PLATE = /\b(?=[A-Z0-9]{5,8}\b)(?=[A-Z0-9]*[A-Z])(?=[A-Z0-9]*\d)[A-Z0-9]+\b/g;

/**
 * Reservation numbers are business ids, not PII — kept intact: ResLab's
 * `RTL\d+` and Triply's direct-lot `TRP-XXXXXXXX` (Crockford base32). The "-" is
 * a word boundary, so the PLATE pass sees a TRP number's 8-char tail as a plate
 * on its own ("TRP-[plate]"); keep the tail only when the WHOLE token — prefix
 * included, nothing glued after it — is a valid Triply number.
 */
function keepOrMaskPlate(m: string, offset: number, whole: string): string {
  if (isReslabConfirmationNumber(m)) return m;
  if (offset >= 4 && isTriplyConfirmationNumber(whole.slice(offset - 4, offset + m.length))) {
    const before = whole[offset - 5];
    if (before === undefined || !/[A-Za-z0-9_-]/.test(before)) return m;
  }
  return "[plate]";
}

export function redactForDigest(input: string | null | undefined): string {
  if (!input) return "";
  return input
    .replace(EMAIL, "[email]")
    .replace(STRIPE_ID, "[stripe-id]")
    .replace(PHONE, "[phone]")
    .replace(PLATE, keepOrMaskPlate);
}
