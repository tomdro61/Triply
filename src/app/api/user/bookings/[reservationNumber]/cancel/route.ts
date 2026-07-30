import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { captureAPIError } from "@/lib/sentry";
import { performSelfCancel, type CancelBookingRow } from "@/lib/cancellation/perform";

// Match every sibling money-path route (reservations, webhooks/stripe, the
// crons). This handler chains Stripe retrieve → claim → ResLab cancel (+ a
// possible getReservation probe, each up to RESLAB_TIMEOUT_MS) → Stripe
// refund/cancel → Supabase → Park Guard → email, all sequentially. The 60s
// ceiling is load-bearing, not cosmetic: claim.ts's stale-claim window
// (CANCEL_STALE_CLAIM_MS = 90s) is only safe while a healthy in-flight request
// finishes in under 90s, i.e. maxDuration MUST stay < 90s. Do not raise it past
// 90 without also raising CANCEL_STALE_CLAIM_MS.
export const maxDuration = 60;

const ENDPOINT = "/api/user/bookings/[reservationNumber]/cancel";

// The reslab_reservation_number is the client-facing key (returned by GET
// /api/user/bookings). Validate its shape at the boundary before it flows into
// ResLab / Stripe / DB lookups.
const paramSchema = z.object({
  reservationNumber: z
    .string()
    .min(3)
    .max(64)
    .regex(/^[A-Za-z0-9-]+$/, "invalid reservation number"),
});

// Server-side read only (never returned to the browser), so it may include the
// sensitive columns the GET route hides (stripe_payment_intent_id, pg_identifier).
const BOOKING_SELECT = `
  id, status, reslab_reservation_number, location_name, location_address,
  check_in, check_out, location_timezone, protection_plan, protection_plan_price,
  pg_identifier, stripe_payment_intent_id,
  customers ( email, first_name, last_name )
`;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ reservationNumber: string }> },
) {
  try {
    // 0. Kill-switch — the feature is invisible until deliberately enabled.
    if (process.env.ENABLE_SELF_SERVE_CANCEL !== "true") {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    // 1. Validate the route param.
    const parsed = paramSchema.safeParse(await params);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid reservation number" },
        { status: 400 },
      );
    }
    const { reservationNumber } = parsed.data;

    // 2. Session auth.
    const supabase = await createClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // 3. Ownership + fetch in ONE query. The SESSION client is RLS-scoped to
    //    customers where user_id = auth.uid() — the strong-link gate. A row comes
    //    back ONLY if this user owns it; email-fallback (claimable) bookings are
    //    deliberately excluded (no user_id link). No row → 404 (don't leak
    //    whether the reservation exists to a non-owner).
    const { data: booking, error: readError } = await supabase
      .from("bookings")
      .select(BOOKING_SELECT)
      .eq("reslab_reservation_number", reservationNumber)
      .maybeSingle();

    if (readError) {
      captureAPIError(
        new Error(
          `self-cancel ownership read failed for ${reservationNumber}: ${readError.message}`,
        ),
        { endpoint: ENDPOINT, method: "POST", statusCode: 500 },
      );
      return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
    }
    if (!booking) {
      return NextResponse.json({ error: "Reservation not found" }, { status: 404 });
    }

    // supabase-js types an embedded to-one as an array; normalize to a single
    // customer object without asserting shape (no cast-through-unknown).
    const rawCustomer = Array.isArray(booking.customers)
      ? booking.customers[0]
      : booking.customers;
    const row: CancelBookingRow = {
      id: booking.id,
      status: booking.status,
      reslab_reservation_number: booking.reslab_reservation_number,
      location_name: booking.location_name,
      location_address: booking.location_address,
      check_in: booking.check_in,
      check_out: booking.check_out,
      location_timezone: booking.location_timezone,
      protection_plan: booking.protection_plan,
      protection_plan_price: booking.protection_plan_price,
      pg_identifier: booking.pg_identifier,
      stripe_payment_intent_id: booking.stripe_payment_intent_id,
      customers: rawCustomer
        ? {
            email: rawCustomer.email,
            first_name: rawCustomer.first_name,
            last_name: rawCustomer.last_name,
          }
        : null,
    };

    // 4. Run the cancellation FSM.
    const result = await performSelfCancel(row);
    return NextResponse.json(result.body, { status: result.status });
  } catch (error) {
    captureAPIError(
      error instanceof Error ? error : new Error(String(error)),
      { endpoint: ENDPOINT, method: "POST", statusCode: 500 },
    );
    return NextResponse.json(
      { error: "Failed to cancel reservation" },
      { status: 500 },
    );
  }
}
