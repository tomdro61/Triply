/**
 * GET /api/admin/availability — the daily sold-out rollup.
 *
 * Reads the availability_daily view (migration 025): one row per
 * airport × travel date × day-we-looked × source, with how many lots we saw
 * and how many were sold out. Last 30 days of observations, newest and
 * most-sold-out first.
 *
 * Query:
 *   ?airport=LAS   scope to one airport
 *   ?source=all    include airport-page ISR renders (default: search + chat
 *                  only — an airport page revalidates on a fixed +1d/+8d
 *                  window regardless of whether anyone visits, so counting it
 *                  as a "search" wildly overstates real demand)
 *
 * Note: no admin UI consumes this route yet.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { isAdminEmail } from "@/config/admin";
import { captureAPIError } from "@/lib/sentry";

const LOOKBACK_DAYS = 30;
const ROW_LIMIT = 2000;
const ORGANIC_SOURCES = ["search", "chat"];

/** Postgres errors that mean "migration 025 hasn't been applied here yet". */
function isMissingRelationError(error: { code?: string; message?: string }): boolean {
  return error.code === "42P01" || /does not exist/i.test(error.message ?? "");
}

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

    const params = new URL(request.url).searchParams;
    const airport = params.get("airport");
    const includeAllSources = params.get("source") === "all";
    const since = new Date(
      Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000
    ).toISOString();

    const supabase = await createAdminClient();
    let query = supabase
      .from("availability_daily")
      .select(
        "airport_code, check_in, day, source, searches, lots_seen, lots_sold_out, pct_sold_out"
      )
      .gte("day", since)
      .order("day", { ascending: false })
      .order("pct_sold_out", { ascending: false })
      // Ask for one more row than the limit so we can tell "exactly at the
      // limit" apart from "truncated" without a second count query.
      .limit(ROW_LIMIT + 1);
    if (airport) query = query.eq("airport_code", airport.toUpperCase());
    if (!includeAllSources) query = query.in("source", ORGANIC_SOURCES);

    const { data, error } = await query;

    if (error) {
      // The view doesn't exist until migration 025 is applied — report it as
      // an empty rollup with a note rather than a 500, so the dashboard
      // degrades the same way the logger does. Any other DB error (bad grant,
      // connection failure, real bug) is a real failure and must not be
      // silently swallowed into a 200.
      if (isMissingRelationError(error)) {
        return NextResponse.json({
          days: [],
          lookbackDays: LOOKBACK_DAYS,
          truncated: false,
          note: `availability_daily unavailable: ${error.message}`,
        });
      }
      captureAPIError(new Error(error.message), {
        endpoint: "/api/admin/availability",
        method: "GET",
      });
      return NextResponse.json(
        { error: "Failed to fetch availability" },
        { status: 500 }
      );
    }

    const rows = data ?? [];
    const truncated = rows.length > ROW_LIMIT;

    return NextResponse.json({
      days: truncated ? rows.slice(0, ROW_LIMIT) : rows,
      lookbackDays: LOOKBACK_DAYS,
      truncated,
    });
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
