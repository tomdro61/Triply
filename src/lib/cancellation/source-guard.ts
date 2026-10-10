import { isTriplyConfirmationNumber } from "@/lib/direct/confirmation-number";

/**
 * Which inventory system a cancel must release (direct-lots plan 4b §9 H-C).
 *
 * The polarity is deliberately strict: a ResLab cancel is skipped ONLY when the
 * row says `direct` AND carries our own TRP- number. Getting this backwards
 * would refund a ResLab customer while their real ResLab spot stays live (and
 * ResLab invoices us for it), so:
 *   - `direct` + TRP- number                     → "direct"  (no vendor to release)
 *   - non-TRP number + source "reslab" / absent  → "reslab"  (exactly as before —
 *     older selects don't read inventory_source)
 *   - anything else (the two disagree)           → "inconsistent": refuse, alert
 */
export type CancelSource =
  | { kind: "reslab" }
  | { kind: "direct" }
  | { kind: "inconsistent"; detail: string };

export function cancelSource(row: {
  inventory_source?: string | null;
  reslab_reservation_number: string;
}): CancelSource {
  const triplyNumber = isTriplyConfirmationNumber(row.reslab_reservation_number);
  const source = row.inventory_source;

  if (source === "direct" && triplyNumber) return { kind: "direct" };
  if (!triplyNumber && (source === "reslab" || source == null)) return { kind: "reslab" };
  return {
    kind: "inconsistent",
    detail: `inventory_source=${JSON.stringify(source)} with reservation number ${row.reslab_reservation_number}`,
  };
}

/** True when this deployment's Stripe key is a LIVE key. */
export function stripeKeyIsLive(key: string = process.env.STRIPE_SECRET_KEY ?? ""): boolean {
  return key.startsWith("sk_live_") || key.startsWith("rk_live_");
}

/**
 * A booking paid in the OTHER Stripe mode than this deployment's key — a
 * staging test booking seen by production, or a live booking seen by staging
 * (they share one database). Acting on it would refund with the wrong key (a
 * 404), mark it cancelled anyway, email the customer, and route any lot notice
 * to the wrong place (plan §9 H-D).
 *
 *   - `undefined` — the caller's select didn't read the column: no guard (the
 *     path behaves exactly as before the column existed).
 *   - `null`      — a pre-015 row. Every one of those is a real LIVE booking, so
 *     it is treated as live: production (live key) acts on it as before, while
 *     a TEST key — staging, or localhost, which talks to PRODUCTION ResLab —
 *     refuses rather than cancel a real customer's reservation.
 *   - boolean     — compared with the key's mode.
 *
 * The cancellation cron's scan filter (`livemode.is.null,livemode.eq.true` on a
 * live key) encodes the same NULL-is-live rule.
 */
export function isOtherStripeMode(
  livemode: boolean | null | undefined,
  keyIsLive: boolean = stripeKeyIsLive()
): boolean {
  if (livemode === undefined) return false;
  const bookingIsLive = livemode ?? true;
  return bookingIsLive !== keyIsLive;
}

/** Staff wording (admin route): tells ops where to manage the booking. */
export const OTHER_MODE_MESSAGE =
  "This booking was made in the other environment (staging vs production). Manage it from that environment's admin.";

/** Customer wording (self-cancel + cancel-preview): no environment jargon. */
export const OTHER_MODE_CUSTOMER_MESSAGE =
  "We can't change this reservation online right now. Please contact support.";
