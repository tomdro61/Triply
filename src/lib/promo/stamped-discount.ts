/**
 * The `discountCents` key on a PaymentIntent's metadata — the promo discount
 * checkout ACTUALLY APPLIED, in integer cents
 * (plan notes/2026-11-06-promo-fixed-amount-plan.md, Part 1).
 *
 * Every reader of a promo discount treats it as the authority when present:
 *   present  use it; do NOT recompute from `discountPercent`, which may sit
 *            beside it for display only (a capped percent code, or a fixed
 *            code, has no percent that reproduces it).
 *   absent   today's percent behaviour, unchanged — PaymentIntents in flight
 *            when the writer ships, and every booking made before it.
 * A stamp that is not a positive whole number, or that exceeds the parking
 * paid online, is refused and reported by the reader — never trusted, never
 * coerced to 0.
 *
 * Pure and import-free: the confirmation page, the emails, the direct money
 * check and the booking engine all read it.
 */

export const DISCOUNT_CENTS_METADATA_KEY = "discountCents";

export type StampedDiscount =
  | { kind: "absent" }
  | { kind: "cents"; cents: number }
  | { kind: "invalid"; raw: string };

/** 1..999,999,999 with no sign, decimals, spaces or leading zeros — exactly what `String(n)` stamps. */
const POSITIVE_CENTS_RE = /^[1-9]\d{0,8}$/;

/**
 * Read the stamp. An empty string is INVALID, not absent: Stripe deletes a key
 * set to "", so one can never be read back from a real PaymentIntent — seeing
 * one means something other than checkout wrote this metadata.
 */
export function readStampedDiscount(
  metadata: Readonly<Record<string, string | undefined>> | null | undefined
): StampedDiscount {
  const raw = metadata?.[DISCOUNT_CENTS_METADATA_KEY];
  if (raw === undefined) return { kind: "absent" };
  return POSITIVE_CENTS_RE.test(raw) ? { kind: "cents", cents: Number(raw) } : { kind: "invalid", raw };
}

/**
 * Why a present stamp cannot be trusted, or null when it can.
 * `onlineParkingCents` is the parking paid online BEFORE the discount —
 * ResLab `grand_total − due_at_location`, direct grand total — the most any
 * discount may take (Part 0: a discount never comes out of the service fee).
 * An unknown online parking (not whole cents) refuses too: the bound cannot be
 * checked.
 */
export function stampedDiscountRefusal(
  stamped: Exclude<StampedDiscount, { kind: "absent" }>,
  onlineParkingCents: number
): string | null {
  if (stamped.kind === "invalid") {
    return `discountCents ${JSON.stringify(stamped.raw)} is not a positive whole number of cents`;
  }
  if (!Number.isSafeInteger(onlineParkingCents) || onlineParkingCents < 0) {
    return `discountCents ${stamped.cents} cannot be checked: the online parking is unknown (${onlineParkingCents})`;
  }
  if (stamped.cents > onlineParkingCents) {
    return `discountCents ${stamped.cents} exceeds the online parking ${onlineParkingCents}`;
  }
  return null;
}
