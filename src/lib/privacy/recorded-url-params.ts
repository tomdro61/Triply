/**
 * URL query params that must never reach a tool that records page URLs (GA4,
 * Clarity, Sentry events and replay):
 *   - `email`: the guest's proof on an emailed confirmation link
 *     (/confirmation/{n}?email=…), and their address;
 *   - `payment_intent_client_secret`: Stripe's return URL after 3-D Secure
 *     carries it, and /api/reservations/complete trades it for that email.
 *
 * Matched by NAME only — never a text search: our email links carry
 * `utm_medium=email`.
 *
 * Used by the layout's inline guards (interpolated into the scripts),
 * instrumentation-client.ts (deferring replay) and lib/sentry-scrub.ts.
 */
export const RECORDED_URL_SECRET_PARAMS = ["email", "payment_intent_client_secret"] as const;

/** True when `href` carries any RECORDED_URL_SECRET_PARAMS. */
export function hasRecordedUrlSecret(href: string): boolean {
  try {
    const params = new URL(href, "https://recorded-url.invalid").searchParams;
    return RECORDED_URL_SECRET_PARAMS.some((name) => params.has(name));
  } catch {
    return false;
  }
}
