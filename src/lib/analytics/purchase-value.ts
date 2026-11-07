/**
 * What the GA4 `purchase` event reports for a booking's promo code (promo plan
 * D3, notes/2026-11-07-promo-d3-accounting-plan.md). Pure, so it can be tested
 * without the confirmation page.
 *
 *   grossTotal  the booking's total before the promo discount — the
 *               reservation API's `grandTotal` on both kinds of lot (ResLab:
 *               the whole trip incl. the part paid at the lot; direct: all
 *               online)
 *   discount    the promo discount the booking got (`bookings.discount_amount`)
 *   coupon      the code's FAMILY for GA4's coupon reports
 *
 * An unknown discount (the API couldn't read the booking row) reports the
 * value before the discount and no coupon — as before D3, never a guess.
 */

/**
 * The family a code reports under. WELCOME codes are minted one per newsletter
 * subscriber (`WELCOME-<suffix>`, /api/newsletter): the full code would be a
 * per-person key in GA4 and hundreds of single-use rows. Every other code is
 * shared (JFK5, THANKS10) and reports as itself.
 */
export function promoCouponFamily(code: string | null | undefined): string | null {
  const c = code?.trim().toUpperCase();
  if (!c) return null;
  return c.startsWith("WELCOME-") ? "WELCOME" : c;
}

export interface PurchasePromo {
  grossTotal: number;
  discount: number;
  coupon: string | null;
}

export function purchasePromo(r: { grandTotal: number; promoDiscount?: number | null; promoCode?: string | null }): PurchasePromo {
  const d = r.promoDiscount;
  if (typeof d !== "number" || !Number.isFinite(d)) return { grossTotal: r.grandTotal, discount: 0, coupon: null };
  return { grossTotal: r.grandTotal, discount: Math.max(0, d), coupon: promoCouponFamily(r.promoCode) };
}
