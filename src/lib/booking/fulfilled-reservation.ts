import type { ReslabReservation } from "@/lib/reslab/client";
import { validCoords } from "@/lib/attribution/airport";
import type { LotSnapshotV2 } from "@/lib/direct/lot-snapshot";
import type { DirectMetadataMoney } from "@/lib/direct/metadata-money";

/**
 * The reservation fulfilment has just created (or adopted), in a shape that
 * does not depend on where it came from (direct-lots Phase 4a plan,
 * notes/2026-10-09-direct-lots-phase4a-plan.md §3 + §6). Phase 4b adds the
 * second arm — Triply's own direct lots — built from the lot snapshot and the
 * PaymentIntent's metadata (`fromSnapshot`).
 *
 * This is the FULFILMENT model (persist, Park Guard, emails, the create
 * response). It is not the confirmation page's read model.
 */
export type FulfilledReservation = ReslabFulfilledReservation | DirectFulfilledReservation;

/** Location fields every arm carries (Park Guard, emails and the create response read these). */
interface FulfilledLocation {
  /** The ResLab location id; null for a direct lot. */
  reslabLocationId: number | null | undefined;
  /** The CMS lot id for a direct lot; always null for ResLab. Kept apart
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
  /** Raw (HTML from ResLab) — callers strip it. A direct lot's plain text is
   *  pre-escaped by fromSnapshot so the callers' stripHtml returns it intact. */
  shuttleDetailsHtml: string | null | undefined;
  specialConditionsHtml: string | null | undefined;
}

/**
 * ResLab arm. Values are carried RAW: no coercion, no defaults. `??` / `||`
 * fallbacks stay in the callers, exactly where they were, so every number,
 * string and absent key comes out as it did before this type existed.
 */
export interface ReslabFulfilledReservation {
  /** The confirmation number ("RTL…"). */
  number: string;
  source: "reslab";
  cancelled: boolean;
  /** ResLab's history row id; the response falls back to `number` when falsy. */
  historyId: number | null;
  /**
   * DOLLARS, exactly as the source returned them — never cents, never coerced.
   * `dueAtLocation` is the STORED / settlement value (`bookings.due_at_location`).
   */
  money: {
    subtotal: number | null;
    taxTotal: number | null;
    feesTotal: number | null;
    grandTotal: number | null;
    dueAtLocation: number | null;
    /** ResLab's long-stay discount (`history[0].long_term_discount`), already
     *  inside its grand_total. Display only — the cost breakdown in the emails
     *  reads it; nothing persists it. */
    longTermDiscount: number | null;
  };
  /** null when the source sent no date list. */
  dates: { fromDate: string | undefined; toDate: string | undefined }[] | null;
  /** null when the source sent no location. Fields the create response copies
   *  verbatim keep `undefined` vs `null` as received (JSON drops one, keeps the other). */
  location: (FulfilledLocation & { directLotId: null }) | null;
}

/**
 * Direct arm (4b plan §3.2). Money is NON-NULL and comes only from the
 * PaymentIntent's metadata cents — never a payload fallback. `dueAtLocation`
 * is the stored 0: the online charge covers all of the parking. An
 * oversized-vehicle surcharge is collected AT THE LOT and lives only in the
 * separate, display-only `atLot` (R1) — never in a money column, a total or
 * `dueNow`.
 */
export interface DirectFulfilledReservation {
  /** Triply's own number ("TRP-…"). */
  number: string;
  source: "direct";
  cancelled: false;
  historyId: null;
  money: {
    subtotal: number;
    taxTotal: number;
    feesTotal: 0;
    grandTotal: number;
    dueAtLocation: 0;
    /** The service fee as charged (a direct row never falls back to the payload). */
    serviceFee: number;
    /** The promo discount as charged (0 = none). */
    discount: number;
    /** What the card was charged, in dollars — `chargeCents / 100`, i.e. `pi.amount`.
     *  Carried from the checked cents, never re-added from the parts. */
    chargedOnline: number;
  };
  /** Display only — what the lot collects at drop-off for an oversized vehicle. */
  atLot: {
    vehicleSize: string;
    vehicleSizeLabel: string;
    surchargeCents: number;
    surchargeTaxCents: number;
  };
  dates: { fromDate: string; toDate: string }[];
  location: FulfilledLocation & { reslabLocationId: null; directLotId: number; timezone: string };
  /** The customer-safe lot snapshot the booking was staged with. */
  snapshot: LotSnapshotV2;
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
export function fromReslab(r: ReslabReservation): ReslabFulfilledReservation {
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
      longTermDiscount: h?.long_term_discount ?? null,
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

/** Escape plain text so `stripHtml` (which decodes entities and drops tags)
 *  returns it unchanged — a lot note like "Cars & trucks <6ft" must survive. */
function asHtmlText(text: string | null): string | null {
  if (text === null) return null;
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The lot's customer notes as one block, in the order the lot page shows them. */
function snapshotNotes(snapshot: LotSnapshotV2): string | null {
  const i = snapshot.bookingInstructions;
  const parts = [i.importantNotes, i.whenYouArrive, i.beforeArrival, i.whenYouReturn]
    .map((p) => p?.trim())
    .filter((p): p is string => !!p);
  return parts.length > 0 ? parts.join("\n") : null;
}

export interface FromSnapshotInput {
  number: string;
  /** The CMS lot id, already validated (and checked against the snapshot) by directPayloadFromRow. */
  directLotId: number;
  snapshot: LotSnapshotV2;
  money: DirectMetadataMoney;
  fromDate: string;
  toDate: string;
  vehicleSize: string;
  vehicleSizeLabel: string;
  vehicleSurchargeCents: number;
  vehicleSurchargeTaxCents: number;
}

/**
 * Staged direct booking → FulfilledReservation. No network: a resume cannot
 * fail transiently (B4). TOTAL for validated inputs — the caller has already
 * parsed the snapshot (v2) and the metadata money.
 */
export function fromSnapshot(input: FromSnapshotInput): DirectFulfilledReservation {
  const { snapshot: s, money: m } = input;
  return {
    number: input.number,
    source: "direct",
    cancelled: false,
    historyId: null,
    money: {
      subtotal: m.subtotalCents / 100,
      taxTotal: m.taxCents / 100,
      feesTotal: 0,
      grandTotal: m.grandTotalCents / 100,
      dueAtLocation: 0,
      serviceFee: m.serviceFeeCents / 100,
      discount: m.discountCents / 100,
      chargedOnline: m.chargeCents / 100,
    },
    atLot: {
      vehicleSize: input.vehicleSize,
      vehicleSizeLabel: input.vehicleSizeLabel,
      surchargeCents: input.vehicleSurchargeCents,
      surchargeTaxCents: input.vehicleSurchargeTaxCents,
    },
    dates: [{ fromDate: input.fromDate, toDate: input.toDate }],
    location: {
      reslabLocationId: null,
      directLotId: input.directLotId,
      name: s.name,
      address: s.address.street,
      city: s.address.city,
      stateCode: s.address.state,
      zip: s.address.zip,
      phone: s.shuttlePhone,
      timezone: s.timezone,
      coords: { lat: s.coordinates.lat, lng: s.coordinates.lng },
      shuttleDetailsHtml: asHtmlText(s.shuttleDetails),
      specialConditionsHtml: asHtmlText(snapshotNotes(s)),
    },
    snapshot: s,
  };
}
