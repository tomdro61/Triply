// The GA4 purchase event must fire once per booking. The confirmation page
// used to fire it on every load, so a customer reopening their booking from
// the confirmation email (often on another device, days later) counted the
// sale again: 42 of 181 transaction ids fired 2–3 times, Sep 1 – Oct 18.
//
// Checkout marks the booking it just completed in sessionStorage (this tab
// only) right before sending the customer to the confirmation page; the page
// fires only when it finds that mark, then clears it. A visit that didn't come
// straight from checkout — the email link, My Reservations, a refresh after
// the event fired — has no mark and fires nothing. A small localStorage list
// of ids already sent also covers a restored or duplicated tab.
//
// Storage that throws (blocked site data) means no event: a missed purchase
// is a smaller error than a counted-twice one, and Supabase stays the source
// of truth for bookings.

const PENDING_KEY = "triply:purchase-to-track";
const SENT_KEY = "triply:purchases-tracked";
const SENT_LIMIT = 50;

/** Checkout: mark the booking just completed, before navigating to its confirmation page. */
export function markPurchaseToTrack(confirmationNumber: string): void {
  try {
    sessionStorage.setItem(PENDING_KEY, confirmationNumber);
  } catch {
    // Storage blocked: this booking's purchase event won't fire (see above).
  }
}

function readSent(): string[] {
  try {
    const raw = localStorage.getItem(SENT_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Confirmation page: true exactly once for a booking checkout marked in this
 * tab. Clears the mark and remembers the id, so later loads return false.
 */
export function takePurchaseToTrack(confirmationNumber: string): boolean {
  let pending: string | null;
  try {
    pending = sessionStorage.getItem(PENDING_KEY);
  } catch {
    return false;
  }
  if (pending !== confirmationNumber) return false;

  try {
    sessionStorage.removeItem(PENDING_KEY);
  } catch {
    return false;
  }

  const sent = readSent();
  if (sent.includes(confirmationNumber)) return false;
  try {
    localStorage.setItem(SENT_KEY, JSON.stringify([...sent, confirmationNumber].slice(-SENT_LIMIT)));
  } catch {
    // The sessionStorage mark is already cleared, so this tab can't fire it again.
  }
  return true;
}
