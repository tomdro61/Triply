import type { ReslabReservation } from "@/lib/reslab/client";
import { validCoords } from "@/lib/attribution/airport";

/**
 * The reservation fulfilment has just created (or adopted), in a shape that
 * does not depend on where it came from (direct-lots Phase 4a plan,
 * notes/2026-10-09-direct-lots-phase4a-plan.md §3 + §6). Phase 4b adds a
 * second source — Triply's own direct lots — built from the lot snapshot.
 *
 * This is the FULFILMENT model (persist, Park Guard, emails, the create
 * response). It is not the confirmation page's read model.
 *
 * Values are carried RAW: no coercion, no defaults. `??` / `||` fallbacks stay
 * in the callers, exactly where they were, so every number, string and absent
 * key comes out as it did before this type existed.
 */
export interface FulfilledReservation {
  /** The confirmation number (ResLab "RTL…"; direct lots "TRP-…" from 4b). */
  number: string;
  source: "reslab";
  cancelled: boolean;
  /** ResLab's history row id; the response falls back to `number` when falsy. */
  historyId: number | null;
  /**
   * DOLLARS, exactly as the source returned them — never cents, never coerced.
   * `dueAtLocation` is the STORED / settlement value (`bookings.due_at_location`);
   * a direct lot's at-lot vehicle surcharge is display-only and never goes here.
   */
  money: {
    subtotal: number | null;
    taxTotal: number | null;
    feesTotal: number | null;
    grandTotal: number | null;
    dueAtLocation: number | null;
  };
  /** null when the source sent no date list. */
  dates: { fromDate: string | undefined; toDate: string | undefined }[] | null;
  /** null when the source sent no location. Fields the create response copies
   *  verbatim keep `undefined` vs `null` as received (JSON drops one, keeps the other). */
  location: {
    /** The ResLab location id; null for a direct lot (4b). */
    reslabLocationId: number | null | undefined;
    /** The CMS lot id for a direct lot (4b); always null for ResLab. Kept apart
     *  from reslabLocationId because the id spaces overlap (CMS lot 1 vs ResLab 1). */
    directLotId: number | null;
    name: string | null | undefined;
    address: string | null | undefined;
    city: string | null | undefined;
    stateCode: string | undefined;
    zip: string | null | undefined;
    phone: string | null | undefined;
    /** IANA zone, e.g. "America/New_York". */
    timezone: string | null;
    coords: { lat: number; lng: number } | null;
    /** Raw (HTML from ResLab) — callers strip it. */
    shuttleDetailsHtml: string | null | undefined;
    specialConditionsHtml: string | null | undefined;
  } | null;
}

/** validCoords stringifies its input, which throws for a JSON object whose
 *  `toString` isn't callable — so this one call is guarded. Every input that
 *  doesn't throw gives exactly validCoords' answer. */
function safeCoords(lat: unknown, lng: unknown): { lat: number; lng: number } | null {
  try {
    return validCoords(lat, lng);
  } catch {
    return null;
  }
}

/**
 * ResLab reservation → FulfilledReservation. TOTAL: it never throws, whatever
 * JSON ResLab sent (the body is cast, not validated). It runs on the money path
 * after the reservation number is recorded, and a throw there would strand a
 * live, unrecorded-in-bookings reservation.
 */
export function fromReslab(r: ReslabReservation): FulfilledReservation {
  const h = r?.history?.[0];
  const loc = h?.location;
  const dates = h?.dates;

  return {
    number: r?.reservation_number,
    source: "reslab",
    cancelled: !!r?.cancelled,
    historyId: h?.id ?? null,
    money: {
      subtotal: h?.subtotal ?? null,
      taxTotal: h?.total_tax ?? null,
      feesTotal: h?.total_fees ?? null,
      grandTotal: h?.grand_total ?? null,
      dueAtLocation: h?.due_at_location_total ?? null,
    },
    dates: Array.isArray(dates)
      ? dates.map((d) => ({ fromDate: d?.from_date, toDate: d?.to_date }))
      : null,
    location: loc
      ? {
          reslabLocationId: loc.id,
          directLotId: null,
          name: loc.name,
          address: loc.address,
          city: loc.city,
          stateCode: loc.state?.code,
          zip: loc.zip_code,
          phone: loc.phone,
          timezone: loc.timezone?.code ?? null,
          coords: safeCoords(loc.latitude, loc.longitude),
          shuttleDetailsHtml: loc.shuttle_info_details,
          specialConditionsHtml: loc.special_conditions,
        }
      : null,
  };
}
