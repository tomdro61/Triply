import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const page = parseInt(searchParams.get("page") || "1");
    const limit = parseInt(searchParams.get("limit") || "20");
    const status = searchParams.get("status");
    const search = searchParams.get("search");
    const startDate = searchParams.get("startDate");
    const endDate = searchParams.get("endDate");

    const offset = (page - 1) * limit;

    // Build query
    let query = supabase
      .from("bookings")
      .select(`
        *,
        customers (
          id,
          email,
          first_name,
          last_name,
          phone
        )
      `, { count: "exact" })
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

    // Search by reservation number or location name
    if (search) {
      query = query.or(`reslab_reservation_number.ilike.%${search}%,location_name.ilike.%${search}%`);
    }

    const { data: bookings, error, count } = await query;

    if (error) {
      console.error("Admin bookings error:", error);
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
    console.error("Admin bookings error:", error);
    return NextResponse.json(
      { error: "Failed to fetch bookings" },
      { status: 500 }
    );
  }
}
