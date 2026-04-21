import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { isAdminEmail } from "@/config/admin";
import { reslab } from "@/lib/reslab/client";
import { createRefund, getPaymentIntent } from "@/lib/stripe/client";
import { sendCancellationConfirmation } from "@/lib/resend/send-cancellation-confirmation";
import { captureAPIError } from "@/lib/sentry";

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
    const { reservationNumber, stripePaymentIntentId } = await request.json();

    if (!reservationNumber) {
      return NextResponse.json(
        { error: "Reservation number is required" },
        { status: 400 }
      );
    }

    // Pre-check: verify booking exists, is cancellable, and fetch details for email
    const { data: booking } = await supabase
      .from("bookings")
      .select(`
        status, location_name, location_address, check_in, check_out, grand_total, triply_service_fee,
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

    const results: {
      reslab: boolean;
      stripe: boolean;
      supabase: boolean;
      email: boolean;
      errors: string[];
    } = {
      reslab: false,
      stripe: false,
      supabase: false,
      email: false,
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
    // Service fee is non-refundable. Refund = actual amount charged − service fee.
    // We read the charge from Stripe rather than reconstructing it from stored fields,
    // so partial captures / pricing changes / due-at-location splits can't desync us.
    const serviceFee = parseFloat(booking.triply_service_fee) || 0;
    let refundAmount = 0;
    if (stripePaymentIntentId) {
      try {
        const pi = await getPaymentIntent(stripePaymentIntentId);
        const amountReceived = (pi.amount_received || 0) / 100;
        refundAmount = Math.max(0, Math.round((amountReceived - serviceFee) * 100) / 100);
      } catch (error) {
        const msg = error instanceof Error ? error.message : "PaymentIntent lookup failed";
        results.errors.push(`Stripe: ${msg}`);
      }
    }
    const wasRefunded = !!stripePaymentIntentId && refundAmount > 0;
    const newStatus = wasRefunded ? "refunded" : "cancelled";

    if (stripePaymentIntentId && refundAmount <= 0 && !results.errors.some(e => e.startsWith("Stripe:"))) {
      results.errors.push(
        `Stripe: refund skipped — computed amount is $${refundAmount} (service_fee=${serviceFee})`
      );
    }

    const [stripeResult, supabaseResult] = await Promise.allSettled([
      wasRefunded
        ? createRefund(stripePaymentIntentId, refundAmount)
        : Promise.resolve(null),
      supabase
        .from("bookings")
        .update({ status: newStatus })
        .eq("reslab_reservation_number", reservationNumber),
    ]);

    if (stripeResult.status === "fulfilled") {
      results.stripe = true;
    } else {
      results.errors.push(`Stripe: ${stripeResult.reason?.message || "Refund failed"}`);
    }

    if (
      supabaseResult.status === "fulfilled" &&
      !supabaseResult.value?.error
    ) {
      results.supabase = true;
    } else {
      const msg =
        supabaseResult.status === "rejected"
          ? supabaseResult.reason?.message
          : supabaseResult.value?.error?.message;
      results.errors.push(`Supabase: ${msg || "Update failed"}`);
    }

    // Step 4: Send cancellation email to customer
    const customer = booking.customers as unknown as {
      email: string;
      first_name: string | null;
      last_name: string | null;
    } | null;
    if (customer?.email) {
      try {
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
      results.reslab && results.stripe && results.supabase;

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
