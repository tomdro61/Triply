/**
 * Triply platform service fee calculation.
 *
 * Fee = max($4.95, 6% of parking base cost).
 * "Parking base cost" = ResLab sub_total + fees_total (before taxes).
 *
 * Configurable via env vars:
 *   TRIPLY_SERVICE_FEE_PERCENT  – default 6
 *   TRIPLY_SERVICE_FEE_MIN      – default 4.95
 */

const FEE_PERCENT = parseFloat(process.env.TRIPLY_SERVICE_FEE_PERCENT || "6");
const FEE_MIN = parseFloat(process.env.TRIPLY_SERVICE_FEE_MIN || "4.95");

/**
 * Calculate the Triply service fee for a booking.
 * @param parkingBase - sub_total + fees_total from ResLab (before taxes)
 * @returns fee rounded to 2 decimal places
 */
export function calculateServiceFee(parkingBase: number): number {
  const percentageFee = parkingBase * (FEE_PERCENT / 100);
  return Math.round(Math.max(FEE_MIN, percentageFee) * 100) / 100;
}
