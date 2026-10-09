import { z } from "zod";
import type { createAdminClient } from "@/lib/supabase/server";
import { REVIEWABLE_STATUSES, linkableAirportCode } from "./select";
import { SHUTTLE_WAIT_VALUES, reviewDisplayName, type ReviewDetails } from "./schema";

/**
 * Server-only reads/writes for booking_reviews (service-role client; the table
 * has RLS on and no policies). Shared by the /review/[token] page and
 * POST /api/reviews so both judge a booking the same way. Every database
 * error THROWS — callers turn it into an error state, never a silent success.
 */

type Supabase = Awaited<ReturnType<typeof createAdminClient>>;

const DB_TIMEOUT_MS = 3_000;
const dbSignal = () => AbortSignal.timeout(DB_TIMEOUT_MS);

const customerSchema = z.object({ first_name: z.string().nullable() });

const bookingSchema = z.object({
  id: z.string(),
  status: z.string(),
  cancel_state: z.string().nullable(),
  location_name: z.string(),
  airport_code: z.string().nullable(),
  reslab_location_id: z.number().int().nullable(),
  direct_lot_id: z.string().nullable(),
  customers: z.union([customerSchema, z.array(customerSchema)]).nullable(),
});

const reviewSchema = z.object({
  rating: z.number().int(),
  shuttle_wait: z.enum(SHUTTLE_WAIT_VALUES).nullable(),
  extra_charges: z.boolean().nullable(),
  comment: z.string().nullable(),
  publish_consent: z.boolean(),
});

export interface ReviewBooking {
  id: string;
  /** Stored on the review exactly as the booking holds it. */
  airportCodeRaw: string | null;
  /** An airport we sell, for display and the book-again link; else null. */
  airportCode: string | null;
  reslabLocationId: number | null;
  directLotId: string | null;
  lotName: string;
  firstName: string | null;
}

export interface ExistingReview {
  rating: number;
  shuttleWait: (typeof SHUTTLE_WAIT_VALUES)[number] | null;
  extraCharges: boolean | null;
  comment: string | null;
  publishConsent: boolean;
}

export type ReviewContext =
  | { kind: "ok"; booking: ReviewBooking; review: ExistingReview | null }
  | { kind: "not_found" }
  /** Cancelled / refunded / mid-cancellation: no stay to review. */
  | { kind: "not_reviewable" };

export async function loadReviewContext(supabase: Supabase, bookingId: string): Promise<ReviewContext> {
  const [b, r] = await Promise.all([
    supabase
      .from("bookings")
      .select("id, status, cancel_state, location_name, airport_code, reslab_location_id, direct_lot_id, customers(first_name)")
      .eq("id", bookingId)
      .abortSignal(dbSignal())
      .maybeSingle(),
    supabase
      .from("booking_reviews")
      .select("rating, shuttle_wait, extra_charges, comment, publish_consent")
      .eq("booking_id", bookingId)
      .abortSignal(dbSignal())
      .maybeSingle(),
  ]);
  if (b.error) throw new Error(`bookings read failed: ${b.error.message}`);
  if (r.error) throw new Error(`booking_reviews read failed: ${r.error.message}`);
  if (!b.data) return { kind: "not_found" };

  const booking = bookingSchema.safeParse(b.data);
  if (!booking.success) throw new Error(`bookings row failed validation: ${booking.error.message}`);
  const row = booking.data;
  if (!REVIEWABLE_STATUSES.includes(row.status) || row.cancel_state !== null) return { kind: "not_reviewable" };

  let review: ExistingReview | null = null;
  if (r.data) {
    const p = reviewSchema.safeParse(r.data);
    if (!p.success) throw new Error(`booking_reviews row failed validation: ${p.error.message}`);
    review = {
      rating: p.data.rating,
      shuttleWait: p.data.shuttle_wait,
      extraCharges: p.data.extra_charges,
      comment: p.data.comment,
      publishConsent: p.data.publish_consent,
    };
  }

  const cust = Array.isArray(row.customers) ? (row.customers[0] ?? null) : row.customers;
  return {
    kind: "ok",
    booking: {
      id: row.id,
      airportCodeRaw: row.airport_code,
      airportCode: linkableAirportCode(row.airport_code),
      reslabLocationId: row.reslab_location_id,
      directLotId: row.direct_lot_id,
      lotName: row.location_name,
      firstName: cust?.first_name?.trim() || null,
    },
    review,
  };
}

/**
 * Upsert the review for a booking (UNIQUE booking_id). Without `details` only
 * the rating changes — a star tap never wipes details already given. With
 * `details`, every detail field is replaced by what the form sent.
 */
export async function upsertReview(
  supabase: Supabase,
  booking: ReviewBooking,
  rating: number,
  details: ReviewDetails | undefined
): Promise<void> {
  const base = {
    booking_id: booking.id,
    airport_code: booking.airportCodeRaw,
    reslab_location_id: booking.reslabLocationId,
    direct_lot_id: booking.directLotId,
    location_name: booking.lotName,
    rating,
    updated_at: new Date().toISOString(),
  };
  const row = details
    ? {
        ...base,
        shuttle_wait: details.shuttleWait,
        extra_charges: details.extraCharges,
        comment: details.comment,
        publish_consent: details.publishConsent,
        display_name: reviewDisplayName(booking.firstName, details.publishConsent),
      }
    : base;
  const { error } = await supabase
    .from("booking_reviews")
    .upsert(row, { onConflict: "booking_id" })
    .abortSignal(dbSignal());
  if (error) throw new Error(`booking_reviews upsert failed: ${error.message}`);
}
