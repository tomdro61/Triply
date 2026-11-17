/**
 * Did the PaymentIntent get priced differently from the checkout page?
 *
 * The order summary and the Pay button show the figures the page loaded with;
 * the PaymentIntent is priced from a fresh read when the customer clicks
 * Continue. If any compared figure differs by a cent, the card would be
 * charged an amount the customer was never shown, so the checkout stops
 * before the card is confirmed and asks for a reload.
 *
 * Fails closed: a figure that is missing or not a number on EITHER side counts
 * as a difference (NaN never equals NaN).
 */
const toCents = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) ? Math.round(n * 100) : Number.NaN);

export function pricedDifferently<K extends string>(
  page: Partial<Record<K, unknown>>,
  paymentIntent: Partial<Record<K, unknown>>,
  fields: readonly K[]
): boolean {
  return fields.some((field) => toCents(page[field]) !== toCents(paymentIntent[field]));
}

/** Direct lots: the at-lot estimate moves with the vehicle size, so only what is charged online is compared. */
export const DIRECT_DRIFT_FIELDS = ["subtotal", "taxTotal", "serviceFee"] as const;

/**
 * Converted (Canadian-dollar) lots: every part AND the total. The total is
 * there because a part the response does not itemise (ResLab's long-stay
 * discount) changes it while every listed part stays the same.
 */
export const CONVERTED_DRIFT_FIELDS = ["subtotal", "feesTotal", "taxTotal", "serviceFee", "dueAtLocation", "grandTotal"] as const;
