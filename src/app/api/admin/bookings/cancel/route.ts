import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { isAdminEmail } from "@/config/admin";
import { reslab } from "@/lib/reslab/client";
import { createRefund, getPaymentIntent } from "@/lib/stripe/client";
import { sendCancellationConfirmation } from "@/lib/resend/send-cancellation-confirmation";
import { captureAPIError, captureParkGuardError } from "@/lib/sentry";
import { parkGuard, ParkGuardError } from "@/lib/parkguard/client";

// Validate cancel-request body at the boundary. Both fields are user-supplied
// from the admin UI; treating them as raw `any` would let a malformed pi_*
// flow into Stripe refund calls and a non-Triply booking number into ResLab.
const cancelSchema = z.object({
  reservationNumber: z.string().min(1, "Reservation number is required"),
  stripePaymentIntentId: z
    .string()
    .startsWith("pi_", "stripePaymentIntentId must be a Stripe PaymentIntent ID")
    .optional(),
  // When true, the Triply service fee is refunded too (a full refund). Used
  // when a lot turns the customer away — Triply returns its own fee as goodwill.
  // Defaults false: the standard path retains the non-refundable service fee.
  refundServiceFee: z.boolean().optional().default(false),
});

export async function POST(request: NextRequest) {
  try {
    // Auth check
    const authClient = await createClient();
    const {
      data: { user },
    } = await authClient.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (!isAdminEmail(user.email)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const supabase = await createAdminClient();
    const parsed = cancelSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0].message },
        { status: 400 }
      );
    }
    const { reservationNumber, stripePaymentIntentId, refundServiceFee } = parsed.data;

    // Pre-check: verify booking exists, is cancellable, and fetch details for email
    const { data: booking } = await supabase
      .from("bookings")
      .select(`
        id, status, location_name, location_address, check_in, check_out, grand_total, triply_service_fee,
        protection_plan, protection_plan_price, pg_identifier, stripe_payment_intent_id,
        customers ( email, first_name, last_name )
      `)
      .eq("reslab_reservation_number", reservationNumber)
      .single();

    if (!booking) {
      return NextResponse.json(
        { error: "Booking not found" },
        { status: 404 }
      );
    }
    if (booking.status !== "confirmed") {
      return NextResponse.json(
        { error: `Booking is already ${booking.status}` },
        { status: 409 }
      );
    }

    // Cross-check: if admin supplied a PI, the booking row MUST also have a
    // stored PI AND they MUST match. Otherwise the route could refund an
    // arbitrary admin-supplied pi_* against an unrelated booking's payment.
    // Booking → PI is 1:1; a null stored PI on a booking that's being told
    // to refund means the relationship is unreconcilable from this route.
    if (stripePaymentIntentId) {
      if (!booking.stripe_payment_intent_id) {
        return NextResponse.json(
          { error: "Booking has no stored PaymentIntent — refund cannot be reconciled" },
          { status: 400 }
        );
      }
      if (stripePaymentIntentId !== booking.stripe_payment_intent_id) {
        return NextResponse.json(
          { error: "PaymentIntent does not match this booking" },
          { status: 400 }
        );
      }
    }

    // Use the booking row as the source of truth for the refund target.
    // The admin-supplied PI (if any) was only a cross-check above; sourcing
    // the refund from `booking.stripe_payment_intent_id` ensures that an
    // admin who cancels via a tool that omits the PI param doesn't silently
    // skip the refund on a booking that was actually paid.
    const refundPaymentIntentId = booking.stripe_payment_intent_id;

    const results: {
      reslab: boolean;
      stripe: boolean;
      supabase: boolean;
      email: boolean;
      parkGuard: boolean | null;
      errors: string[];
    } = {
      reslab: false,
      stripe: false,
      supabase: false,
      email: false,
      // null when no protection plan was on the booking, so the all-succeeded
      // check below doesn't penalize cancellations of unprotected bookings.
      parkGuard: booking.protection_plan ? false : null,
      errors: [],
    };

    // Step 1: Cancel in ResLab (release the parking spot)
    try {
      await reslab.cancelReservation(reservationNumber);
      results.reslab = true;
    } catch (error) {
      const msg =
        error instanceof Error ? error.message : "ResLab cancellation failed";
      results.errors.push(`ResLab: ${msg}`);
    }

    // Step 2 & 3: Stripe refund + Supabase update (run in parallel)
    // Standard cancel RETAINS the Triply service fee (refund = amount charged −
    // service fee). The full-refund path (refundServiceFee) returns the fee too,
    // for cases where the lot turned the customer away and Triply eats its fee.
    // We read the charge from Stripe rather than reconstructing it from stored
    // fields, so partial captures / pricing changes / due-at-location splits
    // can't desync us.
    const serviceFee = parseFloat(booking.triply_service_fee) || 0;
    const feeWithheld = refundServiceFee ? 0 : serviceFee;
    let refundAmount = 0;
    let piLookupFailed = false;
    if (refundPaymentIntentId) {
      try {
        const pi = await getPaymentIntent(refundPaymentIntentId);
        const amountReceived = (pi.amount_received || 0) / 100;
        refundAmount = Math.max(0, Math.round((amountReceived - feeWithheld) * 100) / 100);
      } catch (error) {
        piLookupFailed = true;
        const msg = error instanceof Error ? error.message : "PaymentIntent lookup failed";
        results.errors.push(`Stripe: ${msg}`);
      }
    }

    // Issue the refund and learn the ACTUAL outcome BEFORE persisting anything
    // that claims money moved. The old code wrote status + service_fee_refunded
    // from INTENT inside a parallel Promise.allSettled, so a rejected refund
    // left the row "refunded" / service_fee_refunded=true while the customer got
    // nothing — silently corrupting kept-revenue accounting (migration 013),
    // with no retry path (the 409 "already refunded" guard blocks re-runs) and
    // even emailing the customer that a refund was issued.
    const intendToRefund = !!refundPaymentIntentId && refundAmount > 0;
    if (intendToRefund) {
      try {
        await createRefund(refundPaymentIntentId, refundAmount);
        results.stripe = true;
      } catch (error) {
        results.errors.push(
          `Stripe: ${error instanceof Error ? error.message : "Refund failed"}`
        );
      }
    } else if (!piLookupFailed) {
      // Nothing to refund (no PaymentIntent, or a $0 computed amount because
      // parking was fully due-at-location and the fee is retained). Not a Stripe
      // failure, but surface the surprising $0 case so it isn't read as success.
      results.stripe = true;
      if (refundPaymentIntentId && refundAmount <= 0) {
        results.errors.push(
          `Stripe: refund skipped - computed amount is $${refundAmount} (service_fee=${serviceFee})`
        );
      }
    }

    // Persist booking state from the ACTUAL refund outcome.
    const wasRefunded = intendToRefund && results.stripe;
    const newStatus = wasRefunded ? "refunded" : "cancelled";
    // The fee was returned only if a full-refund refund actually fulfilled on a
    // booking that had a fee. This is what the accounting reconciler reads to
    // exclude the fee from kept revenue (migration 013).
    const serviceFeeRefunded = refundServiceFee && wasRefunded && serviceFee > 0;

    const { error: bookingUpdateError } = await supabase
      .from("bookings")
      .update({ status: newStatus, service_fee_refunded: serviceFeeRefunded })
      .eq("reslab_reservation_number", reservationNumber);
    if (bookingUpdateError) {
      results.errors.push(`Supabase: ${bookingUpdateError.message || "Update failed"}`);
      // Money may already have moved (wasRefunded) but the status/flag write
      // didn't persist — so Step 3.5's PG cancel is skipped and the row stays
      // "confirmed". PostgREST returns this as an error object (not a throw, so
      // the outer catch never sees it). Capture it explicitly: the PG gating
      // below assumes a Sentry alert exists whenever the Supabase write fails.
      captureAPIError(
        new Error(
          `Admin cancel: booking status update failed after refund=${wasRefunded}: ${bookingUpdateError.message}`
        ),
        { endpoint: "/api/admin/bookings/cancel", method: "POST", statusCode: 207 }
      );
    } else {
      results.supabase = true;
    }

    // Step 3.5: Notify Park Guard of cancellation if booking had protection.
    // The customer was refunded the premium via Stripe (refundAmount above
    // includes it because we read amount_received from Stripe), so PG must
    // mark the reservation cancelled — otherwise PG keeps the customer
    // "covered" and bills Triply for coverage on a refunded booking.
    //
    // Gated on `results.supabase` because the inverse failure mode (Triply
    // row stuck "confirmed" while PG says "cancelled") is worse: customer
    // has stale data they could rebook against. If Supabase failed, ops
    // already has a Sentry alert and will manually reconcile both sides.
    if (booking.protection_plan && booking.id && results.supabase) {
      try {
        await parkGuard.updateReservation(booking.id, { status: "cancelled" });
        results.parkGuard = true;
        // Clear pg_identifier now that PG is cancelled so Stripe's
        // charge.refunded webhook doesn't re-fire the PG cancel. A FULL refund
        // returns the entire charge, so amount_refunded === amount and the
        // webhook reaches its full-refund branch (previously unreachable for
        // admin cancels, which always retained the fee); that branch keys off
        // pg_identifier being set. This mirrors the webhook partial-refund
        // branch's own idempotency clear. Best-effort: a failure here only
        // risks one duplicate (idempotent, try/caught) PG cancel from the
        // webhook — so it's a soft error, not a cancellation failure.
        const { error: pgClearError } = await supabase
          .from("bookings")
          .update({ pg_identifier: null })
          .eq("reslab_reservation_number", reservationNumber);
        if (pgClearError) {
          results.errors.push(
            `Supabase: pg_identifier not cleared (${pgClearError.message}) — webhook may re-fire PG cancel`
          );
        }
      } catch (pgError) {
        results.parkGuard = false;
        const err = pgError instanceof Error ? pgError : new Error(String(pgError));
        const msg = err.message;
        captureParkGuardError(err, {
          bookingId: booking.id,
          reslabReservationNumber: reservationNumber,
          operation: "update",
          ...(pgError instanceof ParkGuardError && { statusCode: pgError.statusCode }),
        });
        results.errors.push(`ParkGuard: cancellation not synced (${msg}) — manual reconcile`);
      }
    }

    // Step 4: Send cancellation email to customer
    const customer = booking.customers as unknown as {
      email: string;
      first_name: string | null;
      last_name: string | null;
    } | null;
    if (customer?.email) {
      try {
        const protectionPlanRefund = booking.protection_plan
          ? parseFloat(booking.protection_plan_price ?? "0") || 0
          : 0;
        const emailResult = await sendCancellationConfirmation({
          to: customer.email,
          customerName: `${customer.first_name || ""} ${customer.last_name || ""}`.trim() || "Customer",
          confirmationNumber: reservationNumber,
          lotName: booking.location_name || "Parking Location",
          lotAddress: booking.location_address || "",
          checkInDate: booking.check_in,
          checkOutDate: booking.check_out,
          refundAmount,
          wasRefunded,
          // Only surface the fee as "retained" when it actually was. On a full
          // refund the fee is folded into refundAmount and no retained note shows.
          serviceFee: !serviceFeeRefunded && serviceFee > 0 ? serviceFee : undefined,
          protectionPlanRefund: protectionPlanRefund > 0 ? protectionPlanRefund : undefined,
        });
        results.email = emailResult.success;
        if (!emailResult.success) {
          results.errors.push("Email: Failed to send cancellation email");
        }
      } catch (error) {
        const msg =
          error instanceof Error ? error.message : "Email send failed";
        results.errors.push(`Email: ${msg}`);
      }
    }

    const allSucceeded =
      results.reslab &&
      results.stripe &&
      results.supabase &&
      results.parkGuard !== false;

    return NextResponse.json(
      {
        success: allSucceeded,
        results,
        newStatus,
        message: allSucceeded
          ? `Reservation cancelled and refunded successfully${results.email ? " — confirmation email sent" : ""}`
          : `Partial cancellation — ${results.errors.join("; ")}`,
      },
      { status: allSucceeded ? 200 : 207 }
    );
  } catch (error) {
    console.error("Admin cancel error:", error);
    captureAPIError(error instanceof Error ? error : new Error(String(error)), {
      endpoint: "/api/admin/bookings/cancel",
      method: "POST",
      statusCode: 500,
    });
    return NextResponse.json(
      { error: "Failed to cancel reservation" },
      { status: 500 }
    );
  }
}
