import { computeDirectQuote, computeVehicleSurcharge, directDays } from "./pricing";
import { NO_OVERSIZED_VEHICLE, type VehicleSizeSource } from "./vehicle-size";
import { convertTo24Hour } from "@/lib/utils/time";

/**
 * Browser-safe display math for the oversized-vehicle choice (vehicle-surcharge
 * plan §1.4/§1.5, R1/R6). Used by the Reserve pop-up and the checkout selector so
 * they show the same numbers. DISPLAY ONLY: the server computes what is stored
 * and emailed from the PaymentIntent's own terms (R5), never from these.
 *
 * Nothing here is ever an online amount — the surcharge is paid at the lot.
 */

export const NO_OVERSIZED_LABEL = "No oversized vehicle";

export interface VehicleSizeOption {
  code: string;
  label: string;
  /** 0 for "No oversized vehicle". */
  dailyRateCents: number;
}

/** "No oversized vehicle" first, then the lot's sizes in CMS order. */
export function vehicleSizeOptions(surcharges: readonly { code: string; label: string; dailyRateCents: number }[]): VehicleSizeOption[] {
  return [{ code: NO_OVERSIZED_VEHICLE, label: NO_OVERSIZED_LABEL, dailyRateCents: 0 }, ...surcharges.map((s) => ({ ...s }))];
}

export interface AtLotEstimate {
  surchargeCents: number;
  surchargeTaxCents: number;
  atLotCents: number;
}

export function atLotEstimate(option: VehicleSizeOption, days: number, taxRatePercent: number): AtLotEstimate {
  return computeVehicleSurcharge({ days, dailyRateCents: option.dailyRateCents, taxRatePercent });
}

/**
 * The online charge (parking + tax + service fee, before any promo or Park
 * Guard) and billed days for the dates and times CURRENTLY on screen (R6) —
 * the lot page's quote was priced once, from the URL, and is not re-priced on
 * edits. null when the window does not price (missing time, reversed range).
 */
export function directReserveQuote(input: {
  rateCents: number;
  taxRatePercent: number;
  checkIn: string;
  checkInTime: string;
  checkOut: string;
  checkOutTime: string;
}): { days: number; onlineCents: number } | null {
  const { rateCents, taxRatePercent, checkIn, checkInTime, checkOut, checkOutTime } = input;
  if (!checkIn || !checkOut || !checkInTime || !checkOutTime || !(rateCents > 0)) return null;
  const range = directDays(`${checkIn} ${convertTo24Hour(checkInTime)}:00`, `${checkOut} ${convertTo24Hour(checkOutTime)}:00`);
  if (!range.ok) return null;
  const q = computeDirectQuote({ rateCents, days: range.days, taxRatePercent });
  return { days: range.days, onlineCents: q.chargeCents };
}

/** "+$5–$10/day" (or "+$5/day" for one size); null when the lot has none. R10's pre-Reserve line. */
export function surchargeRangeText(surcharges: readonly { dailyRateCents: number }[] | undefined): string | null {
  if (!surcharges || surcharges.length === 0) return null;
  const rates = surcharges.map((s) => s.dailyRateCents);
  const lo = Math.min(...rates);
  const hi = Math.max(...rates);
  const fmt = (c: number) => (c % 100 === 0 ? `$${c / 100}` : `$${(c / 100).toFixed(2)}`);
  return lo === hi ? `+${fmt(lo)}/day` : `+${fmt(lo)}–${fmt(hi)}/day`;
}

export const formatCents = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

export interface VehicleChoice {
  code: string;
  /** Where the customer made the choice (bookings.vehicle_size_source). */
  source: VehicleSizeSource;
  /**
   * Set when nobody chose: the lot had no sizes, so "none" was the only answer.
   * If the lot later turns out to have sizes, an automatic choice is dropped and
   * the customer is asked — never carried forward as if they had picked it.
   */
  auto?: true;
}

/**
 * The checkout's starting vehicle choice (plan §1.5 + R8). Validated against the
 * lot's sizes from the SERVER's checkout response, never trusted from the URL:
 *   - not a direct checkout (no terms)               → null (no question asked)
 *   - the lot has no surcharges                      → "none" (nothing to choose)
 *   - the URL names "none" or one of the lot's codes → that choice
 *   - missing / unknown (old link, recovery email, a size the lot removed)
 *                                                    → null: the selector opens
 *     expanded and Pay waits for an explicit pick. Never a silent "none".
 */
export function initialVehicleChoice(
  terms: { vehicleSurcharges: readonly { code: string }[] } | null | undefined,
  requestedSize: string | null,
  requestedSource: string | null
): VehicleChoice | null {
  if (!terms) return null;
  if (terms.vehicleSurcharges.length === 0) return { code: NO_OVERSIZED_VEHICLE, source: "checkout", auto: true };
  if (!requestedSize) return null;
  const known = requestedSize === NO_OVERSIZED_VEHICLE || terms.vehicleSurcharges.some((s) => s.code === requestedSize);
  if (!known) return null;
  return { code: requestedSize, source: requestedSource === "checkout" ? "checkout" : "modal" };
}

/**
 * The choice to keep once the PaymentIntent POST returns the lot's CURRENT terms
 * (they can differ from the checkout GET's if the lot was edited in between):
 *   - the lot now has no sizes           → automatic "none" (nothing to choose;
 *                                          Pay must not wait on a selector that
 *                                          is not shown)
 *   - an automatic choice, sizes now exist → null: ask
 *   - a size the lot no longer offers     → null: ask again
 *   - otherwise                           → unchanged
 */
export function refreshVehicleChoice(
  prev: VehicleChoice | null,
  terms: { vehicleSurcharges: readonly { code: string }[] }
): VehicleChoice | null {
  if (terms.vehicleSurcharges.length === 0) {
    return prev && !prev.auto && prev.code === NO_OVERSIZED_VEHICLE
      ? prev
      : { code: NO_OVERSIZED_VEHICLE, source: "checkout", auto: true };
  }
  if (!prev || prev.auto) return null;
  const known = prev.code === NO_OVERSIZED_VEHICLE || terms.vehicleSurcharges.some((s) => s.code === prev.code);
  return known ? prev : null;
}
