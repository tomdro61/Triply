import { z } from "zod";
import { directDays } from "./pricing";
import { NO_OVERSIZED_VEHICLE } from "./vehicle-size";

/**
 * The confirmation-page view of a DIRECT booking (direct-lots plan 4b §2.2 /
 * B12), built from the `bookings` row + its `lot_snapshot` ONLY — a direct
 * booking has no vendor record, so `GET /api/reservations/[id]` must never call
 * Reservations Lab for one (a TRP- number 404s there).
 *
 * Same response shape as the ResLab branch of that route, plus:
 *   inventorySource  "direct"
 *   airportCode / timezone  from the snapshot (the page's GA4 airport + lot memo)
 *   atLotEstimate    the oversized-vehicle surcharge PAID AT THE LOT — a
 *                    SEPARATE display value, never folded into grandTotal /
 *                    dueNow / dueAtLocation (dueAtLocation stays the stored 0).
 *
 * Every field is read strictly: a row or snapshot that does not parse is an
 * integrity error (the caller returns 500 + Sentry), never a guessed value.
 */

/**
 * The customer-facing subset of the lot snapshot. Deliberately NOT
 * `lotSnapshotSchema` (which is `.strict()` and pinned to one version): this
 * reader accepts v1 and v2 (v2 = v1 without `notificationEmails`) and strips
 * every key it does not display, so partner/contact data can never ride into
 * the API response even if a snapshot carried it.
 */
const snapshotDisplaySchema = z.object({
  v: z.union([z.literal(1), z.literal(2)]),
  directLotId: z.string().min(1),
  name: z.string().min(1),
  airportCode: z.string().regex(/^[A-Z]{3}$/),
  timezone: z.string().min(1),
  address: z.object({
    street: z.string().min(1),
    city: z.string().min(1),
    state: z.string().regex(/^[A-Z]{2}$/),
    zip: z.string().min(1),
  }),
  coordinates: z.object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
  }),
  shuttleDetails: z.string().nullable(),
  shuttlePhone: z.string().nullable(),
  bookingInstructions: z.object({
    beforeArrival: z.string().nullable(),
    whenYouArrive: z.string().nullable(),
    importantNotes: z.string().nullable(),
    whenYouReturn: z.string().nullable(),
    gettingToAirport: z.string().nullable(),
  }),
});

/**
 * A non-negative NUMERIC column: PostgREST sends a string, a fake may send a
 * number. Never coerced from null/garbage, and a negative amount is refused
 * (no money column on a direct booking can legitimately be below zero).
 */
const moneyColumn = z.union([
  z.number().nonnegative(), // zod 4 rejects NaN / ±Infinity by default
  z.string().regex(/^\d+(\.\d+)?$/).transform(Number),
]);

const centsColumn = z.number().int().min(0);

/** Every value the bookings.status CHECK allows (migrations 001 + 003). */
const BOOKING_STATUSES = ["confirmed", "completed", "disputed", "cancelled", "refunded", "payment_failed"] as const;
type BookingStatus = (typeof BOOKING_STATUSES)[number];

const isBookingStatus = (s: string): s is BookingStatus =>
  (BOOKING_STATUSES as readonly string[]).includes(s);

/**
 * The confirmation page's status vocabulary (the same one the ResLab branch
 * reports). An allow-list: a status this view does not know how to present —
 * `payment_failed` (no money was taken, there is nothing to confirm) — is
 * `null`, which the builder turns into an integrity error, never "confirmed".
 */
function displayStatus(status: BookingStatus): "confirmed" | "cancelled" | null {
  switch (status) {
    case "confirmed":
    case "completed":
    case "disputed":
      return "confirmed";
    case "cancelled":
    case "refunded":
      return "cancelled";
    case "payment_failed":
      return null;
    default: {
      const unreachable: never = status;
      return unreachable;
    }
  }
}

