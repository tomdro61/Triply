/**
 * The one mapping from a ResLab pricing response to a lot's availability state.
 *
 * Search results and the lot detail page both call the SAME ResLab endpoint
 * (getMinPrice, number_of_spots: 1, the same dates) and both render a
 * "Limited" tag when `availability === "limited"`. They used to derive that
 * state separately: search looked at `available_spots`, the lot page only at
 * `sold_out` — so the lot page had two states and its "Limited Spots" tag could
 * never fire. Scarcity showed while people compared and vanished where they
 * decided. One function, used by both, keeps them from drifting again.
 *
 * Truthful only: "limited" requires ResLab to have reported a real,
 * well-formed spot count under the threshold. A missing, null, non-integer or
 * negative count is NOT evidence of scarcity and reads as "available" — we
 * never invent urgency (the site removed fabricated testimonials for the same
 * reason).
 */

import type { UnifiedLot } from "@/types/lot";
import type { ReslabMinPriceResponse } from "./client";

export type LotAvailability = UnifiedLot["availability"];

/** Fewer spots than this (and not sold out) shows the "Limited" tag. */
export const LIMITED_SPOTS_THRESHOLD = 10;

/**
 * Only the two fields we read, typed as `unknown` because this is a trust
 * boundary: the declared ResLab types say number/boolean, but the payload is
 * unvalidated JSON and a null here must not become a "Limited" badge.
 */
export interface AvailabilitySignal {
  sold_out?: unknown;
  available_spots?: unknown;
}

export function deriveAvailability(
  reservation: ReslabMinPriceResponse["reservation"] | AvailabilitySignal | null | undefined,
): LotAvailability {
  if (!reservation) return "available";
  if (reservation.sold_out === true) return "unavailable";

  const spots = reservation.available_spots;
  if (
    typeof spots === "number" &&
    Number.isInteger(spots) &&
    spots >= 0 &&
    spots < LIMITED_SPOTS_THRESHOLD
  ) {
    return "limited";
  }
  return "available";
}
