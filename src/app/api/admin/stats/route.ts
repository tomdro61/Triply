import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { isAdminEmail, TEST_RESLAB_LOCATION_IDS } from "@/config/admin";
import { captureAPIError, captureBookingError } from "@/lib/sentry";
import { parseMoneyColumn } from "@/lib/utils/money";
import {
  buildPromoReport,
  byAirport,
  byChannel,
  presentRate,
  type PromoMeta,
  type ReportRow,
} from "@/lib/attribution/report";

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

    // Test-booking exclusion (aligned with /api/admin/accounting and
    // src/config/admin.ts:isTestBooking semantics, 2026-06-01):
    // A booking is "test" iff it's against a TEST ResLab lot id (194/195/
    // 196/197). Admin-email bookings at REAL airport lots are NOT excluded
    // — that conflation previously hid legitimate revenue.
    // Empty TEST_RESLAB_LOCATION_IDS → no filter applied.
    const testLotIds = [...TEST_RESLAB_LOCATION_IDS];
    const notTestLotFilter =
      testLotIds.length > 0 ? `(${testLotIds.join(",")})` : null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const excludeAdmins = (query: any) =>
      notTestLotFilter ? query.not("reslab_location_id", "in", notTestLotFilter) : query;

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
        supabase.from("bookings").select("grand_total, triply_service_fee, protection_plan_price, protection_plan, protection_plan_wholesale").eq("status", "confirmed")
      )),
      // Today's revenue
      excludeAdmins(supabase
        .from("bookings")
        .select("grand_total, triply_service_fee, protection_plan_price, protection_plan, protection_plan_wholesale")
        .eq("status", "confirmed")
        .gte("created_at", today.toISOString())
        .lt("created_at", tomorrow.toISOString())),
      // This week's revenue
      excludeAdmins(supabase
        .from("bookings")
        .select("grand_total, triply_service_fee, protection_plan_price, protection_plan, protection_plan_wholesale")
        .eq("status", "confirmed")
        .gte("created_at", weekStart.toISOString())),
      // This month's revenue
      excludeAdmins(supabase
        .from("bookings")
        .select("grand_total, triply_service_fee, protection_plan_price, protection_plan, protection_plan_wholesale")
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
      /** Per-row PG wholesale snapshotted at fulfilment (migration 021). */
      protection_plan_wholesale: string | null;
    };
    // Surface rows where protection_plan is set but the price is missing
    // or non-positive — the customer was charged but our totals would
    // silently render $0 for that line item. Migration 011 blocks new
    // such rows; this catches legacy dirty data still in the DB.
    const flagDirtyProtection = (data: RevenueRow[] | null) => {
      if (!data) return;
      let dirtyPrice = 0;
      // Same class for the wholesale column: a plan row with no wholesale is a
      // deploy-window row written before migration 022's repair; it counts $0
      // cost below, so margin is OVER-stated until repaired.
      let dirtyWholesale = 0;
      for (const b of data) {
        if (!b.protection_plan) continue;
        if (!(parseMoneyColumn(b.protection_plan_price) > 0)) dirtyPrice++;
        if (!(parseMoneyColumn(b.protection_plan_wholesale) > 0)) dirtyWholesale++;
      }
      if (dirtyPrice > 0) {
        captureBookingError(
          new Error(
            `Admin stats: ${dirtyPrice} booking(s) with protection_plan set but invalid protection_plan_price — revenue under-counted`
          ),
          { step: "checkout" }
        );
      }
      if (dirtyWholesale > 0) {
        captureBookingError(
          new Error(
            `Admin stats: ${dirtyWholesale} booking(s) with protection_plan set but no protection_plan_wholesale — PG cost under-counted (repair per migration 022)`
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
    // taken at a different retail price stay reported at what was actually
    // charged. The current retail prices live in PROTECTION_PLANS[code].price
    // (src/lib/parkguard/client.ts) — do NOT substitute it here.
    // Cost: sum per-row protection_plan_wholesale (migration 021 — $6 / $4 /
    // $2 by tier, snapshotted at fulfilment) so a mixed-tier month and any
    // historical contract change both report what PG actually bills.
    // Margin: revenue - cost.
    const countProtected = (data: RevenueRow[] | null) =>
      data?.reduce((n, b) => n + (b.protection_plan ? 1 : 0), 0) || 0;
    // Σ of a per-row PG money column over opt-ins (price → revenue, wholesale →
    // cost). Garbage/null counts 0 and is surfaced by flagDirtyProtection.
    const sumProtectionColumn = (
      data: RevenueRow[] | null,
      key: "protection_plan_price" | "protection_plan_wholesale"
    ) =>
      data?.reduce(
        (sum, b) => (b.protection_plan ? sum + parseMoneyColumn(b[key]) : sum),
        0
      ) || 0;
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
    const pgRevenueAll = sumProtectionColumn(revenueResult.data, "protection_plan_price");
    const pgRevenueToday = sumProtectionColumn(todayRevenueResult.data, "protection_plan_price");
    const pgRevenueWeek = sumProtectionColumn(weekRevenueResult.data, "protection_plan_price");
    const pgRevenueMonth = sumProtectionColumn(monthRevenueResult.data, "protection_plan_price");
    const pgCostAll = sumProtectionColumn(revenueResult.data, "protection_plan_wholesale");
    const pgCostToday = sumProtectionColumn(todayRevenueResult.data, "protection_plan_wholesale");
    const pgCostWeek = sumProtectionColumn(weekRevenueResult.data, "protection_plan_wholesale");
    const pgCostMonth = sumProtectionColumn(monthRevenueResult.data, "protection_plan_wholesale");

    // --- Attribution / airport / promo breakdowns (migration 023) -----------
    // Reporting only: a failure here must NEVER take the dashboard's booking
    // counts and revenue down with it. Each query captures its error and the
    // response carries `warnings` the page renders as "unavailable" — never a
    // silent empty state that reads like "no bookings".
    const warnings: string[] = [];
    const warn = (what: string, err: { message: string }) => {
      warnings.push(what);
      captureAPIError(new Error(`Admin stats attribution: ${what}: ${err.message}`), {
        endpoint: "/api/admin/stats",
        method: "GET",
      });
    };

    // PostgREST silently caps a select at 1000 rows, so page with .range()
    // until a short page. `id` breaks created_at ties so page boundaries are
    // stable across separate OFFSET queries.
    const PAGE = 1000;
    const attrRows: ReportRow[] = [];
    let attrRowsComplete = true;
    for (let from = 0; ; from += PAGE) {
      const { data, error: pageError } = await excludeAdmins(
        applyDateFilter(
          supabase
            .from("bookings")
            .select(
              "channel, attribution, airport_code, promo_code, discount_amount, grand_total, triply_service_fee, protection_plan, protection_plan_price, status, created_at"
            )
        )
      )
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, from + PAGE - 1);
      if (pageError) {
        warn("bookings breakdown fetch failed", pageError);
        attrRowsComplete = false;
        break;
      }
      const page = (data ?? []) as ReportRow[];
      attrRows.push(...page);
      if (page.length < PAGE) break;
    }

    const { data: promoRows, error: promoError } = await supabase
      .from("promo_codes")
      .select("code, discount_percent, active, current_uses, max_uses, expires_at");
    if (promoError) warn("promo_codes fetch failed", promoError);

    // Capture health over the last 7 days, independent of the date filter on
    // purpose (it is a regression alarm, not a report). Only a VALID cookie
    // counts as present; the invalid marker is reported separately.
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { data: recent, error: recentError } = await excludeAdmins(
      supabase.from("bookings").select("attribution").gte("created_at", sevenDaysAgo).limit(1000)
    );
    if (recentError) warn("7-day capture-rate fetch failed", recentError);
    const health = presentRate(
      (recent ?? []) as Array<{ attribution: ReportRow["attribution"] }>
    );

    const airports = byAirport(attrRows);

    return NextResponse.json({
      attribution: attrRowsComplete
        ? {
            byChannel: byChannel(attrRows),
            byAirport: airports.rows,
            byAirportTotal: airports.total,
            byPromo: promoError ? null : buildPromoReport(attrRows, (promoRows ?? []) as PromoMeta[]),
            presentRate7d: recentError ? null : health.presentRate,
            invalidRate7d: recentError ? null : health.invalidRate,
            recentBookings7d: recentError ? null : health.total,
            warnings,
          }
        : null,
      attributionWarnings: warnings,
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
          total: pgCostAll,
          today: pgCostToday,
          thisWeek: pgCostWeek,
          thisMonth: pgCostMonth,
        },
        margin: {
          total: pgRevenueAll - pgCostAll,
          today: pgRevenueToday - pgCostToday,
          thisWeek: pgRevenueWeek - pgCostWeek,
          thisMonth: pgRevenueMonth - pgCostMonth,
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
