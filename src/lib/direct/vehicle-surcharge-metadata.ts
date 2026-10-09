import { NO_OVERSIZED_VEHICLE, VEHICLE_SIZE_CODE_RE, MAX_VEHICLE_SURCHARGES } from "./vehicle-size";

/**
 * The surcharge rates a direct-lot PaymentIntent was created with (review R5):
 * one authority for what the customer was shown, so a CMS edit between
 * checkout and Pay can never change the at-lot amount we store or email.
 *
 * Stripe metadata values are strings (≤ 500 chars). Format:
 *   "small_suv:500,midsize_suv:700,large_suv_truck:1000"   (code:cents per day)
 *   "none"                                                  (the lot offers no surcharges)
 * NOT "": Stripe treats an empty metadata value as "unset this key", on create
 * too, so "" would come back as a missing key. The KEY is always written for a
 * direct lot; a missing (or empty) value is an integrity error for the reader,
 * never "no surcharges".
 */
export const DIRECT_SURCHARGES_KEY = "directSurcharges";
export const DIRECT_TAX_RATE_KEY = "directTaxRatePercent";
/** The value for "this lot offers no surcharges" (never "" — see above). */
export const NO_SURCHARGES_VALUE = NO_OVERSIZED_VEHICLE;

export interface SurchargeRate {
  code: string;
  dailyRateCents: number;
}

export function encodeSurchargeRates(rates: readonly SurchargeRate[]): string {
  if (rates.length > MAX_VEHICLE_SURCHARGES) throw new Error("too many vehicle surcharges");
  if (rates.length === 0) return NO_SURCHARGES_VALUE;
  return rates
    .map((r) => {
      if (!VEHICLE_SIZE_CODE_RE.test(r.code) || r.code === NO_OVERSIZED_VEHICLE) throw new Error(`bad surcharge code ${r.code}`);
      if (!Number.isInteger(r.dailyRateCents) || r.dailyRateCents <= 0) throw new Error(`bad surcharge rate for ${r.code}`);
      return `${r.code}:${r.dailyRateCents}`;
    })
    .join(",");
}

/** Strict inverse of encodeSurchargeRates. null = missing or malformed (refuse; never treat as "none"). */
export function decodeSurchargeRates(value: string | undefined): SurchargeRate[] | null {
  if (value === undefined || value === "") return null;
  if (value === NO_SURCHARGES_VALUE) return [];
  const parts = value.split(",");
  if (parts.length > MAX_VEHICLE_SURCHARGES) return null;
  const out: SurchargeRate[] = [];
  for (const part of parts) {
    const m = /^([a-z0-9_]{1,32}):([1-9]\d{0,6})$/.exec(part);
    if (!m || m[1] === NO_OVERSIZED_VEHICLE || out.some((r) => r.code === m[1])) return null;
    out.push({ code: m[1], dailyRateCents: Number(m[2]) });
  }
  return out;
}

// At most 3 decimals: the same precision as bookings.direct_tax_rate_percent
// NUMERIC(6,3) (migration 034) and the CMS validator — a 4th decimal would be
// charged here and silently rounded when the booking is stored.
const TAX_RATE_RE = /^\d{1,3}(\.\d{1,3})?$/;

/** Tax rate stamped as a plain decimal string ("16", "18.375"). null = missing or malformed. */
export function decodeTaxRatePercent(value: string | undefined): number | null {
  if (value === undefined || !TAX_RATE_RE.test(value)) return null;
  const n = Number(value);
  return n >= 0 && n <= 100 ? n : null;
}

/**
 * Whether a lot's tax rate survives the metadata round trip exactly. The store
 * refuses a lot whose rate does not (more than 3 decimals, exponent form), so
 * a PaymentIntent can never be created that the pending route would refuse.
 */
export function isEncodableTaxRatePercent(rate: number): boolean {
  return decodeTaxRatePercent(String(rate)) === rate;
}
