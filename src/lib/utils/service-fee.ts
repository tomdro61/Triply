/**
 * Triply platform service fee calculation.
 *
 * Fee = max($5.95, 6% of parking base cost).
 * Minimum raised $4.95 → $5.95 on 2026-09-14 (Tom). The floor applies to any
 * parking base under $99.17 (6% × 99.17 = 5.95); larger bookings pay 6%.
 * "Parking base cost" = ResLab sub_total + fees_total (before taxes).
 *
 * Configurable via env vars:
 *   TRIPLY_SERVICE_FEE_PERCENT  – default 6
 *   TRIPLY_SERVICE_FEE_MIN      – default 5.95
 */

import type { UnifiedLot } from "@/types/lot";

/** Shown beside every total built by customerTotalFromPricing — one string so
 *  the cards, the lot page and the slider can't drift apart. */
export const TAXES_AND_FEES_INCLUDED = "Taxes & fees included";

/** The pricing fields the customer total is built from — tied to the lot type,
 *  so renaming one of them fails the build instead of blanking every price. */
export type PricingTotals = Pick<
  NonNullable<UnifiedLot["pricing"]>,
  "grandTotal" | "subtotal" | "feesTotal" | "taxTotal" | "numberOfDays"
>;

const FEE_PERCENT = parseFloat(process.env.TRIPLY_SERVICE_FEE_PERCENT || "6");
const FEE_MIN = parseFloat(process.env.TRIPLY_SERVICE_FEE_MIN || "5.95");

/**
 * Calculate the Triply service fee for a booking.
 * @param parkingBase - sub_total + fees_total from ResLab (before taxes)
 * @returns fee rounded to 2 decimal places
 */
export function calculateServiceFee(parkingBase: number): number {
  const percentageFee = parkingBase * (FEE_PERCENT / 100);
  return Math.round(Math.max(FEE_MIN, percentageFee) * 100) / 100;
}

/**
 * Customer total for the stay that was priced: ResLab's grand total (tax and
 * ResLab fees included, including any part paid at the lot) plus our service
 * fee. Optional Park Guard and promo codes are not in it.
 * Prefers subtotal + feesTotal as the parking base; falls back to grandTotal − taxTotal.
 * Returns null if there isn't enough data to compute.
 */
export function customerTotalFromPricing(
  pricing: Omit<PricingTotals, "numberOfDays"> | undefined
): number | null {
  if (!pricing?.grandTotal) return null;
  const parkingBase =
    pricing.subtotal !== undefined
      ? pricing.subtotal + (pricing.feesTotal || 0)
      : pricing.grandTotal - (pricing.taxTotal || 0);
  return pricing.grandTotal + calculateServiceFee(parkingBase);
}

/**
 * The customer total spread over the billed days (ResLab's `number_of_days`,
 * or `directDays` for a direct lot) — the per-day figure shown beside the
 * total, so both include taxes and fees. Null without a total or a billed-day
 * count: never fall back to `minPrice`, which is a pre-tax daily rate without
 * our service fee.
 */
export function customerPerDayFromPricing(pricing: PricingTotals | undefined): number | null {
  const total = customerTotalFromPricing(pricing);
  const days = pricing?.numberOfDays;
  if (total === null || !days || days <= 0) return null;
  return total / days;
}
