import { NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { captureBookingError } from "@/lib/sentry";
import { getClaimableCustomerIds } from "@/lib/bookings/claimable";

// Column allowlist for the browser response. Excludes internal/sensitive
// fields (stripe_payment_intent_id, pg_identifier, pg_sync_status) but KEEPS
// protection_plan + protection_plan_price — both are consumed downstream (the
// reservation-card total and the dirty-data check below).
const BOOKING_COLUMNS =
  "id, reslab_reservation_number, reslab_location_id, location_name, location_address, airport_code, check_in, check_out, grand_total, triply_service_fee, protection_plan, protection_plan_price, vehicle_info, status, created_at";

export async function GET() {
  try {
    const supabase = await createClient();

    // Get current user (session client — RLS-scoped)
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // --- Tier 1: bookings already LINKED to this account ---
    // Read straight from bookings on the session client: RLS restricts rows to
    // customers whose user_id = auth.uid(), so this returns exactly this user's
    // linked bookings across ALL of their linked customer rows. A DB error here
    // must NOT masquerade as "no bookings" — return 500 (the original bug hid a
    // failing query behind an empty list).
    const { data: linked, error: linkedError } = await supabase
      .from("bookings")
      .select(BOOKING_COLUMNS)
      .order("check_in", { ascending: false });

    if (linkedError) {
      captureBookingError(
        new Error(`user bookings (linked) query failed: ${linkedError.message}`),
        { step: "account", userId: user.id }
      );
      return NextResponse.json(
        { error: "Failed to fetch bookings" },
        { status: 500 }
      );
    }

    // --- Tier 2: COUNT of claimable bookings under this verified email ---
    // Bookings sitting on UNLINKED customer rows whose email matches the user's
    // verified email. We return only a COUNT (no rows / no PII) — the customer
    // must explicitly claim them via POST /api/user/link-bookings before any
    // detail is shown or any user_id is written (plan B3c: no silent linking).
    // This whole branch is behind the ENABLE_EMAIL_BOOKING_FALLBACK kill-switch
    // and gated on a confirmed mailbox.
    let claimableCount = 0;
    const fallbackEnabled = process.env.ENABLE_EMAIL_BOOKING_FALLBACK !== "false";
    if (fallbackEnabled && user.email && user.email_confirmed_at) {
      try {
        const admin = await createAdminClient();
        // Shared, case-insensitive, wildcard-safe email match (see the helper).
        const claimableCustomerIds = await getClaimableCustomerIds(admin, user.email);

        if (claimableCustomerIds.length > 0) {
          // Count all statuses (incl. cancelled) — they ARE reservations made
          // with the customer's email; their status shows once claimed. head:
          // true returns only the count, so no booking PII reaches the browser.
          const { count, error: countError } = await admin
            .from("bookings")
            .select("id", { count: "exact", head: true })
            .in("customer_id", claimableCustomerIds);

          if (countError) {
            captureBookingError(
              new Error(`claimable bookings count failed: ${countError.message}`),
              { step: "account", userId: user.id }
            );
          } else {
            claimableCount = count ?? 0;
          }
        }
      } catch (fallbackError) {
        // Claimable is supplementary — never fail the whole page over it (a
        // getClaimableCustomerIds throw lands here). Linked bookings still render.
        captureBookingError(
          fallbackError instanceof Error ? fallbackError : new Error(String(fallbackError)),
          { step: "account", userId: user.id }
        );
      }
    }

    // Surface rows where protection_plan is set but protection_plan_price is
    // invalid — those would render "$0 Protection" in the reservation card
    // total. Migration 011 blocks new such rows; this catches legacy dirty data.
    const dirtyProtection = (linked ?? []).filter((b) => {
      if (!b.protection_plan) return false;
      const parsed = parseFloat(b.protection_plan_price ?? "");
      return !Number.isFinite(parsed) || parsed <= 0;
    });
    if (dirtyProtection.length > 0) {
      captureBookingError(
        new Error(
          `/api/user/bookings: ${dirtyProtection.length} booking(s) for user ${user.id} with protection_plan set but invalid protection_plan_price`
        ),
        { step: "account", userId: user.id }
      );
    }

    return NextResponse.json({ bookings: linked ?? [], claimableCount });
  } catch (error) {
    console.error("Error in user bookings route:", error);
    captureBookingError(error instanceof Error ? error : new Error(String(error)), {
      step: "account",
    });
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
