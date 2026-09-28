/**
 * Strip customer identifiers from free text before it reaches Discord, Sentry
 * or a model prompt (plan v2 §2 / §6). Conservative by design: false positives
 * cost a word in a diagnostic; false negatives cost a customer's email in a
 * team channel.
 */

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
// US-style phone numbers with optional country code and common separators.
const PHONE = /(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g;
// Stripe PaymentIntent / charge / customer ids.
const STRIPE_ID = /\b(?:pi|ch|cus|pm|re)_[A-Za-z0-9]{8,}\b/g;
// Licence-plate-shaped tokens: 5–8 chars, letters AND digits, all caps.
const PLATE = /\b(?=[A-Z0-9]{5,8}\b)(?=[A-Z0-9]*[A-Z])(?=[A-Z0-9]*\d)[A-Z0-9]+\b/g;
// ResLab reservation numbers (RTL + digits) are business ids, not PII — kept.

export function redactForDigest(input: string | null | undefined): string {
  if (!input) return "";
  return input
    .replace(EMAIL, "[email]")
    .replace(STRIPE_ID, "[stripe-id]")
    .replace(PHONE, "[phone]")
    .replace(PLATE, (m) => (/^RTL\d+$/.test(m) ? m : "[plate]"));
}
