/**
 * The figures a price box shows (lot page booking box, search slider), built
 * from either the lot's own pricing (priced for the window the page was loaded
 * with) or a fresh checkout quote (GET /api/checkout/lot — the same endpoint
 * and numbers the checkout page shows). Pure: no fetching, no React.
 */
import type { CheckoutCostData } from "@/types/checkout";
import { customerTotalFromPricing, type PricingTotals } from "@/lib/utils/service-fee";

export interface PriceView {
  /** Whole stay: ResLab grand total (tax, ResLab fees, any part paid at the lot) + our service fee. */
  total: number;
  /** total ÷ billed days; null without a day count. */
  perDay: number | null;
  /** Billed days; null when unknown. */
  days: number | null;
  /** Parking before tax: ResLab sub_total + fees_total (before any long-stay discount). */
  parking: number;
  /** ResLab long-stay discount, so the lines add up to the total; 0 when none. */
  discount: number;
  taxes: number;
  serviceFee: number;
  /** Part of the total paid at the lot; 0 when none. */
  dueAtLocation: number;
}

const cents = (n: number) => Math.round(n * 100) / 100;

/** What the parts leave over the grand total — ResLab's long-stay discount. */
function discountOf(parking: number, taxes: number, grandTotal: number): number {
  const d = cents(parking + taxes - grandTotal);
  return d > 0 ? d : 0;
}

/** From a lot's own pricing; null when it has no total (never a fee-less figure). */
export function priceViewFromPricing(
  pricing: PricingTotals | undefined,
  dueAtLocation: number | undefined
): PriceView | null {
  const total = customerTotalFromPricing(pricing);
  if (total === null || !pricing?.grandTotal) return null;
  const parking = (pricing.subtotal ?? 0) + (pricing.feesTotal ?? 0);
  const taxes = pricing.taxTotal ?? 0;
  const days = pricing.numberOfDays && pricing.numberOfDays > 0 ? pricing.numberOfDays : null;
  return {
    total,
    perDay: days ? total / days : null,
    days,
    parking,
    discount: discountOf(parking, taxes, pricing.grandTotal),
    taxes,
    serviceFee: cents(total - pricing.grandTotal),
    dueAtLocation: dueAtLocation ?? 0,
  };
}

/** From a fresh checkout quote — the figures checkout itself shows for these dates and times. */
export function priceViewFromCost(cost: CheckoutCostData): PriceView | null {
  if (!(cost.grandTotal > 0) || !Number.isFinite(cost.serviceFee)) return null;
  const parking = cost.subtotal + cost.feesTotal;
  const days = cost.numberOfDays && cost.numberOfDays > 0 ? cost.numberOfDays : null;
  const total = cost.grandTotal + cost.serviceFee;
  return {
    total,
    perDay: days ? total / days : null,
    days,
    parking,
    discount: discountOf(parking, cost.taxTotal, cost.grandTotal),
    taxes: cost.taxTotal,
    serviceFee: cost.serviceFee,
    dueAtLocation: cost.dueAtLocation,
  };
}
