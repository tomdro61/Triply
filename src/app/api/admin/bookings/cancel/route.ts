import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { isAdminEmail } from "@/config/admin";
import { reslab } from "@/lib/reslab/client";
import { createRefund } from "@/lib/stripe/client";
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

    // Pre-check: verify booking exists and is in a cancellable state
    const { data: booking } = await supabase
      .from("bookings")
      .select("status")
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
      errors: string[];
    } = {
      reslab: false,
      stripe: false,
      supabase: false,
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
    const newStatus =
      stripePaymentIntentId ? "refunded" : "cancelled";

    const [stripeResult, supabaseResult] = await Promise.allSettled([
      // Stripe refund
      stripePaymentIntentId
        ? createRefund(stripePaymentIntentId)
        : Promise.resolve(null),
      // Supabase status update
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

    const allSucceeded =
      results.reslab && results.stripe && results.supabase;

    return NextResponse.json(
      {
        success: allSucceeded,
        results,
        newStatus,
        message: allSucceeded
          ? "Reservation cancelled and refunded successfully"
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
