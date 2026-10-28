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
 *
 * No age limit: the hold lives up to ~7 days and reconciliation can take that
 * long, so a marker is only ever invalidated by the engine's own answer
 * (`markerActionFor`), never by the clock. A stale marker costs one poll.
 */

const KEY = "triply:checkout-recovery";

export interface RecoveryMarker {
  paymentIntentId: string;
  clientSecret: string;
  savedAt: number;
}

export interface Credentials {
  paymentIntentId: string | null;
  clientSecret: string | null;
}

export function saveRecoveryMarker(marker: Omit<RecoveryMarker, "savedAt">): void {
  try {
    const stored: RecoveryMarker = { ...marker, savedAt: Date.now() };
    sessionStorage.setItem(KEY, JSON.stringify(stored));
  } catch {
    // Storage blocked: a refresh of the complete page will show the
    // "unidentified payment" view with the support contact.
  }
}

export function readRecoveryMarker(): RecoveryMarker | null {
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

/**
 * Which payment /checkout/complete works on: the URL's parameters when both
 * are present (a fresh Stripe return or hand-off always wins over an older
 * marker), otherwise the tab's marker, otherwise nothing.
 */
export function resolveCredentials(
  fromUrl: Credentials,
  readMarker: () => RecoveryMarker | null = readRecoveryMarker
): { credentials: Credentials; source: "url" | "marker" | "none" } {
  if (fromUrl.paymentIntentId && fromUrl.clientSecret) return { credentials: fromUrl, source: "url" };
  const marker = readMarker();
  if (marker) {
    return {
      credentials: { paymentIntentId: marker.paymentIntentId, clientSecret: marker.clientSecret },
      source: "marker",
    };
  }
  return { credentials: { paymentIntentId: null, clientSecret: null }, source: "none" };
}

/**
 * Whether an answer from POST /api/reservations/complete ends the marker's
 * life. Cleared only when the engine has settled the money — booked, or the
 * hold released / never taken. Kept while anything is unresolved (including
 * an unknown state), so a refresh shows the same truthful screen again.
 */
export function markerActionFor(state: unknown): "clear" | "keep" {
  switch (state) {
    case "booked":
    case "payment_failed":
    case "payment_incomplete":
    case "failed":
      return "clear";
    default:
      return "keep";
  }
}
