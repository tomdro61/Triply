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
 * Money INPUTS (rate, tax, share) are here for audit; the money the customer
 * was charged lives in PaymentIntent metadata, which is the only authority.
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
  partnerSharePercent: z.number().min(0).max(100),
  minStayDays: z.number().int().min(1),
  minLeadHours: z.number().min(0),
  /** Fallback recipients only; the live CMS value is preferred at send time (C7). */
  notificationEmails: z.array(z.string().email()).min(1),
});

export type LotSnapshot = z.infer<typeof lotSnapshotSchema>;

/** Parse a stored snapshot; returns null (never throws) on any shape mismatch. */
export function parseLotSnapshot(value: unknown): LotSnapshot | null {
  const r = lotSnapshotSchema.safeParse(value);
  return r.success ? r.data : null;
}
