/**
 * Keeps the guest's checkout email OUT of the confirmation page URL.
 *
 * GA4, Clarity and Sentry record page URLs, so `?email=<address>` on
 * /confirmation sent customer addresses to all three. Checkout hands the
 * address to the confirmation page in sessionStorage (same tab, survives a
 * reload) and the page sends it to /api/reservations/[id] in the
 * `x-booking-email` header. An emailed link still carries ?email= (it is the
 * guest's proof, there is no other credential); the page remembers it and
 * strips it from the address bar once it is safely stored.
 *
 * Browser-only. Every storage call is wrapped: blocked storage throws, and a
 * failed write tells the caller to keep ?email= in the URL rather than strand
 * a guest on "open your confirmation link". The layout's guards cover that
 * case (see lib/privacy/recorded-url-params.ts).
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

/** The address stored for this booking, or null. */
export function recallConfirmationEmail(reservationNumber: string): string | null {
  try {
    return window.sessionStorage.getItem(KEY_PREFIX + reservationNumber);
  } catch {
    return null;
  }
}

/**
 * Drop `email` from the address bar without a navigation. State is `null` on
 * purpose: Next's patched replaceState copies its own state and syncs the
 * router (useSearchParams) only for state without its internal marker —
 * passing `history.state` through would leave ?email= in the router, and the
 * next router update would write it back into the address bar.
 */
export function stripEmailFromAddressBar(): void {
  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has("email")) return;
    url.searchParams.delete("email");
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
  } catch {
    // Leaving ?email= in place is safe: the layout's guards keep it out of
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
