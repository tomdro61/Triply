/**
 * Price-label strings, shared by Park & Stay and (when it ships) P3's
 * fee-inclusive price display. One file so the claim a price makes can never
 * differ between surfaces.
 *
 * Park & Stay plan v3 §5.2: NY and NJ occupancy tax may apply to Triply's
 * full selling price, markup included. Until the accountant answers M16 we
 * collect no room tax, so the claim "Total includes taxes and fees" is NOT
 * made anywhere — the interim label below says only what we know. When M16
 * is answered, switch to P3's wording (`formatPriceLine`).
 */

export const PARK_STAY_TOTAL_LABEL_INTERIM = "Total incl. fees and the taxes we know of";
export const PARK_STAY_TAX_PENDING_NOTE = "Preview — hotel tax rules pending";

/** "$18.45 of this is paid at the hotel" — only rendered when the amount is > 0. */
export function paidAtHotelLine(formattedAmount: string): string {
  return `${formattedAmount} of this is paid at the hotel`;
}