const directRowSchema = z.object({
  inventory_source: z.literal("direct"),
  status: z.string().min(1),
  direct_lot_id: z.string().min(1),
  lot_snapshot: z.unknown(),
  subtotal: moneyColumn,
  tax_total: moneyColumn,
  fees_total: moneyColumn,
  grand_total: moneyColumn,
  // NULL = no promo on this booking (the column is nullable by design, 016).
  discount_amount: moneyColumn.nullable(),
  due_at_location: moneyColumn,
  // Part of the online charge on every direct booking: a NULL / garbled fee
  // is an integrity error, never a silent $0 (which would understate the
  // "Total Paid" the customer sees).
  triply_service_fee: moneyColumn,
  // NULL = no Park Guard. When set, protection_plan_price must be positive
  // (checked in the builder); when not set, the price is ignored (reconcile).
  protection_plan: z.string().min(1).nullable(),
  protection_plan_price: moneyColumn.nullable(),
  vehicle_size: z.string().min(1),
  vehicle_size_label: z.string().min(1),
  vehicle_surcharge_cents: centsColumn,
  vehicle_surcharge_tax_cents: centsColumn,
  vehicle_info: z.unknown(),
  customers: z.object({
    first_name: z.string().nullable(),
    last_name: z.string().nullable(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
  }),
});

export interface AtLotEstimateView {
  vehicleSize: string;
  vehicleSizeLabel: string;
  /** Dollars. Paid at the lot at drop-off; never charged online. */
  surcharge: number;
  surchargeTax: number;
  total: number;
}

export interface DirectReservationView {
  id: string;
  reservationNumber: string;
  inventorySource: "direct";
  status: "confirmed" | "cancelled";
  grandTotal: number;
  subtotal: number;
  taxTotal: number;
  feesTotal: number;
  serviceFee: number;
  protectionPlan: string | null;
  protectionPlanPrice: number;
  pgIdentifier: string | null;
  pgSyncStatus: string | null;
  /** The online charge: grand_total + fee + premium − discount − dueAtLocation (plan R1). */
  dueNow: number;
  /** The stored `due_at_location` (0 for a direct row). Never includes the at-lot vehicle estimate. */
  dueAtLocation: number;
  atLotEstimate: AtLotEstimateView | null;
  airportCode: string;
  timezone: string;
  customer: { firstName: string; lastName: string; email: string; phone: string };
  items: Array<{
    type: "parking";
    fromDate: string;
    toDate: string;
    numberOfDays: number;
    numberOfSpots: number;
  }>;
  location: {
    id: string;
    name: string;
    address: string;
    city: string;
    state: string;
    zipCode: string;
    phone: string;
    latitude: number;
    longitude: number;
    shuttleDetails?: string;
    specialConditions?: string;
  };
  vehicleInfo: unknown;
  extraFields: Record<string, string>;
}

export type DirectReservationResult =
  | { ok: true; reservation: DirectReservationView }
  | { ok: false; detail: string };

/**
 * Values the route has already resolved for both sources (Park Guard sync
 * state, literal wall-clock times). The money — service fee and Park Guard
 * premium — is deliberately NOT here: the direct view parses it from the row
 * strictly, never the route's lenient ResLab-path coercion.
 */
export interface DirectReservationCommon {
  pgIdentifier: string | null;
  pgSyncStatus: string | null;
  /** "YYYY-MM-DD HH:mm:ss" airport-local, exactly as stored. null = missing (an error for a direct row). */
  fromDate: string | null;
  toDate: string | null;
}

const toCents = (dollars: number): number => Math.round(dollars * 100);
const fromCents = (cents: number): number => cents / 100;

/**
 * The at-lot estimate from the row's vehicle_* columns (migration 036):
 * size "none" ⇔ 0 + 0 → null (nothing to pay at the lot); any other size must
 * carry a positive surcharge. A disagreement is an integrity error, not a 0.
 */
export function atLotEstimateFromRow(row: {
  vehicle_size: string;
  vehicle_size_label: string;
  vehicle_surcharge_cents: number;
  vehicle_surcharge_tax_cents: number;
}): { ok: true; estimate: AtLotEstimateView | null } | { ok: false; detail: string } {
  const { vehicle_size, vehicle_size_label, vehicle_surcharge_cents, vehicle_surcharge_tax_cents } = row;
  if (vehicle_size === NO_OVERSIZED_VEHICLE) {
    if (vehicle_surcharge_cents !== 0 || vehicle_surcharge_tax_cents !== 0) {
      return { ok: false, detail: `vehicle_size "none" with a surcharge (${vehicle_surcharge_cents}+${vehicle_surcharge_tax_cents} cents)` };
    }
    return { ok: true, estimate: null };
  }
  if (vehicle_surcharge_cents <= 0) {
    return { ok: false, detail: `vehicle_size "${vehicle_size}" with no surcharge` };
  }
  return {
    ok: true,
    estimate: {
      vehicleSize: vehicle_size,
      vehicleSizeLabel: vehicle_size_label,
      surcharge: fromCents(vehicle_surcharge_cents),
      surchargeTax: fromCents(vehicle_surcharge_tax_cents),
      total: fromCents(vehicle_surcharge_cents + vehicle_surcharge_tax_cents),
    },
  };
}

export function buildDirectReservation(
  reservationNumber: string,
  rawRow: unknown,
  common: DirectReservationCommon
): DirectReservationResult {
  const parsedRow = directRowSchema.safeParse(rawRow);
  if (!parsedRow.success) {
    return { ok: false, detail: `direct booking row did not parse: ${parsedRow.error.issues.map((i) => i.path.join(".")).join(", ")}` };
  }
  const row = parsedRow.data;

  const parsedSnapshot = snapshotDisplaySchema.safeParse(row.lot_snapshot);
  if (!parsedSnapshot.success) {
    return { ok: false, detail: `lot_snapshot did not parse: ${parsedSnapshot.error.issues.map((i) => i.path.join(".")).join(", ")}` };
  }
  const snap = parsedSnapshot.data;
  if (snap.directLotId !== row.direct_lot_id) {
    return { ok: false, detail: `lot_snapshot.directLotId ${snap.directLotId} != direct_lot_id ${row.direct_lot_id}` };
  }

  if (!isBookingStatus(row.status)) {
    return { ok: false, detail: `unexpected status "${row.status}"` };
  }
  const status = displayStatus(row.status);
  if (status === null) {
    return { ok: false, detail: `unexpected status "${row.status}" for a confirmation view` };
  }

  // Park Guard premium: only when a plan is set (the same rule reconcile
  // applies), and a set plan must carry a positive premium — "Protection
  // Active … $0.00" or a total missing the premium is an integrity error.
  let protectionPlanPrice = 0;
  if (row.protection_plan !== null) {
    if (row.protection_plan_price === null || row.protection_plan_price <= 0) {
      return {
        ok: false,
        detail: `protection_plan "${row.protection_plan}" with protection_plan_price ${String(row.protection_plan_price)}`,
      };
    }
    protectionPlanPrice = row.protection_plan_price;
  }

  if (!common.fromDate || !common.toDate) {
    return { ok: false, detail: "check_in / check_out missing" };
  }
  // Billed days from the literal wall-clock strings — the same rule checkout
  // charged with (ceil(hours/24)); no timezone conversion.
  const days = directDays(common.fromDate, common.toDate);
  if (!days.ok) {
    return { ok: false, detail: `check_in/check_out do not price: ${days.reason}` };
  }

  const estimate = atLotEstimateFromRow(row);
  if (!estimate.ok) return { ok: false, detail: estimate.detail };

  const grandCents =
    toCents(row.grand_total) + toCents(row.triply_service_fee) + toCents(protectionPlanPrice);
  const discountCents = toCents(row.discount_amount ?? 0);
  const dueAtLocationCents = toCents(row.due_at_location);

  const instructions = snap.bookingInstructions;
  const specialConditions = [instructions.importantNotes, instructions.whenYouArrive]
    .filter((s): s is string => !!s)
    .join("\n\n");

  return {
    ok: true,
    reservation: {
      id: reservationNumber,
      reservationNumber,
      inventorySource: "direct",
      // Same vocabulary the ResLab branch reports: cancelled or confirmed.
      status,
      grandTotal: fromCents(grandCents),
      subtotal: row.subtotal,
      taxTotal: row.tax_total,
      feesTotal: row.fees_total,
      serviceFee: row.triply_service_fee,
      protectionPlan: row.protection_plan,
      protectionPlanPrice,
      pgIdentifier: common.pgIdentifier,
      pgSyncStatus: common.pgSyncStatus,
      dueNow: fromCents(grandCents - discountCents - dueAtLocationCents),
      dueAtLocation: fromCents(dueAtLocationCents),
      atLotEstimate: estimate.estimate,
      airportCode: snap.airportCode,
      timezone: snap.timezone,
      customer: {
        firstName: row.customers.first_name ?? "",
        lastName: row.customers.last_name ?? "",
        email: row.customers.email ?? "",
        phone: row.customers.phone ?? "",
      },
      items: [
        {
          type: "parking",
          fromDate: common.fromDate,
          toDate: common.toDate,
          numberOfDays: days.days,
          numberOfSpots: 1,
        },
      ],
      location: {
        id: row.direct_lot_id,
        name: snap.name,
        address: snap.address.street,
        city: snap.address.city,
        state: snap.address.state,
        zipCode: snap.address.zip,
        phone: snap.shuttlePhone ?? "",
        latitude: snap.coordinates.lat,
        longitude: snap.coordinates.lng,
        ...(snap.shuttleDetails ? { shuttleDetails: snap.shuttleDetails } : {}),
        ...(specialConditions ? { specialConditions } : {}),
      },
      vehicleInfo: row.vehicle_info ?? null,
      extraFields: {},
    },
  };
}
