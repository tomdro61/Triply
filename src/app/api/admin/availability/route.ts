/**
 * GET /api/admin/availability — the daily sold-out rollup.
 *
 * Reads the availability_daily view (migration 024): one row per
 * airport × travel date × day-we-looked, with how many lots we saw and how many
 * were sold out. Last 30 days of observations, newest and most-sold-out first.
 *
 * Query: ?airport=LAS to scope to one airport.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { isAdminEmail } from "@/config/admin";
import { captureAPIError } from "@/lib/sentry";

const LOOKBACK_DAYS = 30;
const ROW_LIMIT = 2000;

export async function GET(request: NextRequest) {
  try {
    // Auth check (same pattern as /api/admin/stats)
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

    const airport = new URL(request.url).searchParams.get("airport");
    const since = new Date(
      Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000
    ).toISOString();

    const supabase = await createAdminClient();
    let query = supabase
      .from("availability_daily")
      .select("airport_code, check_in, day, searches, lots_seen, lots_sold_out, pct_sold_out")
      .gte("day", since)
      .order("day", { ascending: false })
      .order("pct_sold_out", { ascending: false })
      .limit(ROW_LIMIT);
    if (airport) query = query.eq("airport_code", airport.toUpperCase());

    const { data, error } = await query;
    // The view doesn't exist until migration 024 is applied — report it as an
    // empty rollup with a note rather than a 500, so the dashboard degrades
    // the same way the logger does.
    if (error) {
      return NextResponse.json({
        days: [],
        note: `availability_daily unavailable: ${error.message}`,
      });
    }

    return NextResponse.json({ days: data ?? [], lookbackDays: LOOKBACK_DAYS });
  } catch (error) {
    captureAPIError(error instanceof Error ? error : new Error(String(error)), {
      endpoint: "/api/admin/availability",
      method: "GET",
    });
    return NextResponse.json(
      { error: "Failed to fetch availability" },
      { status: 500 }
    );
  }
}
