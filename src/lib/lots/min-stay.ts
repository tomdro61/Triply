import type { UnifiedLot } from "@/types/lot";

/**
 * The lot's minimum stay when the searched stay is shorter than it, else null.
 *
 * Compares the billed days this search was priced for (`pricing.numberOfDays`,
 * ResLab and direct lots alike) with `minimumBookingDays`, before a customer
 * opens the lot. The slider and lot page apply the same comparison to the quote
 * for the times on screen (product-detail-slider.tsx, booking-widget.tsx), so
 * after the customer changes times those can differ from this search-time
 * flag; the on-screen quote is the one that gates Reserve. Null when either
 * number is missing, so an unpriced lot is never flagged on a guess.
 *
 * Why: search listed and priced lots the stay couldn't book (JFK Bolt, min 6
 * days, on a 5-day search), and could badge them "Lowest total"; the slider
 * then showed a dead Reserve button whose reason only appeared on hover
 * (customer-army audit 2026-11-06, item 1).
 */
export function unmetMinimumStay(lot: Pick<UnifiedLot, "minimumBookingDays" | "pricing">): number | null {
  const min = lot.minimumBookingDays;
  const days = lot.pricing?.numberOfDays;
  // Same "unknown" rule as the slider's price view (price-view.ts): no positive
  // day count, no claim.
  if (!min || min <= 1 || days === undefined || !Number.isFinite(days) || days <= 0) return null;
  return days < min ? min : null;
}
