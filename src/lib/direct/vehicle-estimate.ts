import { computeVehicleSurcharge } from "./pricing";
import { NO_OVERSIZED_VEHICLE } from "./vehicle-size";
import {
  DIRECT_SURCHARGES_KEY,
  DIRECT_TAX_RATE_KEY,
  decodeSurchargeRates,
  decodeTaxRatePercent,
} from "./vehicle-surcharge-metadata";

/**
 * The at-lot vehicle estimate for a direct booking, computed ONLY from the
 * PaymentIntent's metadata (review R5) — the rates and tax rate the customer
 * was shown when the payment was created, and the billed days the parking was
 * charged for. Client cents are never accepted (B10).
 *
 *   metadata   a key is missing or malformed — an integrity error (refuse,
 *              report); never treated as "no surcharges"
 *   unknown_size  the chosen code is not one this payment was priced with
 *              (the lot changed its sizes, or a tampered body) — refuse; the
 *              customer re-chooses
 */
export type DirectVehicleEstimate =
  | { ok: true; vehicleSize: string; surchargeCents: number; surchargeTaxCents: number }
  | { ok: false; reason: "metadata"; detail: string }
  | { ok: false; reason: "unknown_size" };

export function directVehicleEstimate(vehicleSize: string, meta: Record<string, string | undefined>): DirectVehicleEstimate {
  const rates = decodeSurchargeRates(meta[DIRECT_SURCHARGES_KEY]);
  if (rates === null) return { ok: false, reason: "metadata", detail: `${DIRECT_SURCHARGES_KEY} missing or malformed` };
  const taxRatePercent = decodeTaxRatePercent(meta[DIRECT_TAX_RATE_KEY]);
  if (taxRatePercent === null) return { ok: false, reason: "metadata", detail: `${DIRECT_TAX_RATE_KEY} missing or malformed` };
  const daysRaw = meta.directDays;
  const days = daysRaw !== undefined && /^[1-9]\d{0,3}$/.test(daysRaw) ? Number(daysRaw) : null;
  if (days === null) return { ok: false, reason: "metadata", detail: "directDays missing or malformed" };

  if (vehicleSize === NO_OVERSIZED_VEHICLE) {
    return { ok: true, vehicleSize, surchargeCents: 0, surchargeTaxCents: 0 };
  }
  const rate = rates.find((r) => r.code === vehicleSize);
  if (!rate) return { ok: false, reason: "unknown_size" };
  const q = computeVehicleSurcharge({ days, dailyRateCents: rate.dailyRateCents, taxRatePercent });
  return { ok: true, vehicleSize, surchargeCents: q.surchargeCents, surchargeTaxCents: q.surchargeTaxCents };
}
