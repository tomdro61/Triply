import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { captureBookingError } from "@/lib/sentry";

export async function GET() {
  try {
    const supabase = await createClient();

    // Get current user
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      );
    }

    // First get the customer record for this user
    const { data: customer, error: customerError } = await supabase
      .from("customers")
      .select("id")
      .eq("user_id", user.id)
      .single();

    if (customerError || !customer) {
      // User has no customer record = no bookings
      return NextResponse.json({ bookings: [] });
    }

    // Fetch all bookings for this customer
    const { data: bookings, error: bookingsError } = await supabase
      .from("bookings")
      .select("*")
      .eq("customer_id", customer.id)
      .order("check_in", { ascending: false });

    if (bookingsError) {
      console.error("Error fetching bookings:", bookingsError);
      return NextResponse.json(
        { error: "Failed to fetch bookings" },
        { status: 500 }
      );
    }

    // Surface rows where protection_plan is set but protection_plan_price
    // is invalid — those would render "$0 Protection" in the reservation
    // card total. Migration 011 blocks new such rows; this catches legacy
    // dirty data.
    const dirtyProtection = (bookings || []).filter((b) => {
      if (!b.protection_plan) return false;
      const parsed = parseFloat(b.protection_plan_price ?? "");
      return !Number.isFinite(parsed) || parsed <= 0;
    });
    if (dirtyProtection.length > 0) {
      captureBookingError(
        new Error(
          `/api/user/bookings: ${dirtyProtection.length} booking(s) for customer ${customer.id} with protection_plan set but invalid protection_plan_price`
        ),
        { step: "confirmation", userId: user.id }
      );
    }

    return NextResponse.json({ bookings: bookings || [] });
  } catch (error) {
    console.error("Error in user bookings route:", error);
    captureBookingError(error instanceof Error ? error : new Error(String(error)), {
      step: "confirmation",
    });
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
