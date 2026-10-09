import { calculateServiceFee } from "@/lib/utils/service-fee";

/**
 * Pricing for DIRECT lots (Triply-owned inventory, no Reservations Lab).
 * Plan: notes/2026-10-02-direct-lots-plan-v1.md D4 as amended by review B8.
 *
 * Everything is INTEGER CENTS. Column semantics are pinned to what every
 * existing reader of a booking row already assumes for ResLab rows:
 *   subtotal      = days × rate                      (parking only)
 *   taxTotal      = round(subtotal × taxRatePercent)  (on the pre-discount subtotal)
 *   feesTotal     = 0                                 (no lot facility fees)
 *   grandTotal    = subtotal + taxTotal               (EXCLUDES the service fee and Park Guard)
 *   discount      = round(subtotal × discountPercent) (same rule as /api/checkout/lot)
 *   serviceFee    = calculateServiceFee(subtotal)     (shared helper, dollars→cents)
 *   dueAtLocation = 0                                 (paid in full online, D4)
 * The PaymentIntent amount is grandTotal − discount + serviceFee (+ the Park
 * Guard premium, added by checkout exactly as for ResLab lots).
 */

/** Wall-clock booking time as the customer picked it: "YYYY-MM-DD HH:MM:SS" or "YYYY-MM-DD HH:MM". */
const WALL_CLOCK_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * Minutes on a naive clock for a literal airport-local timestamp. Deliberately
 * NOT a timezone conversion (CLAUDE.md: booking times are literal strings):
 * both ends of a stay are in the same airport's clock, so their difference is
 * what the customer sees on their own watch. Date.UTC is used purely as
 * calendar arithmetic. A DST change inside the stay shifts the true elapsed
 * time by an hour; the day count here follows the WALL CLOCK (pinned by a
 * test). Whether ResLab does the same across a DST boundary is unverified.
 */
export function wallClockMinutes(value: string): number | null {
  const m = WALL_CLOCK_RE.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, sec] = m.map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || (Number.isFinite(sec) && sec > 59)) return null;
  const ms = Date.UTC(y, mo - 1, d, h, mi); // seconds never change a billed-day count
  // Reject calendar roll-over (e.g. 2026-02-30 → March 2).
  const probe = new Date(ms);
  if (probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null;
  return ms / 60_000;
}

export type DirectDaysResult =
  | { ok: true; days: number; hours: number }
  | { ok: false; reason: "invalid_datetime" | "checkout_not_after_checkin" };

/**
 * Billed days = max(1, ceil(hours / 24)), i.e. 24-hour periods from drop-off
 * to pickup. This is what Reservations Lab already does to our customers
 * (RTL856901: Oct 2 11:30 → Oct 5 07:00 = 67.5 h = 3 days; → 19:00 = 79.5 h =
 * 4 days), so a direct lot and a ResLab lot price the same stay the same way.
 * A reversed or zero-length range is an error, never 0 or 1 day.
 */
export function directDays(checkIn: string, checkOut: string): DirectDaysResult {
  const a = wallClockMinutes(checkIn);
  const b = wallClockMinutes(checkOut);
  if (a == null || b == null) return { ok: false, reason: "invalid_datetime" };
  if (b <= a) return { ok: false, reason: "checkout_not_after_checkin" };
  const hours = (b - a) / 60;
  return { ok: true, days: Math.max(1, Math.ceil(hours / 24)), hours };
}

export interface DirectQuoteInput {
  /** Lot's base daily rate, in cents. */
  rateCents: number;
  /** Billed days from directDays(). */
  days: number;
  /** Lot's tax rate, e.g. 18.375 for 18.375 %. */
  taxRatePercent: number;
  /** Promo discount percentage of the subtotal, e.g. 10. */
  discountPercent?: number;
}

