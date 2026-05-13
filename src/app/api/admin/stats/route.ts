import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { isAdminEmail, ADMIN_EMAILS } from "@/config/admin";
import { captureAPIError, captureBookingError } from "@/lib/sentry";
import { PROTECTION_PLAN } from "@/lib/parkguard/client";

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

    // Test-booking exclusion: bookings tied to a customer whose email is
    // in ADMIN_EMAILS (vin/john/tom@triplypro.com) are treated as test
    // traffic and excluded from every metric on this dashboard so the
    // numbers reflect real customer activity. Empty list (no admin
    // customers in the table yet) → no filter applied.
    const { data: adminCustomersRow } = await supabase
      .from("customers")
      .select("id")
      .in("email", ADMIN_EMAILS);
    const adminCustomerIds = (adminCustomersRow ?? []).map((c) => c.id);
    const notAdminFilter =
      adminCustomerIds.length > 0
        ? `(${adminCustomerIds.join(",")})`
        : null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const excludeAdmins = (query: any) =>
      notAdminFilter ? query.not("customer_id", "in", notAdminFilter) : query;

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
      excludeAdmins(applyDateFilter(
        supabase.from("bookings").select("*", { count: "exact", head: true })
      )),
      // Today's bookings
      excludeAdmins(supabase
        .from("bookings")
        .select("*", { count: "exact", head: true })
        .gte("created_at", today.toISOString())
        .lt("created_at", tomorrow.toISOString())),
      // This week's bookings
      excludeAdmins(supabase
        .from("bookings")
        .select("*", { count: "exact", head: true })
        .gte("created_at", weekStart.toISOString())),
      // This month's bookings
      excludeAdmins(supabase
        .from("bookings")
        .select("*", { count: "exact", head: true })
        .gte("created_at", monthStart.toISOString())),
      // Total revenue (filtered)
      excludeAdmins(applyDateFilter(
        supabase.from("bookings").select("grand_total, triply_service_fee, protection_plan_price, protection_plan").eq("status", "confirmed")
      )),
      // Today's revenue
      excludeAdmins(supabase
        .from("bookings")
        .select("grand_total, triply_service_fee, protection_plan_price, protection_plan")
        .eq("status", "confirmed")
        .gte("created_at", today.toISOString())
        .lt("created_at", tomorrow.toISOString())),
      // This week's revenue
      excludeAdmins(supabase
        .from("bookings")
        .select("grand_total, triply_service_fee, protection_plan_price, protection_plan")
        .eq("status", "confirmed")
        .gte("created_at", weekStart.toISOString())),
      // This month's revenue
      excludeAdmins(supabase
        .from("bookings")
        .select("grand_total, triply_service_fee, protection_plan_price, protection_plan")
        .eq("status", "confirmed")
        .gte("created_at", monthStart.toISOString())),
      // Confirmed bookings (filtered)
      excludeAdmins(applyDateFilter(
        supabase.from("bookings").select("*", { count: "exact", head: true }).eq("status", "confirmed")
      )),
      // Cancelled bookings (filtered)
      excludeAdmins(applyDateFilter(
        supabase.from("bookings").select("*", { count: "exact", head: true }).eq("status", "cancelled")
      )),
    ]);

    type RevenueRow = {
      grand_total: string;
      triply_service_fee: string | null;
      protection_plan_price: string | null;
      protection_plan?: string | null;
    };
    // Surface rows where protection_plan is set but the price is missing
    // or non-positive — the customer was charged but our totals would
    // silently render $0 for that line item. Migration 011 blocks new
    // such rows; this catches legacy dirty data still in the DB.
    const flagDirtyProtection = (data: RevenueRow[] | null) => {
      if (!data) return;
      const dirty = data.filter((b) => {
        if (!b.protection_plan) return false;
        const parsed = parseFloat(b.protection_plan_price ?? "");
        return !Number.isFinite(parsed) || parsed <= 0;
      });
      if (dirty.length > 0) {
        captureBookingError(
          new Error(
            `Admin stats: ${dirty.length} booking(s) with protection_plan set but invalid protection_plan_price — revenue under-counted`
          ),
          { step: "checkout" }
        );
      }
    };
    const sumGross = (data: RevenueRow[] | null) =>
      data?.reduce(
        (sum, b) =>
          sum +
          (parseFloat(b.grand_total) || 0) +
          (parseFloat(b.triply_service_fee || "0") || 0) +
          (parseFloat(b.protection_plan_price || "0") || 0),
        0
      ) || 0;

    // Run the dirty-row scan ONCE per request against the broadest data set.
    // Calling inside sumGross would fire up to 4 alerts per request for the
    // same row (revenueResult / today / week / month all overlap).
    flagDirtyProtection(revenueResult.data);
    const sumTriply = (data: RevenueRow[] | null) =>
      data?.reduce((sum, b) => sum + (parseFloat(b.triply_service_fee || "0") || 0), 0) || 0;

    // Park Guard conversion metrics. A row counts as a PG opt-in when
    // protection_plan is set on a confirmed booking.
    //
    // Revenue: sum per-row protection_plan_price so historical bookings
    // taken at an earlier price (e.g., $9.99) stay reported at what was
    // actually charged when the price changes ($12.99 going forward).
    // Cost: count × PROTECTION_PLAN.wholesalePrice — PG bills Triply a
    // fixed amount per opt-in regardless of retail price.
    // Margin: revenue - cost.
    const countProtected = (data: RevenueRow[] | null) =>
      data?.reduce((n, b) => n + (b.protection_plan ? 1 : 0), 0) || 0;
    const sumProtectionRevenue = (data: RevenueRow[] | null) =>
      data?.reduce((sum, b) => {
        if (!b.protection_plan) return sum;
        const parsed = parseFloat(b.protection_plan_price ?? "0");
        return sum + (Number.isFinite(parsed) ? parsed : 0);
      }, 0) || 0;
    const pgCount = {
      total: countProtected(revenueResult.data),
      today: countProtected(todayRevenueResult.data),
      thisWeek: countProtected(weekRevenueResult.data),
      thisMonth: countProtected(monthRevenueResult.data),
    };
    const confirmedTotals = {
      total: revenueResult.data?.length || 0,
      today: todayRevenueResult.data?.length || 0,
      thisWeek: weekRevenueResult.data?.length || 0,
      thisMonth: monthRevenueResult.data?.length || 0,
    };
    const conversionRate = (count: number, total: number) =>
      total === 0 ? 0 : count / total;
    const pgRevenueAll = sumProtectionRevenue(revenueResult.data);
    const pgRevenueToday = sumProtectionRevenue(todayRevenueResult.data);
    const pgRevenueWeek = sumProtectionRevenue(weekRevenueResult.data);
    const pgRevenueMonth = sumProtectionRevenue(monthRevenueResult.data);
    const pgCost = (n: number) => n * PROTECTION_PLAN.wholesalePrice;

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
        gross: {
          total: sumGross(revenueResult.data),
          today: sumGross(todayRevenueResult.data),
          thisWeek: sumGross(weekRevenueResult.data),
          thisMonth: sumGross(monthRevenueResult.data),
        },
        triply: {
          total: sumTriply(revenueResult.data),
          today: sumTriply(todayRevenueResult.data),
          thisWeek: sumTriply(weekRevenueResult.data),
          thisMonth: sumTriply(monthRevenueResult.data),
        },
      },
      parkGuard: {
        count: pgCount,
        confirmedTotal: confirmedTotals,
        conversionRate: {
          total: conversionRate(pgCount.total, confirmedTotals.total),
          today: conversionRate(pgCount.today, confirmedTotals.today),
          thisWeek: conversionRate(pgCount.thisWeek, confirmedTotals.thisWeek),
          thisMonth: conversionRate(pgCount.thisMonth, confirmedTotals.thisMonth),
        },
        revenue: {
          total: pgRevenueAll,
          today: pgRevenueToday,
          thisWeek: pgRevenueWeek,
          thisMonth: pgRevenueMonth,
        },
        cost: {
          total: pgCost(pgCount.total),
          today: pgCost(pgCount.today),
          thisWeek: pgCost(pgCount.thisWeek),
          thisMonth: pgCost(pgCount.thisMonth),
        },
        margin: {
          total: pgRevenueAll - pgCost(pgCount.total),
          today: pgRevenueToday - pgCost(pgCount.today),
          thisWeek: pgRevenueWeek - pgCost(pgCount.thisWeek),
          thisMonth: pgRevenueMonth - pgCost(pgCount.thisMonth),
        },
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
