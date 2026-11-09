/**
 * Keeps the guest's checkout email and booking key OUT of the confirmation
 * page URL.
 *
 * GA4, Clarity and Sentry record page URLs, so `?email=<address>` on
 * /confirmation sent customer addresses to all three. Checkout hands the
 * address to the confirmation page in sessionStorage (same tab, survives a
 * reload) and the page sends it to /api/reservations/[id] in the
 * `x-booking-email` header. An emailed link carries ?email= (the guest's
 * proof) and may carry ?booking_key= (a signed key for that one booking, sent
 * in the `x-booking-key` header); the page remembers each and strips it from
 * the address bar once it is safely stored.
 *
 * Browser-only. Every storage call is wrapped: blocked storage throws, and a
 * failed write tells the caller to keep the value in the URL rather than
 * strand a guest on "open your confirmation link". The layout's guards cover
 * that case (see lib/privacy/recorded-url-params.ts).
 */

import type { RECORDED_URL_SECRET_PARAMS } from "@/lib/privacy/recorded-url-params";

const KEY_PREFIX = "triply_confirmation_email:";
const BOOKING_KEY_PREFIX = "triply_confirmation_key:";

/** The confirmation-link params this module stores and strips — always ones the recorders' guards know. */
export type AddressBarSecret = Extract<(typeof RECORDED_URL_SECRET_PARAMS)[number], "email" | "booking_key">;

/** Store `value` under `storageKey`, read back to check. False when storage is unavailable. */
function remember(storageKey: string, value: string): boolean {
  try {
    window.sessionStorage.setItem(storageKey, value);
    return window.sessionStorage.getItem(storageKey) === value;
  } catch {
    return false;
  }
}

function recall(storageKey: string): string | null {
  try {
    return window.sessionStorage.getItem(storageKey);
  } catch {
    return null;
  }
}

/** Store the address for this booking. False when storage is unavailable. */
export function rememberConfirmationEmail(reservationNumber: string, email: string): boolean {
  return remember(KEY_PREFIX + reservationNumber, email);
}

/** The address stored for this booking, or null. */
export function recallConfirmationEmail(reservationNumber: string): string | null {
  return recall(KEY_PREFIX + reservationNumber);
}

/** Store the booking key for this booking. False when storage is unavailable. */
export function rememberConfirmationKey(reservationNumber: string, bookingKey: string): boolean {
  return remember(BOOKING_KEY_PREFIX + reservationNumber, bookingKey);
}

/** The booking key stored for this booking, or null. */
export function recallConfirmationKey(reservationNumber: string): string | null {
  return recall(BOOKING_KEY_PREFIX + reservationNumber);
}

/**
 * An emailed link's arrival: store the email and the booking key it carries.
 * Returns the params that are now safe to strip — only the ones stored, so a
 * value that could not be stored stays in the URL for a reload.
 */
export function storeArrivalSecrets(
  reservationNumber: string,
  arrival: { email: string | null; bookingKey: string | null }
): AddressBarSecret[] {
  const stored: AddressBarSecret[] = [];
  if (arrival.email && rememberConfirmationEmail(reservationNumber, arrival.email)) stored.push("email");
  if (arrival.bookingKey && rememberConfirmationKey(reservationNumber, arrival.bookingKey)) stored.push("booking_key");
  return stored;
}

/**
 * The guest's proofs for GET /api/reservations/[id], as headers — never the
 * URL. The key: the link's, else the stored one. The email: the one typed on
 * the page, else the link's, else the stored one. Both go when both are known:
 * the key decides, the email is the fallback.
 */
export function guestProofHeaders(
  reservationNumber: string,
  known: { typedEmail: string | null; arrivalEmail: string | null; arrivalKey: string | null }
): Record<string, string> {
  const headers: Record<string, string> = {};
  const key = known.arrivalKey ?? recallConfirmationKey(reservationNumber);
  if (key) headers["x-booking-key"] = key;
  const email = known.typedEmail ?? known.arrivalEmail ?? recallConfirmationEmail(reservationNumber);
  if (email) headers["x-booking-email"] = email;
  return headers;
}

/**
 * Drop the given params from the address bar without a navigation. Callers
 * pass only the ones they stored, so an unstored value stays for a reload.
 * State is `null` on purpose: Next's patched replaceState copies its own state
 * and syncs the router (useSearchParams) only for state without its internal
 * marker — passing `history.state` through would leave the params in the
 * router, and the next router update would write them back into the address bar.
 */
export function stripSecretsFromAddressBar(params: readonly AddressBarSecret[]): void {
  try {
    const url = new URL(window.location.href);
    const present = params.filter((name) => url.searchParams.has(name));
    if (present.length === 0) return;
    for (const name of present) url.searchParams.delete(name);
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
  } catch {
    // Leaving them in place is safe: the layout's guards keep them out of
    // Clarity, GA4's page_view and Sentry.
  }
}

/**
 * Where to send a guest whose booking just finished, and how.
 *
 * Stored → the URL without the email, by in-app navigation. Not stored →
 * the URL WITH ?email=, and the caller must do a FULL page load
 * (window.location), never router.push/replace: Clarity and Sentry are already
 * running on the current page and would record an in-app URL change, while a
 * full load runs the layout's guards first.
 */
export function confirmationHandOff(
  path: string,
  reservationNumber: string,
  email: string
): { url: string; fullLoad: boolean } {
  if (!email || rememberConfirmationEmail(reservationNumber, email)) {
    return { url: path, fullLoad: false };
  }
  const url = new URL(path, "https://hand-off.invalid");
  url.searchParams.set("email", email);
  return { url: url.pathname + url.search, fullLoad: true };
}
