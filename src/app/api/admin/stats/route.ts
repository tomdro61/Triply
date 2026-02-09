import { NextRequest, NextResponse } from "next/server";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { isAdminEmail } from "@/config/admin";

const supabase = createSupabaseClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function GET(request: NextRequest) {
  try {
    // Auth check
    const authClient = await createClient();
    const { data: { user } } = await authClient.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (!isAdminEmail(user.email)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const filterStartDate = searchParams.get("startDate");
    const filterEndDate = searchParams.get("endDate");

    // Get today's date range
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    // Get this week's date range
    const weekStart = new Date(today);
    weekStart.setDate(weekStart.getDate() - weekStart.getDay());

    // Get this month's date range
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);

    // Helper to build filtered query
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const applyDateFilter = (query: any) => {
      if (filterStartDate) {
        query = query.gte("created_at", filterStartDate);
      }
      if (filterEndDate) {
        query = query.lt("created_at", filterEndDate);
      }
      return query;
    };

    // Total bookings (filtered)
    let totalQuery = supabase
      .from("bookings")
      .select("*", { count: "exact", head: true });
    totalQuery = applyDateFilter(totalQuery);
    const { count: totalBookings } = await totalQuery;

    // Today's bookings
    const { count: todayBookings } = await supabase
      .from("bookings")
      .select("*", { count: "exact", head: true })
      .gte("created_at", today.toISOString())
      .lt("created_at", tomorrow.toISOString());

    // This week's bookings
    const { count: weekBookings } = await supabase
      .from("bookings")
      .select("*", { count: "exact", head: true })
      .gte("created_at", weekStart.toISOString());

    // This month's bookings
    const { count: monthBookings } = await supabase
      .from("bookings")
      .select("*", { count: "exact", head: true })
      .gte("created_at", monthStart.toISOString());

    // Total revenue (filtered)
    let revenueQuery = supabase
      .from("bookings")
      .select("grand_total")
      .eq("status", "confirmed");
    revenueQuery = applyDateFilter(revenueQuery);
    const { data: revenueData } = await revenueQuery;

    const totalRevenue = revenueData?.reduce(
      (sum, b) => sum + (parseFloat(b.grand_total) || 0),
      0
    ) || 0;

    // Today's revenue
    const { data: todayRevenueData } = await supabase
      .from("bookings")
      .select("grand_total")
      .eq("status", "confirmed")
      .gte("created_at", today.toISOString())
      .lt("created_at", tomorrow.toISOString());

    const todayRevenue = todayRevenueData?.reduce(
      (sum, b) => sum + (parseFloat(b.grand_total) || 0),
      0
    ) || 0;

    // This week's revenue
    const { data: weekRevenueData } = await supabase
      .from("bookings")
      .select("grand_total")
      .eq("status", "confirmed")
      .gte("created_at", weekStart.toISOString());

    const weekRevenue = weekRevenueData?.reduce(
      (sum, b) => sum + (parseFloat(b.grand_total) || 0),
      0
    ) || 0;

    // This month's revenue
    const { data: monthRevenueData } = await supabase
      .from("bookings")
      .select("grand_total")
      .eq("status", "confirmed")
      .gte("created_at", monthStart.toISOString());

    const monthRevenue = monthRevenueData?.reduce(
      (sum, b) => sum + (parseFloat(b.grand_total) || 0),
      0
    ) || 0;

    // Confirmed vs cancelled (filtered)
    let confirmedQuery = supabase
      .from("bookings")
      .select("*", { count: "exact", head: true })
      .eq("status", "confirmed");
    confirmedQuery = applyDateFilter(confirmedQuery);
    const { count: confirmedBookings } = await confirmedQuery;

    let cancelledQuery = supabase
      .from("bookings")
      .select("*", { count: "exact", head: true })
      .eq("status", "cancelled");
    cancelledQuery = applyDateFilter(cancelledQuery);
    const { count: cancelledBookings } = await cancelledQuery;

    return NextResponse.json({
      bookings: {
        total: totalBookings || 0,
        today: todayBookings || 0,
        thisWeek: weekBookings || 0,
        thisMonth: monthBookings || 0,
        confirmed: confirmedBookings || 0,
        cancelled: cancelledBookings || 0,
      },
      revenue: {
        total: totalRevenue,
        today: todayRevenue,
        thisWeek: weekRevenue,
        thisMonth: monthRevenue,
      },
    });
  } catch (error) {
    console.error("Admin stats error:", error);
    return NextResponse.json(
      { error: "Failed to fetch stats" },
      { status: 500 }
    );
  }
}
