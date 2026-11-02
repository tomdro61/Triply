/**
 * Keeps the guest's checkout email OUT of the confirmation page URL.
 *
 * GA4 and Clarity record every page URL, so `?email=<address>` on
 * /confirmation sent customer addresses to both. Checkout now hands the
 * address to the confirmation page in sessionStorage (same tab, survives a
 * reload) and the page sends it to /api/reservations/[id] in a header. A
 * legacy link that still carries ?email= is remembered here and stripped from
 * the address bar on arrival.
 *
 * Browser-only. Every storage call is wrapped: private windows and blocked
 * storage throw, and a failed write tells the caller to keep the old URL form
 * rather than strand a guest on "sign in to view".
 */

const KEY_PREFIX = "triply_confirmation_email:";

/** Store the address for this booking. False when storage is unavailable. */
export function rememberConfirmationEmail(reservationNumber: string, email: string): boolean {
  try {
    window.sessionStorage.setItem(KEY_PREFIX + reservationNumber, email);
    return window.sessionStorage.getItem(KEY_PREFIX + reservationNumber) === email;
  } catch {
    return false;
  }
}

/** The address checkout stored for this booking, or null. */
export function recallConfirmationEmail(reservationNumber: string): string | null {
  try {
    return window.sessionStorage.getItem(KEY_PREFIX + reservationNumber);
  } catch {
    return null;
  }
}

/** Drop `email` from the address bar without a navigation (Next syncs its router). */
export function stripEmailFromAddressBar(): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has("email")) return;
  url.searchParams.delete("email");
  window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
}
