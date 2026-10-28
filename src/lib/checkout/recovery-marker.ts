/**
 * Per-tab memory of a payment whose booking is still being finished, so
 * /checkout/complete can resume after it scrubs its own URL (it removes the
 * client secret from the address bar on mount — a refresh then arrived with no
 * parameters and told a customer with a live hold "we couldn't identify this
 * payment… start a new search"; launch-QA finding #8, Oct 28 2026).
 *
 * sessionStorage: this tab only, gone when the tab closes. The client secret
 * is the same credential Stripe itself puts in the return URL; it is scoped
 * to one PaymentIntent and useless without it. Cleared on every terminal
 * answer in which the hold is released or the booking confirmed.
 */

const KEY = "triply:checkout-recovery";
/** A marker older than this is ignored: a restored tab days later should not
 *  silently resume a poll — the hold has long since expired or been resolved. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface RecoveryMarker {
  paymentIntentId: string;
  clientSecret: string;
  savedAt: number;
}

export function saveRecoveryMarker(marker: Omit<RecoveryMarker, "savedAt">): void {
  try {
    const stored: RecoveryMarker = { ...marker, savedAt: Date.now() };
    sessionStorage.setItem(KEY, JSON.stringify(stored));
  } catch {
    // Storage blocked: a refresh of the complete page will show the
    // "couldn't identify this payment" view with the support contact.
  }
}

export function readRecoveryMarker(now: number = Date.now()): RecoveryMarker | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const m = parsed as Partial<RecoveryMarker>;
    if (
      typeof m.paymentIntentId !== "string" ||
      !m.paymentIntentId.startsWith("pi_") ||
      typeof m.clientSecret !== "string" ||
      !m.clientSecret ||
      typeof m.savedAt !== "number"
    ) {
      return null;
    }
    if (now - m.savedAt > MAX_AGE_MS) return null;
    return { paymentIntentId: m.paymentIntentId, clientSecret: m.clientSecret, savedAt: m.savedAt };
  } catch {
    return null;
  }
}

export function clearRecoveryMarker(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // Nothing to do: a stale marker only ever re-asks the engine, which answers truthfully.
  }
}
