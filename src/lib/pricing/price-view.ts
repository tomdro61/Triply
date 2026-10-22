/**
 * The figures a price box shows (lot page booking box, search slider), built
 * from either the lot's own pricing (priced when the page loaded) or a fresh
 * quote from GET /api/lots/quote — whose totals equal what checkout charges
 * for the same stay, before optional Park Guard protection and any promo.
 * Pure: no fetching, no React.
 *
 * A PriceView only exists when its lines add up to its total: any missing or
 * non-finite part, or parts that fall short of the grand total, → null (no
 * figure), never a made-up $0.00 line.
 */
import { calculateServiceFee, type PricingTotals } from "@/lib/utils/service-fee";

export interface PriceView {
  /** Whole stay: the grand total (ResLab's, or the direct quote's — tax, ResLab
   *  fees and any part paid at the lot included) + our service fee. Excludes an
   *  oversized-vehicle surcharge a direct lot collects at the gate. */
  total: number;
  /** total ÷ billed days; null without a day count. */
  perDay: number | null;
  /** Billed days; null when unknown. */
  days: number | null;
  /** Parking before tax: sub_total + fees_total (before any long-stay discount). */
  parking: number;
  /** What the parts exceed the grand total by (normally ResLab's long-stay
   *  discount), so the lines add up; 0 when none. */
  discount: number;
  taxes: number;
  serviceFee: number;
  /** Part of the total paid at the lot; 0 when none. */
  dueAtLocation: number;
}

/** GET /api/lots/quote's answer: the stay's parts, in dollars. */
export interface LotQuote {
  grandTotal: number;
  subtotal: number;
  feesTotal: number;
  taxTotal: number;
  serviceFee: number;
  dueAtLocation: number;
  numberOfDays?: number;
  soldOut: boolean;
}

interface Parts {
  grandTotal: number;
  subtotal: number;
  feesTotal: number;
  taxTotal: number;
  serviceFee: number;
  dueAtLocation: number;
  numberOfDays?: number;
}

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const cents = (n: number) => Math.round(n * 100) / 100;

function build(p: Parts): PriceView | null {
  if (![p.grandTotal, p.subtotal, p.feesTotal, p.taxTotal, p.serviceFee, p.dueAtLocation].every(finite)) return null;
  if (!(p.grandTotal > 0)) return null;
  const parking = p.subtotal + p.feesTotal;
  const gap = cents(parking + p.taxTotal - p.grandTotal);
  // Parts short of the grand total by more than a cent: something is missing.
  if (gap < -0.01) return null;
  const days = finite(p.numberOfDays) && p.numberOfDays > 0 ? p.numberOfDays : null;
  const total = p.grandTotal + p.serviceFee;
  return {
    total,
    perDay: days ? total / days : null,
    days,
    parking,
    discount: gap > 0 ? gap : 0,
    taxes: p.taxTotal,
    serviceFee: p.serviceFee,
    dueAtLocation: p.dueAtLocation,
  };
}

/** From a lot's own pricing (the same total the search card shows). */
export function priceViewFromPricing(
  pricing: PricingTotals | undefined,
  dueAtLocation: number | undefined
): PriceView | null {
  if (!pricing || !finite(pricing.grandTotal) || !finite(pricing.subtotal) || !finite(pricing.taxTotal)) return null;
  const feesTotal = pricing.feesTotal ?? 0; // ResLab sends 0 when a lot has no fees
  return build({
    grandTotal: pricing.grandTotal,
    subtotal: pricing.subtotal,
    feesTotal,
    taxTotal: pricing.taxTotal,
    serviceFee: calculateServiceFee(pricing.subtotal + feesTotal),
    dueAtLocation: dueAtLocation ?? 0,
    numberOfDays: pricing.numberOfDays,
  });
}

/** From a fresh quote for the stay on screen. */
export function priceViewFromQuote(quote: LotQuote): PriceView | null {
  return build(quote);
}

export const formatMoney = (n: number) => "$" + n.toFixed(2);
