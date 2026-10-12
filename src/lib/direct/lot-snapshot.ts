import { z } from "zod";
import { DIRECT_LOT_VISIBILITIES } from "./visibility";

/**
 * The per-booking copy of the direct lot as it was when the customer booked
 * (plan B10/B12/C8). Built SERVER-SIDE by /api/reservations/pending from the
 * lot store — never from the client — stored on `pending_bookings.lot_snapshot`
 * and copied to `bookings.lot_snapshot` at persist, so fulfilment, the
 * confirmation page, emails and Park Guard never re-read the CMS and a later
 * CMS edit never changes history. Versioned so a reader can refuse a shape it
 * does not understand instead of guessing.
 *
 * Money INPUTS (rate, tax) are here for audit; the money the customer was
 * charged lives in PaymentIntent metadata, which is the only authority. The
 * partner share is NOT here: a signed-in customer can read their own bookings
 * row (RLS, 001) and with it this snapshot. The share, tax terms and the lot's
 * notice recipients live in the service-role-only `direct_booking_terms` table
 * (migration 038), and a bookings snapshot may not carry `notificationEmails`
 * (DB CHECK) — the v2 snapshot written in Phase 4b drops it.
 *
 * v1 was never written to any row (no direct booking existed before 4b-2); it
 * is kept as the base the v2 schema is derived from.
 */
export const lotSnapshotSchema = z.object({
  v: z.literal(1),
  directLotId: z.string().min(1),
  name: z.string().min(1),
  slug: z.string().min(1),
  airportCode: z.string().regex(/^[A-Z]{3}$/),
  timezone: z.string().min(1),
  address: z.object({
    street: z.string().min(1),
    city: z.string().min(1),
    state: z.string().regex(/^[A-Z]{2}$/),
    zip: z.string().min(1),
  }),
  coordinates: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }),
  shuttleDetails: z.string().nullable(),
  shuttlePhone: z.string().nullable(),
  bookingInstructions: z.object({
    beforeArrival: z.string().nullable(),
    whenYouArrive: z.string().nullable(),
    importantNotes: z.string().nullable(),
    whenYouReturn: z.string().nullable(),
    gettingToAirport: z.string().nullable(),
  }),
  visibility: z.enum(DIRECT_LOT_VISIBILITIES),
  rateCents: z.number().int().positive(),
  taxRatePercent: z.number().min(0).max(100),
  taxCollectedBy: z.enum(["triply", "lot"]),
  minStayDays: z.number().int().min(1),
  minLeadHours: z.number().min(0),
  /** v1 only (never written). Recipients live in direct_booking_terms.lot_recipients, captured at staging. */
  notificationEmails: z.array(z.string().email()).min(1),
}).strict(); // unknown keys are refused, not stripped: a snapshot with extra data is a bug

export type LotSnapshot = z.infer<typeof lotSnapshotSchema>;

/** Parse a stored snapshot; returns null (never throws) on any shape mismatch. */
export function parseLotSnapshot(value: unknown): LotSnapshot | null {
  const r = lotSnapshotSchema.safeParse(value);
  return r.success ? r.data : null;
}

/**
 * v2 — what 4b-2 writes (stageDirect → pending_bookings → bookings). The
 * CUSTOMER-SAFE subset of v1: the bookings row is customer-readable (RLS), so
 * v2 carries only what the booking displays. Dropped: `notificationEmails`
 * (recipients live ONLY in the service-role-only `direct_booking_terms` row;
 * the bookings CHECK refuses a snapshot that carries them, migration 038) and
 * the lot's commercial terms — rate, tax rate, who collects tax, minimum stay,
 * lead time, visibility (4b plan §2.1 / APB #1; the charged numbers live in
 * PaymentIntent metadata, the tax terms in `direct_booking_terms`).
 * `.strict()` like v1. The live reader (reservation-view) accepts v1 and v2.
 */
export const lotSnapshotV2Schema = lotSnapshotSchema
  .omit({
    notificationEmails: true,
    visibility: true,
    rateCents: true,
    taxRatePercent: true,
    taxCollectedBy: true,
    minStayDays: true,
    minLeadHours: true,
  })
  .extend({ v: z.literal(2) })
  .strict();
export type LotSnapshotV2 = z.infer<typeof lotSnapshotV2Schema>;

/** Parse a stored v2 snapshot; returns null (never throws) on any shape mismatch. */
export function parseLotSnapshotV2(value: unknown): LotSnapshotV2 | null {
  const r = lotSnapshotV2Schema.safeParse(value);
  return r.success ? r.data : null;
}


/** One-line street address for a snapshot (rows, emails, Park Guard fallback). */
export function snapshotAddressLine(s: Pick<LotSnapshotV2, "address">): string {
  return `${s.address.street}, ${s.address.city}, ${s.address.state} ${s.address.zip}`;
}
