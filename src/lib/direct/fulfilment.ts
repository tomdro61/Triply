import { z } from "zod";
import { reservationSchema } from "@/lib/validation/schemas";
import { checkInInstantMs } from "@/lib/cancellation/eligibility";
import { parseLotSnapshotV2, type LotSnapshotV2 } from "./lot-snapshot";
import { VEHICLE_SIZE_CODE_RE, VEHICLE_SIZE_SOURCES } from "./vehicle-size";

/**
 * Pure helpers the booking engine uses to fulfil a DIRECT-lot booking
 * (4b plan §3.2). The engine fulfils a direct booking ONLY from its claimed
 * pending row + the PaymentIntent (§9 H-A) — never from a client payload —
 * so this module is the boundary that validates that row.
 *
 * Must not import the lot store (A-42): fulfilment never re-reads the CMS (B9).
 */

const WALL_CLOCK = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

const directRowSchema = z.object({
  stripe_payment_intent_id: z.string().min(1),
  inventory_source: z.literal("direct"),
  direct_lot_id: z.string().regex(/^[1-9]\d{0,8}$/),
  lot_snapshot: z.unknown(),
  from_date: z.string().regex(WALL_CLOCK),
  to_date: z.string().regex(WALL_CLOCK),
  customer: reservationSchema.shape.customer,
  vehicle: reservationSchema.shape.vehicle,
  vehicle_size: z.string().regex(VEHICLE_SIZE_CODE_RE),
  vehicle_size_label: z.string().min(1).max(60),
  vehicle_surcharge_cents: z.number().int().min(0),
  vehicle_surcharge_tax_cents: z.number().int().min(0),
  vehicle_size_source: z.enum(VEHICLE_SIZE_SOURCES),
  user_id: z.string().nullable(),
});

/** Everything fulfilment needs for a direct booking, from the staged row only. */
export interface DirectBookingPayload {
  stripePaymentIntentId: string;
  directLotId: number;
  snapshot: LotSnapshotV2;
  fromDate: string;
  toDate: string;
  customer: z.infer<typeof reservationSchema.shape.customer>;
  vehicle: z.infer<typeof reservationSchema.shape.vehicle>;
  vehicleSize: string;
  vehicleSizeLabel: string;
  vehicleSurchargeCents: number;
  vehicleSurchargeTaxCents: number;
  vehicleSizeSource: (typeof VEHICLE_SIZE_SOURCES)[number];
  userId: string | null;
}

export type DirectPayloadResult = { ok: true; payload: DirectBookingPayload } | { ok: false; detail: string };

/**
 * Validate a claimed `pending_bookings` row as a direct booking. Never throws.
 * The lot snapshot must be v2 and name the same lot as the row.
 */
export function directPayloadFromRow(row: unknown): DirectPayloadResult {
  const parsed = directRowSchema.safeParse(row);
  if (!parsed.success) {
    return { ok: false, detail: parsed.error.issues.map((i) => i.path.join(".") || i.message).join(", ") };
  }
  const r = parsed.data;
  const snapshot = parseLotSnapshotV2(r.lot_snapshot);
  if (!snapshot) return { ok: false, detail: "lot_snapshot is not a valid v2 snapshot" };
  if (snapshot.directLotId !== r.direct_lot_id) {
    return { ok: false, detail: `lot_snapshot.directLotId ${snapshot.directLotId} != direct_lot_id ${r.direct_lot_id}` };
  }
  return {
    ok: true,
    payload: {
      stripePaymentIntentId: r.stripe_payment_intent_id,
      directLotId: Number(r.direct_lot_id),
      snapshot,
      fromDate: r.from_date,
      toDate: r.to_date,
      customer: r.customer,
      vehicle: r.vehicle,
      vehicleSize: r.vehicle_size,
      vehicleSizeLabel: r.vehicle_size_label,
      vehicleSurchargeCents: r.vehicle_surcharge_cents,
      vehicleSurchargeTaxCents: r.vehicle_surcharge_tax_cents,
      vehicleSizeSource: r.vehicle_size_source,
      userId: r.user_id,
    },
  };
}

/**
 * Cart IDENTITY for a direct booking (B6). Same purpose and the same livemode
 * prefix as the ResLab key; the lot is namespaced ("direct:1") and the trailing
 * "direct" stands where ResLab puts its parking-type id, so a direct key can
 * never equal a ResLab key (CMS lot 1 vs ResLab location 1).
 */
export function directCartKey(p: Pick<DirectBookingPayload, "customer" | "directLotId" | "fromDate" | "toDate">, livemode: boolean): string {
  return [
    livemode ? "live" : "test",
    p.customer.email.trim().toLowerCase(),
    `direct:${p.directLotId}`,
    p.fromDate,
    p.toDate,
    "direct",
  ].join("|");
}

export type DirectStaleness =
  /** Fulfil normally. */
  | { kind: "ok" }
  /** Check-in has passed but the stay has not: fulfil, and tell the lot URGENTLY. */
  | { kind: "late" }
  /** Never fulfil: release the payment. */
  | { kind: "release"; reason: string }
  /** The dates or the zone could not be read — an integrity error, not a business answer. */
  | { kind: "unknown"; detail: string };

/**
 * Staleness at fulfilment (4b plan §9 M-B; APB #7). The ONE time source is the
 * lot's IANA zone from the snapshot (taken from the airport config at staging).
 * Booking times are literal airport-local strings and are only ever resolved
 * through `checkInInstantMs` (components → TZDate), never `new Date(str)`.
 *
 *   release  check-OUT has passed (nothing left to park), or the card was
 *            authorized AFTER check-in (the customer paid for a stay that had
 *            already begun — staging refuses that, so this is a bypass)
 *   late     check-in has passed, check-out has not, and the card was authorized
 *            before check-in: a slow fulfilment (3-D Secure, a webhook retry).
 *            Fulfil; the lot notice is flagged URGENT.
 */
export function directStaleness(input: {
  fromDate: string;
  toDate: string;
  timezone: string;
  /** When the card was authorized, in ms: the latest charge's creation time
   *  (the engine falls back to `pi.created`, which is earlier — that can only
   *  make an "authorized after check-in" release less likely, never invent one). */
  authorizedAtMs: number;
  nowMs: number;
}): DirectStaleness {
  const checkIn = checkInInstantMs(input.fromDate, input.timezone);
  const checkOut = checkInInstantMs(input.toDate, input.timezone);
  if (checkIn === null || checkOut === null) {
    return { kind: "unknown", detail: `cannot resolve ${input.fromDate} / ${input.toDate} in ${input.timezone}` };
  }
  if (input.nowMs >= checkOut) return { kind: "release", reason: "the stay has already ended" };
  if (input.authorizedAtMs > checkIn) return { kind: "release", reason: "the card was authorized after check-in" };
  if (input.nowMs >= checkIn) return { kind: "late" };
  return { kind: "ok" };
}
