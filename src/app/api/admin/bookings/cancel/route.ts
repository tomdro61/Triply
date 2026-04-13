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

    const { reservationNumber, stripePaymentIntentId } = await request.json();

    if (!reservationNumber) {
      return NextResponse.json(
        { error: "Reservation number is required" },
        { status: 400 }
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

    // Step 2: Refund in Stripe (if payment intent exists)
    if (stripePaymentIntentId) {
      try {
        await createRefund(stripePaymentIntentId);
        results.stripe = true;
      } catch (error) {
        const msg =
          error instanceof Error ? error.message : "Stripe refund failed";
        results.errors.push(`Stripe: ${msg}`);
      }
    } else {
      results.stripe = true; // No payment to refund (dev mode booking)
    }

    // Step 3: Update status in Supabase
    try {
      const supabase = await createAdminClient();
      const { error } = await supabase
        .from("bookings")
        .update({ status: "cancelled" })
        .eq("reslab_reservation_number", reservationNumber);

      if (error) throw error;
      results.supabase = true;
    } catch (error) {
      const msg =
        error instanceof Error ? error.message : "Supabase update failed";
      results.errors.push(`Supabase: ${msg}`);
    }

    const allSucceeded =
      results.reslab && results.stripe && results.supabase;

    return NextResponse.json(
      {
        success: allSucceeded,
        results,
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
