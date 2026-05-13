import { NextRequest, NextResponse } from "next/server";
import { reslab } from "@/lib/reslab/client";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { captureBookingError } from "@/lib/sentry";
import { isAdminEmail } from "@/config/admin";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  if (!id) {
    return NextResponse.json(
      { error: "Reservation ID is required" },
      { status: 400 }
    );
  }

  try {
    // --- Auth check (R1: IDOR protection) ---
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (user) {
      // Logged-in user: verify they own this booking via Supabase
      const adminClient = await createAdminClient();
      const { data: booking } = await adminClient
        .from("bookings")
        .select("customer_id, customers(user_id)")
        .eq("reslab_reservation_number", id)
        .single();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const customerUserId = (booking?.customers as any)?.user_id;
      if (!booking || customerUserId !== user.id) {
        // Check if user is admin
        if (!isAdminEmail(user.email)) {
          return NextResponse.json(
            { error: "Not authorized to view this reservation" },
            { status: 403 }
          );
        }
      }
    } else {
      // Not logged in: require email query param for verification
      const email = request.nextUrl.searchParams.get("email");
      if (!email) {
        return NextResponse.json(
          { error: "Authentication required" },
          { status: 403 }
        );
      }

      // Look up booking in Supabase to verify email matches
      const adminClient = await createAdminClient();
      const { data: booking } = await adminClient
        .from("bookings")
        .select("customer_id, customers(email)")
        .eq("reslab_reservation_number", id)
        .single();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const customerEmail = (booking?.customers as any)?.email;
      if (!booking || customerEmail?.toLowerCase() !== email.toLowerCase()) {
        return NextResponse.json(
          { error: "Not authorized to view this reservation" },
          { status: 403 }
        );
      }
    }

    // Fetch booking record from Supabase. We pull check_in/check_out here as a
    // primary source for booking times — ResLab's getReservation API has been
    // observed returning normalized midnight values for parking_rates.from_date
    // even when the original booking had a real time (e.g., FVSPF765362 returns
    // "00:00:00" via API while the ResLab dashboard shows the correct 08:00 AM).
    // Supabase preserves what the customer originally picked, so it's authoritative.
    const adminClientForVehicle = await createAdminClient();
    const { data: bookingData, error: bookingErr } = await adminClientForVehicle
      .from("bookings")
      .select("vehicle_info, triply_service_fee, check_in, check_out, protection_plan, protection_plan_price, pg_identifier, pg_sync_status")
      .eq("reslab_reservation_number", id)
      .single();

    if (bookingErr) {
      // The auth check above already proved a booking row exists for this id —
      // a failure here is anomalous and would silently re-introduce the original
      // midnight-time bug if we just fell through to ResLab. Surface it.
      captureBookingError(
        new Error(`Supabase booking lookup failed: ${bookingErr.message}`),
        { step: "confirmation", confirmationNumber: id }
      );
    }

    const triplyServiceFee = parseFloat(bookingData?.triply_service_fee ?? "0") || 0;

    // Resolve protection state defensively. If protection_plan is set, the row
    // MUST also have a positive protection_plan_price — anything else is a
    // schema-level bug that would render "Protection Active … $0.00" to the
    // customer. Suppress the protection block in that case and Sentry-flag so
    // ops can manually repair.
    let resolvedProtectionPlan: string | null = bookingData?.protection_plan || null;
    let resolvedProtectionPlanPrice = 0;
    if (resolvedProtectionPlan) {
      const parsed = parseFloat(bookingData?.protection_plan_price ?? "");
      if (Number.isFinite(parsed) && parsed > 0) {
        resolvedProtectionPlanPrice = parsed;
      } else {
        captureBookingError(
          new Error(
            `Booking has protection_plan='${resolvedProtectionPlan}' but invalid protection_plan_price='${bookingData?.protection_plan_price}' — suppressing protection block in API response`
          ),
          { step: "confirmation", confirmationNumber: id }
        );
        resolvedProtectionPlan = null;
      }
    }
    const protectionPlanPrice = resolvedProtectionPlanPrice;

    // Normalize Supabase timestamp (TIMESTAMP without tz, returned as
    // "2026-05-10T08:00:00") to the "YYYY-MM-DD HH:mm:ss" shape consumers expect.
    const normalizeBookingDate = (value: string | null | undefined): string | null => {
      if (!value) return null;
      // Strip optional trailing fractional seconds + Z, then optional offset,
      // then convert T to space. Anchored to end-of-string to avoid eating
      // any digit run earlier in the value.
      const trimmed = value
        .replace(/\.\d+Z?$/, "")
        .replace(/Z$|[+-]\d{2}:?\d{2}$/, "");
      return trimmed.replace("T", " ");
    };
    const supabaseFromDate = normalizeBookingDate(bookingData?.check_in);
    const supabaseToDate = normalizeBookingDate(bookingData?.check_out);

    // Fetch reservation from ResLab API
    const reservation = await reslab.getReservation(id);

    // ResLab returns data nested in history[0]
    const history = reservation.history?.[0];
    const location = history?.location;

    // Parse customer name from reserved_for
    const reservedFor = history?.reserved_for || reservation.reserved_by || "";
    const nameParts = reservedFor.split(" ");
    const firstName = nameParts[0] || "";
    const lastName = nameParts.slice(1).join(" ") || "";

    // Get dates from the first item in history
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dates = history?.dates?.[0] as any;
    const parkingRates = dates?.parking_rates?.[0];

    return NextResponse.json({
      reservation: {
        id: history?.id || reservation.reservation_number,
        reservationNumber: reservation.reservation_number,
        status: reservation.cancelled ? "cancelled" : "confirmed",
        grandTotal: (history?.grand_total || 0) + triplyServiceFee + protectionPlanPrice,
        subtotal: history?.subtotal || 0,
        taxTotal: history?.total_tax || 0,
        feesTotal: history?.total_fees || 0,
        serviceFee: triplyServiceFee,
        protectionPlan: resolvedProtectionPlan,
        protectionPlanPrice,
        pgIdentifier: bookingData?.pg_identifier || null,
        pgSyncStatus: bookingData?.pg_sync_status || null,
        dueNow: (history?.grand_total || 0) + triplyServiceFee + protectionPlanPrice - (history?.due_at_location_total || 0),
        dueAtLocation: history?.due_at_location_total || 0,
        customer: {
          firstName,
          lastName,
          email: history?.email || "",
          phone: history?.phone || "",
        },
        items: dates ? [{
          type: "parking",
          // Prefer Supabase values for times — ResLab's API can return midnight
          // even when the dashboard shows the correct picked time.
          fromDate: supabaseFromDate || parkingRates?.from_date || dates.from_date,
          toDate: supabaseToDate || parkingRates?.to_date || dates.to_date,
          numberOfDays: parkingRates?.number_of_days || dates.number_of_days,
          numberOfSpots: parkingRates?.number_of_parkings || 1,
          parkingType: parkingRates?.rate?.location_parking_type?.name || dates.type?.name,
        }] : [],
        location: location
          ? {
              id: location.id,
              name: location.name,
              address: location.address,
              city: location.city,
              state: location.state?.code,
              zipCode: location.zip_code,
              phone: location.phone,
              latitude: location.latitude,
              longitude: location.longitude,
            }
          : null,
        // Vehicle info from Supabase (reliable), with ResLab extra_fields as fallback
        vehicleInfo: bookingData?.vehicle_info || null,
        extraFields: Array.isArray(history?.extra_fields)
          ? Object.fromEntries(
              history.extra_fields
                .filter((f) => f.name && f.value)
                .map((f) => [f.name, f.value as string])
            )
          : {},
      },
    });
  } catch (error) {
    console.error("Error fetching reservation:", error);
    captureBookingError(error instanceof Error ? error : new Error(String(error)), {
      step: "confirmation",
    });

    // Return a more specific error for not found
    if (error instanceof Error && error.message.includes("404")) {
      return NextResponse.json(
        { error: "Reservation not found" },
        { status: 404 }
      );
    }

    return NextResponse.json(
      { error: "Failed to fetch reservation" },
      { status: 500 }
    );
  }
}
