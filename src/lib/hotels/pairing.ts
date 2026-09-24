/**
 * Which Triply parking lot travels with a hotel in a package (plan §1):
 * the CHEAPEST available lot at the airport that is
 *   - not blocked (searchParking already drops BLOCKED_RESLAB_LOCATION_IDS),
 *   - not due-at-location (the package is one prepaid charge; a pay-at-lot
 *     balance would put a second number next to the headline total), and
 *   - 100 % refundable on its parking policy (the package cancels as a whole
 *     under the parking 24 h gate — a lot that keeps a share would make the
 *     itemised refund preview lie).
 *
 * The paired lot travels as `locationId` in the payload and is NEVER
 * re-derived at fulfilment; this function runs at search time only.
 *
 * This is the ONLY hotels module allowed to import @/lib/reslab/search (its
 * types), and src/lib/booking/** must never transitively reach it — the
 * location list is a per-lambda cache whose cold build is a ~54-page sweep
 * that must not run after a card is captured (the Aug-16 outage class). The
 * import guard test enforces both.
 *
 * ResLab's `cancellation_policies[].percentage` is the share REFUNDED when
 * cancelling at least `number_of_days` before check-in (the
 * `/reservations/{n}/refund-percentage` endpoint returns the same figure);
 * the self-cancel launch verified 67/67 lots at 100 %.
 */

import type { UnifiedLot } from "@/types/lot";

export interface PairedLot {
  lot: UnifiedLot;
  /** What the customer pays online for the parking, cents (grand total; the lot is never due-at-location). */
  parkingOnlineCents: number;
  /** ResLab sub_total in cents — the promo and service-fee base (§2.3). */
  parkingSubtotalCents: number;
}

function isFullyRefundable(lot: UnifiedLot): boolean {
  const policies = lot.cancellationPolicies ?? [];
  return policies.length > 0 && policies.every((p) => p.percentage === 100);
}

function cents(amount: number | undefined): number | null {
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) return null;
  return Math.round(amount * 100);
}

/** Why a lot was passed over; surfaced in the route's diagnostics, never to customers. */
export type PairingRejection = "unavailable" | "due_at_location" | "not_fully_refundable" | "unpriced";

export function pickParkingLot(lots: UnifiedLot[]): { paired: PairedLot | null; rejected: Record<PairingRejection, number> } {
  const rejected: Record<PairingRejection, number> = {
    unavailable: 0,
    due_at_location: 0,
    not_fully_refundable: 0,
    unpriced: 0,
  };
  let best: PairedLot | null = null;
  for (const lot of lots) {
    if (lot.availability === "unavailable") {
      rejected.unavailable++;
      continue;
    }
    if (lot.dueAtLocation) {
      rejected.due_at_location++;
      continue;
    }
    if (!isFullyRefundable(lot)) {
      rejected.not_fully_refundable++;
      continue;
    }
    const online = cents(lot.pricing?.grandTotal);
    const subtotal = cents(lot.pricing?.subtotal);
    if (online === null || subtotal === null || online === 0) {
      rejected.unpriced++;
      continue;
    }
    if (best === null || online < best.parkingOnlineCents) {
      best = { lot, parkingOnlineCents: online, parkingSubtotalCents: subtotal };
    }
  }
  return { paired: best, rejected };
}
