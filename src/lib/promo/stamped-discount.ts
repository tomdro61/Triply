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
 * Stamped as a PAIR, and REQUIRED beside a stamp (PR 2): checkout writes all
 * three keys together (promoStampMetadata), so a stamp without them, one
 * without the other, or either malformed is a writer bug or tampering and
 * refuses the stamp before the card is confirmed (checkStampAgainstCharge).
 * Only the fulfilment backstop still copes with their absence, for a payment
 * already captured.
 */
export const ONLINE_PARKING_CENTS_METADATA_KEY = "onlineParkingCents";
export const PRE_DISCOUNT_ONLINE_CENTS_METADATA_KEY = "preDiscountOnlineCents";

export type CheckoutFigures =
  | { kind: "absent" }
  | { kind: "figures"; onlineParkingCents: number; preDiscountOnlineCents: number }
  | { kind: "invalid"; detail: string };

/** 0..999,999,999 as `String(n)` stamps it. */
const CENTS_RE = /^(0|[1-9]\d{0,8})$/;
/** `String(dollars)` of a cents-rounded fee: "5.95", "6", "12.5". */
const SERVICE_FEE_RE = /^(0|[1-9]\d{0,6})(\.\d{1,2})?$/;

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
 *                        checkout figures are missing, partial or malformed
 *   stamp_inconsistent   the checkout figures do not add up to the charge
 *   stamp_exceeds_checkout_online_parking   larger than the online parking at
 *                        checkout — the writer let it come out of the fee
 * All three are writer bugs (or tampering): a price that moved after checkout
 * is reported as a price drop, never refused.
 */
export type StampRefusalCause = "stamp_invalid" | "stamp_inconsistent" | "stamp_exceeds_checkout_online_parking";

export type CheckoutFiguresPresent = Extract<CheckoutFigures, { kind: "figures" }>;

export type StampChargeCheck =
  | { ok: true; cents: number; checkout: CheckoutFiguresPresent }
  | { ok: false; cause: StampRefusalCause; detail: string };

/**
 * Everything a PRESENT stamp can be checked against from the PaymentIntent
 * ALONE — no ResLab, no reservation — so it runs before the card is confirmed
 * (the pending route) and before anything irreversible at fulfilment (also on
 * a resume, and when ResLab's price cannot be read). Exact, on checkout's own
 * figures (required): preDiscountOnlineCents − onlineParkingCents = the
 * service fee, preDiscountOnlineCents − discountCents =
 * parkingOnlyChargeAmountCents, parkingOnlyChargeAmountCents + Park Guard
 * premium = pi.amount, and discountCents ≤ onlineParkingCents.
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
  if (checkout.kind === "absent") {
    return { ok: false, cause: "stamp_invalid", detail: "discountCents is stamped without onlineParkingCents / preDiscountOnlineCents" };
  }

  const parkingOnlyRaw = metadata?.parkingOnlyChargeAmountCents;
  if (parkingOnlyRaw === undefined || !CENTS_RE.test(parkingOnlyRaw)) {
    return { ok: false, cause: "stamp_inconsistent", detail: `parkingOnlyChargeAmountCents ${JSON.stringify(parkingOnlyRaw)} is not whole cents` };
  }
  // The two figures differ by exactly the service fee (stamped beside them by
  // both checkout paths, never rewritten by /update-pi). Without this, an
  // onlineParkingCents that forgot to subtract due_at_location would pass every
  // other check and let a discount come out of the fee.
  const feeRaw = metadata?.serviceFee;
  if (feeRaw === undefined || !SERVICE_FEE_RE.test(feeRaw)) {
    return { ok: false, cause: "stamp_inconsistent", detail: `serviceFee ${JSON.stringify(feeRaw)} is not a dollar amount` };
  }
  const feeCents = Math.round(Number(feeRaw) * 100);
  if (checkout.preDiscountOnlineCents - checkout.onlineParkingCents !== feeCents) {
    return {
      ok: false,
      cause: "stamp_inconsistent",
      detail: `preDiscountOnlineCents ${checkout.preDiscountOnlineCents} − onlineParkingCents ${checkout.onlineParkingCents} != serviceFee ${feeCents}`,
    };
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
  return { ok: true, cents: stamped.cents, checkout };
}

/**
 * The service fee a STAMPED PaymentIntent charged, in cents — checkout's
 * preDiscountOnline − onlineParking, when it equals `metadata.serviceFee` — or
 * null (no usable stamp, or figures that don't add up, which the stamp checks
 * refuse anyway). The booking payload's own fee is the checkout page's
 * page-load figure, which a price move before the PaymentIntent leaves stale;
 * on a stamped payment the exact stamp no longer hides that difference.
 */
export function chargedServiceFeeCents(metadata: Readonly<Record<string, string | undefined>> | null | undefined): number | null {
  if (readStampedDiscount(metadata).kind !== "cents") return null;
  const figures = readCheckoutFigures(metadata);
  if (figures.kind !== "figures") return null;
  const feeRaw = metadata?.serviceFee;
  if (feeRaw === undefined || !SERVICE_FEE_RE.test(feeRaw)) return null;
  const feeCents = Math.round(Number(feeRaw) * 100);
  return figures.preDiscountOnlineCents - figures.onlineParkingCents === feeCents ? feeCents : null;
}

/**
 * The writer's half — the keys POST /api/checkout/lot stamps on a PaymentIntent
 * whose promo code gave a discount: the code, `discountCents` and checkout's
 * two figures, ALWAYS together and in integer cents, plus `discountPercent`
 * (display only) for a percent code. A code that gave no discount stamps
 * nothing. Throws rather than write a stamp the readers would refuse: the
 * figures come from the server's own price, so a bad one is a programming
 * error, and no PaymentIntent is created.
 */
export function promoStampMetadata(input: {
  code: string;
  percent: number | null;
  discountCents: number;
  onlineParkingCents: number;
  preDiscountOnlineCents: number;
}): Record<string, string> {
  const { code, percent, discountCents, onlineParkingCents, preDiscountOnlineCents } = input;
  const cents = (n: number) => Number.isSafeInteger(n) && n >= 0;
  if (
    !POSITIVE_CENTS_RE.test(String(discountCents)) ||
    !cents(onlineParkingCents) ||
    !cents(preDiscountOnlineCents) ||
    discountCents > onlineParkingCents ||
    onlineParkingCents > preDiscountOnlineCents
  ) {
    throw new Error(
      `promoStampMetadata: unusable figures for ${code} (discountCents ${discountCents}, onlineParkingCents ${onlineParkingCents}, preDiscountOnlineCents ${preDiscountOnlineCents})`
    );
  }
  return {
    promoCode: code,
    [DISCOUNT_CENTS_METADATA_KEY]: String(discountCents),
    [ONLINE_PARKING_CENTS_METADATA_KEY]: String(onlineParkingCents),
    [PRE_DISCOUNT_ONLINE_CENTS_METADATA_KEY]: String(preDiscountOnlineCents),
    ...(percent !== null && { discountPercent: String(percent) }),
  };
}
