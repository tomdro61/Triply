import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { isAdminEmail } from "@/config/admin";
import { captureAPIError } from "@/lib/sentry";

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

    const supabase = await createAdminClient();

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

    // Run all queries in parallel (R7)
    const [
      totalResult,
      todayResult,
      weekResult,
      monthResult,
      revenueResult,
      todayRevenueResult,
      weekRevenueResult,
      monthRevenueResult,
      confirmedResult,
      cancelledResult,
    ] = await Promise.all([
      // Total bookings (filtered)
      applyDateFilter(
        supabase.from("bookings").select("*", { count: "exact", head: true })
      ),
      // Today's bookings
      supabase
        .from("bookings")
        .select("*", { count: "exact", head: true })
        .gte("created_at", today.toISOString())
        .lt("created_at", tomorrow.toISOString()),
      // This week's bookings
      supabase
        .from("bookings")
        .select("*", { count: "exact", head: true })
        .gte("created_at", weekStart.toISOString()),
      // This month's bookings
      supabase
        .from("bookings")
        .select("*", { count: "exact", head: true })
        .gte("created_at", monthStart.toISOString()),
      // Total revenue (filtered)
      applyDateFilter(
        supabase.from("bookings").select("grand_total").eq("status", "confirmed")
      ),
      // Today's revenue
      supabase
        .from("bookings")
        .select("grand_total")
        .eq("status", "confirmed")
        .gte("created_at", today.toISOString())
        .lt("created_at", tomorrow.toISOString()),
      // This week's revenue
      supabase
        .from("bookings")
        .select("grand_total")
        .eq("status", "confirmed")
        .gte("created_at", weekStart.toISOString()),
      // This month's revenue
      supabase
        .from("bookings")
        .select("grand_total")
        .eq("status", "confirmed")
        .gte("created_at", monthStart.toISOString()),
      // Confirmed bookings (filtered)
      applyDateFilter(
        supabase.from("bookings").select("*", { count: "exact", head: true }).eq("status", "confirmed")
      ),
      // Cancelled bookings (filtered)
      applyDateFilter(
        supabase.from("bookings").select("*", { count: "exact", head: true }).eq("status", "cancelled")
      ),
    ]);

    const sumRevenue = (data: { grand_total: string }[] | null) =>
      data?.reduce((sum, b) => sum + (parseFloat(b.grand_total) || 0), 0) || 0;

    return NextResponse.json({
      bookings: {
        total: totalResult.count || 0,
        today: todayResult.count || 0,
        thisWeek: weekResult.count || 0,
        thisMonth: monthResult.count || 0,
        confirmed: confirmedResult.count || 0,
        cancelled: cancelledResult.count || 0,
      },
      revenue: {
        total: sumRevenue(revenueResult.data),
        today: sumRevenue(todayRevenueResult.data),
        thisWeek: sumRevenue(weekRevenueResult.data),
        thisMonth: sumRevenue(monthRevenueResult.data),
      },
    });
  } catch (error) {
    console.error("Admin stats error:", error);
    captureAPIError(error instanceof Error ? error : new Error(String(error)), {
      endpoint: "/api/admin/stats",
      method: "GET",
    });
    return NextResponse.json(
      { error: "Failed to fetch stats" },
      { status: 500 }
    );
  }
}
