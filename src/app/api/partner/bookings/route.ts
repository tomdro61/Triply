import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { getPartnerByUserId } from "@/config/partner";
import { captureAPIError } from "@/lib/sentry";

export async function GET(request: NextRequest) {
  try {
    // Auth check
    const authClient = await createClient();
    const {
      data: { user },
    } = await authClient.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const partner = await getPartnerByUserId(user.id);
    if (!partner) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const supabase = await createAdminClient();

    const { searchParams } = new URL(request.url);
    const page = Math.max(1, parseInt(searchParams.get("page") || "1") || 1);
    const limit = Math.min(
      100,
      Math.max(1, parseInt(searchParams.get("limit") || "20") || 20)
    );
    const status = searchParams.get("status");
    const search = searchParams.get("search");
    const startDate = searchParams.get("startDate");
    const endDate = searchParams.get("endDate");

    const offset = (page - 1) * limit;

    // Build query — scoped to partner's location.
    // Explicit allow-list (NOT `*`). Partners are external lot operators;
    // they must NOT see Triply's internal economics:
    //   - triply_service_fee (our margin)
    //   - protection_plan / protection_plan_price (Park Guard pricing)
    //   - pg_identifier / pg_sync_status (PG sync internals)
    //   - stripe_payment_intent_id (payment internals)
    let query = supabase
      .from("bookings")
      .select(
        `
        id,
        reslab_reservation_number,
        reslab_location_id,
        location_name,
        location_address,
        airport_code,
        check_in,
        check_out,
        grand_total,
        status,
        vehicle_info,
        created_at,
        customers (
          id,
          email,
          first_name,
          last_name,
          phone
        )
      `,
        { count: "exact" }
      )
      .eq("reslab_location_id", partner.reslab_location_id)
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    // Filter by status
    if (status && status !== "all") {
      query = query.eq("status", status);
    }

    // Filter by date range
    if (startDate) {
      query = query.gte("created_at", startDate);
    }
    if (endDate) {
      query = query.lt("created_at", endDate);
    }

    // Search by reservation number or customer name
    if (search) {
      const sanitizedSearch = search.replace(/[^a-zA-Z0-9\s\-_#]/g, "");
      if (sanitizedSearch) {
        query = query.or(
          `reslab_reservation_number.ilike.%${sanitizedSearch}%,location_name.ilike.%${sanitizedSearch}%`
        );
      }
    }

    const { data: bookings, error, count } = await query;

    if (error) {
      console.error("Partner bookings error:", error);
      return NextResponse.json(
        { error: "Failed to fetch bookings" },
        { status: 500 }
      );
    }

    return NextResponse.json({
      bookings: bookings || [],
      pagination: {
        page,
        limit,
        total: count || 0,
        totalPages: Math.ceil((count || 0) / limit),
      },
    });
  } catch (error) {
    console.error("Partner bookings error:", error);
    captureAPIError(
      error instanceof Error ? error : new Error(String(error)),
      {
        endpoint: "/api/partner/bookings",
        method: "GET",
      }
    );
    return NextResponse.json(
      { error: "Failed to fetch bookings" },
      { status: 500 }
    );
  }
}