export interface DirectQuote {
  subtotalCents: number;
  taxTotalCents: number;
  feesTotalCents: 0;
  /** subtotal + tax — the stored `grand_total`, excluding service fee / Park Guard. */
  grandTotalCents: number;
  discountCents: number;
  serviceFeeCents: number;
  dueAtLocationCents: 0;
  /** What the card is charged BEFORE any Park Guard premium. */
  chargeCents: number;
}

const isNonNegInt = (n: number) => Number.isInteger(n) && n >= 0;

/** Pure, deterministic quote. Throws on malformed input — callers validate first. */
export function computeDirectQuote(input: DirectQuoteInput): DirectQuote {
  const { rateCents, days, taxRatePercent, discountPercent = 0 } = input;
  if (!isNonNegInt(rateCents) || rateCents === 0) throw new Error(`direct quote: rateCents must be a positive integer (got ${rateCents})`);
  if (!Number.isInteger(days) || days < 1) throw new Error(`direct quote: days must be >= 1 (got ${days})`);
  if (!(taxRatePercent >= 0 && taxRatePercent <= 100)) throw new Error(`direct quote: taxRatePercent out of range (${taxRatePercent})`);
  if (!(discountPercent >= 0 && discountPercent <= 100)) throw new Error(`direct quote: discountPercent out of range (${discountPercent})`);

  const subtotalCents = rateCents * days;
  const taxTotalCents = Math.round((subtotalCents * taxRatePercent) / 100);
  const grandTotalCents = subtotalCents + taxTotalCents;
  const discountCents = Math.min(grandTotalCents, Math.round((subtotalCents * discountPercent) / 100));
  // The shared helper works in dollars (max($5.95, 6 %) of the parking base).
  const serviceFeeCents = Math.round(calculateServiceFee(subtotalCents / 100) * 100);
  const chargeCents = grandTotalCents - discountCents + serviceFeeCents;

  return {
    subtotalCents,
    taxTotalCents,
    feesTotalCents: 0,
    grandTotalCents,
    discountCents,
    serviceFeeCents,
    dueAtLocationCents: 0,
    chargeCents,
  };
}

/** Dollars from cents, for the places that still speak dollars (emails, admin). */
export const centsToDollars = (cents: number): number => Math.round(cents) / 100;

export interface VehicleSurchargeQuote {
  /** days × dailyRate, before tax. */
  surchargeCents: number;
  /** Tax on the surcharge, at the lot's tax rate. */
  surchargeTaxCents: number;
  /** What the lot collects at drop-off: surcharge + its tax. An ESTIMATE — the lot sizes the vehicle at the gate. */
  atLotCents: number;
}

/**
 * The oversized-vehicle surcharge, PAID AT THE LOT (plan
 * notes/2026-10-09-direct-lots-vehicle-surcharge-plan.md §1.3). Billed on the
 * SAME days as the parking (`directDays`), taxed at the lot's rate, rounded
 * the same way as the parking tax. `dailyRateCents` 0 = "No oversized vehicle".
 * Never part of any online charge or money column.
 */
export function computeVehicleSurcharge(input: { days: number; dailyRateCents: number; taxRatePercent: number }): VehicleSurchargeQuote {
  const { days, dailyRateCents, taxRatePercent } = input;
  if (!Number.isInteger(days) || days < 1) throw new Error(`vehicle surcharge: days must be >= 1 (got ${days})`);
  if (!isNonNegInt(dailyRateCents)) throw new Error(`vehicle surcharge: dailyRateCents must be a non-negative integer (got ${dailyRateCents})`);
  if (!(taxRatePercent >= 0 && taxRatePercent <= 100)) throw new Error(`vehicle surcharge: taxRatePercent out of range (${taxRatePercent})`);
  const surchargeCents = dailyRateCents * days;
  const surchargeTaxCents = Math.round((surchargeCents * taxRatePercent) / 100);
  return { surchargeCents, surchargeTaxCents, atLotCents: surchargeCents + surchargeTaxCents };
}
