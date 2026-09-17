/**
 * Resolve a booking's airport server-side from data already in hand.
 *
 * Why not the client: checkout-form.tsx derives `airportCode` from the lot id
 * ("reslab-416" → "RESLAB"), which is what 297 of 298 bookings carry today.
 *
 * Why not the shared ResLab location list: its cache is per-lambda and cold in
 * the fulfilment bundles, so reading it at fulfil would run a 54-page sweep
 * AFTER the card is captured. The reservation response already embeds the
 * lot's coordinates — zero calls. This module must never import from
 * @/lib/reslab/search or @/lib/reslab/get-lot (a test asserts it).
 *
 * Rules, in order:
 *   1. The airport the visitor actually searched/viewed (cookie `apt`), when
 *      the lot is within CONTEXT_MAX_MILES of it — resolves multi-airport
 *      metros (JFK/LGA/EWR, DCA/IAD/BWI…) where nearest-wins mislabels.
 *   2. Else the nearest production airport within NEAREST_MAX_MILES.
 *   3. Else null. Never a guess — including when `apt` is known but the lot's
 *      coordinates are not: an unverifiable context is not evidence.
 */

import { productionAirports, type Airport } from "@/config/airports";
import { calculateDistance } from "@/lib/utils/geo";

export const CONTEXT_MAX_MILES = 40;
/** The search radius is ~9.3 mi (15 km); 25 leaves margin for hotel lots. */
export const NEAREST_MAX_MILES = 25;

export function validCoords(lat: unknown, lng: unknown): { lat: number; lng: number } | null {
  const la = typeof lat === "number" ? lat : parseFloat(String(lat ?? ""));
  const ln = typeof lng === "number" ? lng : parseFloat(String(lng ?? ""));
  if (!Number.isFinite(la) || !Number.isFinite(ln)) return null;
  if (la === 0 && ln === 0) return null;
  if (la < -90 || la > 90 || ln < -180 || ln > 180) return null;
  return { lat: la, lng: ln };
}

export interface ResolveAirportInput {
  /** From the attribution cookie (`apt`), if any. */
  contextAirport?: string | null;
  lat: unknown;
  lng: unknown;
  /** Injectable for tests; defaults to the production airport list. */
  airports?: readonly Airport[];
}

export function resolveAirportCode(input: ResolveAirportInput): string | null {
  const coords = validCoords(input.lat, input.lng);
  if (!coords) return null;
  const airports = input.airports ?? productionAirports;

  if (input.contextAirport) {
    const ctx = airports.find((a) => a.code === input.contextAirport!.toUpperCase());
    if (ctx) {
      const d = calculateDistance(coords.lat, coords.lng, ctx.latitude, ctx.longitude, false);
      if (d <= CONTEXT_MAX_MILES) return ctx.code;
    }
  }

  let best: { code: string; d: number } | null = null;
  for (const a of airports) {
    const d = calculateDistance(coords.lat, coords.lng, a.latitude, a.longitude, false);
    if (d <= NEAREST_MAX_MILES && (!best || d < best.d)) best = { code: a.code, d };
  }
  return best?.code ?? null;
}
