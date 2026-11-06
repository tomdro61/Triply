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

/**
 * The checkout-time figures the writer (PR 2) stamps beside `discountCents`,
 * so fulfilment can check the stamp against EXACTLY what checkout priced
 * instead of a fresh ResLab price that may have moved since:
 *   onlineParkingCents      the parking paid online at checkout, before the
 *                           discount (ResLab grand_total − due_at_location)
 *   preDiscountOnlineCents  the online charge at checkout before the discount
 *                           and before Park Guard (online parking + service fee)
 * OPTIONAL and stamped as a PAIR: absent → readers bound the stamp against the
 * online parking they can see; one without the other, or either malformed, is
 * a writer bug and refuses the stamp.
 */
export const ONLINE_PARKING_CENTS_METADATA_KEY = "onlineParkingCents";
export const PRE_DISCOUNT_ONLINE_CENTS_METADATA_KEY = "preDiscountOnlineCents";

export type CheckoutFigures =
  | { kind: "absent" }
  | { kind: "figures"; onlineParkingCents: number; preDiscountOnlineCents: number }
  | { kind: "invalid"; detail: string };

/** 0..999,999,999 as `String(n)` stamps it. */
const CENTS_RE = /^(0|[1-9]\d{0,8})$/;

export function readCheckoutFigures(
  metadata: Readonly<Record<string, string | undefined>> | null | undefined
): CheckoutFigures {
  const online = metadata?.[ONLINE_PARKING_CENTS_METADATA_KEY];
  const preDiscount = metadata?.[PRE_DISCOUNT_ONLINE_CENTS_METADATA_KEY];
  if (online === undefined && preDiscount === undefined) return { kind: "absent" };
  if (online === undefined || preDiscount === undefined) {
    return { kind: "invalid", detail: "onlineParkingCents and preDiscountOnlineCents must be stamped together" };
  }
  if (!CENTS_RE.test(online) || !CENTS_RE.test(preDiscount)) {
    return {
      kind: "invalid",
      detail: `checkout figures are not whole cents (onlineParkingCents ${JSON.stringify(online)}, preDiscountOnlineCents ${JSON.stringify(preDiscount)})`,
    };
  }
  const onlineParkingCents = Number(online);
  const preDiscountOnlineCents = Number(preDiscount);
  // The pre-discount online charge is the online parking PLUS the service fee.
  if (onlineParkingCents > preDiscountOnlineCents) {
    return { kind: "invalid", detail: `onlineParkingCents ${onlineParkingCents} exceeds preDiscountOnlineCents ${preDiscountOnlineCents}` };
  }
  return { kind: "figures", onlineParkingCents, preDiscountOnlineCents };
}

/**
 * Why a stamp is refused, as a Sentry class (and the customer's wording):
 *   stamp_invalid        discountCents is not a positive whole number, or the
 *                        checkout figures are partial / malformed
 *   stamp_inconsistent   the checkout figures do not add up to the charge
 *   stamp_exceeds_checkout_online_parking   larger than the online parking at
 *                        checkout — the writer let it come out of the fee
 *   stamp_exceeds_online_parking   (no checkout figures) larger than the online
 *                        parking fulfilment can see now (fresh cost / the reservation)
 * The first three are writer bugs; the last can also be a price that moved.
 */
export type StampRefusalCause =
  | "stamp_invalid"
  | "stamp_inconsistent"
  | "stamp_exceeds_checkout_online_parking"
  | "stamp_exceeds_online_parking";

export type StampChargeCheck =
  | { ok: true; checkout: Exclude<CheckoutFigures, { kind: "invalid" }> }
  | { ok: false; cause: Exclude<StampRefusalCause, "stamp_exceeds_online_parking">; detail: string };

/**
 * Everything a PRESENT stamp can be checked against from the PaymentIntent
 * ALONE — no ResLab, no reservation — so it runs before the card is confirmed
 * (the pending route) and before anything irreversible at fulfilment (also on
 * a resume, and when ResLab's price cannot be read). With checkout figures it
 * is exact: preDiscountOnlineCents − discountCents = parkingOnlyChargeAmountCents,
 * parkingOnlyChargeAmountCents + Park Guard premium = pi.amount, and
 * discountCents ≤ onlineParkingCents. Without them only the stamp's own form
 * is checked here; the caller bounds it against the online parking it sees.
 */
export function checkStampAgainstCharge(
  metadata: Readonly<Record<string, string | undefined>> | null | undefined,
  stamped: Exclude<StampedDiscount, { kind: "absent" }>,
  charge: { premiumCents: number; piAmountCents: number }
): StampChargeCheck {
  if (stamped.kind === "invalid") {
    return { ok: false, cause: "stamp_invalid", detail: `discountCents ${JSON.stringify(stamped.raw)} is not a positive whole number of cents` };
  }
  const checkout = readCheckoutFigures(metadata);
  if (checkout.kind === "invalid") return { ok: false, cause: "stamp_invalid", detail: checkout.detail };
  if (checkout.kind === "absent") return { ok: true, checkout };

  const parkingOnlyRaw = metadata?.parkingOnlyChargeAmountCents;
  if (parkingOnlyRaw === undefined || !CENTS_RE.test(parkingOnlyRaw)) {
    return { ok: false, cause: "stamp_inconsistent", detail: `parkingOnlyChargeAmountCents ${JSON.stringify(parkingOnlyRaw)} is not whole cents` };
  }
  const parkingOnly = Number(parkingOnlyRaw);
  if (checkout.preDiscountOnlineCents - stamped.cents !== parkingOnly) {
    return {
      ok: false,
      cause: "stamp_inconsistent",
      detail: `preDiscountOnlineCents ${checkout.preDiscountOnlineCents} − discountCents ${stamped.cents} != parkingOnlyChargeAmountCents ${parkingOnly}`,
    };
  }
  if (parkingOnly + charge.premiumCents !== charge.piAmountCents) {
    return {
      ok: false,
      cause: "stamp_inconsistent",
      detail: `parkingOnlyChargeAmountCents ${parkingOnly} + premium ${charge.premiumCents} != pi.amount ${charge.piAmountCents}`,
    };
  }
  if (stamped.cents > checkout.onlineParkingCents) {
    return {
      ok: false,
      cause: "stamp_exceeds_checkout_online_parking",
      detail: `discountCents ${stamped.cents} exceeds the online parking at checkout ${checkout.onlineParkingCents}`,
    };
  }
  return { ok: true, checkout };
}
