import type { UnifiedLot } from "@/types/lot";

/**
 * The lot's minimum stay when the searched stay is shorter than it, else null.
 *
 * Compares the billed days ResLab priced for this search (`pricing.numberOfDays`)
 * with `minimumBookingDays`: the same rule the slider and lot page use to
 * disable Reserve (product-detail-slider.tsx, booking-widget.tsx), applied
 * before a customer opens the lot. Null when either number is missing, so an
 * unpriced lot is never flagged on a guess.
 *
 * Why: search listed and priced lots the stay couldn't book (JFK Bolt, min 6
 * days, on a 5-day search), and could badge them "Lowest total"; the slider
 * then showed a dead Reserve button whose reason only appeared on hover
 * (customer-army audit 2026-11-06, item 1).
 */
export function unmetMinimumStay(lot: Pick<UnifiedLot, "minimumBookingDays" | "pricing">): number | null {
  const min = lot.minimumBookingDays;
  const days = lot.pricing?.numberOfDays;
  if (!min || min <= 1 || days === undefined || !Number.isFinite(days)) return null;
  return days < min ? min : null;
}
