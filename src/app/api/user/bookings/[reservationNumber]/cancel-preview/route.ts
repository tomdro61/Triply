import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { captureAPIError } from "@/lib/sentry";
import { stripe } from "@/lib/stripe/client";
import { planTeardown } from "@/lib/cancellation/finalize";
import { isCancellable } from "@/lib/cancellation/eligibility";

/**
 * Refund preview for the cancel confirmation dialog.
 *
 * Read-only: it moves no money and takes no claim. It exists so the dialog can
 * show the customer what they will actually get back BEFORE they confirm an
 * irreversible action.
 *
 * Why not compute this in the browser from the booking row? Because
 * `grand_total + service_fee + protection_plan_price` is NOT reliably what the
 * customer paid. A promo discount is charged to Stripe but (today) never written
 * back to the booking row, so row-derived math over-states the refund for every
 * discounted booking — we would promise $47.58 and pay $42. The authoritative
 * number is the PaymentIntent, so we read it here and hand it to the SAME
 * planTeardown the cancel path uses.
 */

// One Stripe read; nothing chained. Well under the cancel route's 60s.
export const maxDuration = 15;

const ENDPOINT = "/api/user/bookings/[reservationNumber]/cancel-preview";

// EVERY response carries this. A refund quote is per-user and time-sensitive,
// and the kill-switch 404 is the most cacheable response in the file — if it
// were cached during the pre-launch (flag-off) period it would keep 404-ing
// after the flag flips. Caching an upstream refusal and serving it as a result
// is the 2026-06-29 incident in miniature.
const NO_STORE = { "Cache-Control": "no-store" } as const;

const paramSchema = z.object({
  reservationNumber: z
    .string()
    .min(3)
    .max(64)
    .regex(/^[A-Za-z0-9-]+$/, "invalid reservation number"),
});

// Mirrors the cancel route: the session client is RLS-scoped to
// customers.user_id = auth.uid(), so a row comes back ONLY if this user owns it.
const BOOKING_SELECT = `
  id, status, reslab_reservation_number, location_name,
  check_in, check_out, location_timezone,
  protection_plan, protection_plan_price, stripe_payment_intent_id
`;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ reservationNumber: string }> },
) {
  try {
    // Kill-switch parity with the cancel route — the preview must not exist
    // while the feature is off, or it becomes a way to probe booking data.
    if (process.env.ENABLE_SELF_SERVE_CANCEL !== "true") {
      return NextResponse.json(
        { error: "not_found", message: "Not found" },
        { status: 404, headers: NO_STORE },
      );
    }

    const parsed = paramSchema.safeParse(await params);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "bad_request", message: "Invalid reservation number" },
        { status: 400, headers: NO_STORE },
      );
    }
    const { reservationNumber } = parsed.data;

    const supabase = await createClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();
    if (authError || !user) {
      // The client redirects to login on this — same as the cancel action, so a
      // session that expired between page load and click behaves consistently.
      return NextResponse.json(
        { error: "unauthorized", message: "Please sign in again." },
        { status: 401, headers: NO_STORE },
      );
    }

    const { data: booking, error: readError } = await supabase
      .from("bookings")
      .select(BOOKING_SELECT)
      .eq("reslab_reservation_number", reservationNumber)
      .maybeSingle();

    if (readError) {
      captureAPIError(
        new Error(
          `cancel-preview ownership read failed for ${reservationNumber}: ${readError.message}`,
        ),
        { endpoint: ENDPOINT, method: "GET", statusCode: 500 },
      );
      return NextResponse.json(
        { error: "read_failed", message: "We couldn't calculate your refund." },
        { status: 500, headers: NO_STORE },
      );
    }
    // Don't leak whether the reservation exists to a non-owner: an unowned and a
    // nonexistent reservation return the identical body.
    if (!booking) {
      return NextResponse.json(
        { error: "not_found", message: "Reservation not found." },
        { status: 404, headers: NO_STORE },
      );
    }

    if (booking.status !== "confirmed") {
      return NextResponse.json(
        {
          error: "cannot_cancel",
          message: "This reservation can no longer be cancelled.",
        },
        { status: 409, headers: NO_STORE },
      );
    }

    // Same server-side 24h gate as the cancel action. The dialog should never
    // quote a refund for something that will be refused a second later.
    const eligibility = isCancellable(booking.check_in, booking.location_timezone);
    if (!eligibility.cancellable) {
      return NextResponse.json(
        {
          error: "not_eligible",
          message:
            "Cancellations are only available more than 24 hours before check-in.",
        },
        { status: 422, headers: NO_STORE },
      );
    }

    if (!booking.stripe_payment_intent_id) {
      // No PI to read: we cannot state a number honestly. Say so rather than
      // guessing from the row — a wrong figure here is worse than none.
      return NextResponse.json(
        {
          error: "amount_unavailable",
          message:
            "We can't calculate your refund right now. Please contact support and we'll help.",
        },
        { status: 409, headers: NO_STORE },
      );
    }

    const pi = await stripe.paymentIntents.retrieve(
      booking.stripe_payment_intent_id,
      { expand: ["latest_charge"] },
    );

    // Delegate the decision to the SAME function the real cancel uses, rather
    // than re-deriving it. planTeardown branches on pi.status FIRST, and
    // skipping that branch is how a preview diverges in the worst direction:
    //   - `processing`       -> amount_received is 0, so we'd quote "$0.00"
    //                           on a booking the cancel route REFUSES.
    //   - `requires_capture` -> nothing captured, so we'd quote "$0.00 refund"
    //                           while a live authorization sits on their card.
    //                           (Not hypothetical — this is the state the July
    //                           payment-atomicity work deliberately introduced.)
    //   - unreadable charge  -> we'd quote a full refund, then the confirm 409s.
    // Routing through planTeardown makes "the displayed figure is the refunded
    // figure" structural instead of aspirational.
    const plan = planTeardown(pi, booking);

    if (!plan.ok) {
      if (plan.reason === "processing") {
        return NextResponse.json(
          {
            error: "payment_settling",
            message:
              "Your payment is still processing. Please try again in a few minutes.",
          },
          { status: 409, headers: NO_STORE },
        );
      }
      return NextResponse.json(
        {
          error: "amount_unavailable",
          message:
            "We can't calculate your refund right now. Please contact support and we'll help.",
        },
        { status: 409, headers: NO_STORE },
      );
    }

    // An authorization we'll release: nothing was ever captured, so "Refund
    // $0.00" would be actively misleading. The client renders different copy.
    const isAuthorizationRelease = plan.teardown.kind === "release";
    const refundCents =
      plan.teardown.kind === "refund" ? plan.teardown.refundCents : 0;

    return NextResponse.json(
      {
        reservationNumber,
        // Everything in DOLLARS for display. Cents stay server-side.
        paidTotal: (pi.amount_received ?? 0) / 100,
        refundAmount: refundCents / 100,
        parkGuardWithheld: plan.pgWholesaleCents / 100,
        priorRefunded: plan.priorRefundedCents / 100,
        hasParkGuard: !!booking.protection_plan,
        isAuthorizationRelease,
      },
      { headers: NO_STORE },
    );
  } catch (error) {
    captureAPIError(
      error instanceof Error ? error : new Error(String(error)),
      { endpoint: ENDPOINT, method: "GET", statusCode: 500 },
    );
    return NextResponse.json(
      { error: "preview_failed", message: "We couldn't calculate your refund." },
      { status: 500, headers: NO_STORE },
    );
  }
}
