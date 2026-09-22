/**
 * GET /api/admin/availability — the daily sold-out rollup.
 *
 * Reads the availability_daily view (migration 025): one row per
 * airport × travel date × day-we-looked × source, with how many lots we saw,
 * how many we actually know the status of, and how many were sold out. Last
 * 30 days of observations, newest and most-sold-out first.
 *
 * Also returns `writer`: the unfiltered health of the logger per env × source
 * over the last 7 days (with 24 h activity counts), plus `note`s derived from
 * it. The rollup only aggregates env = 'production', so on its own an empty
 * rollup cannot say whether nothing sold out, nothing was written, everything
 * was written under the wrong env tag, or only the airport-page ISR path is
 * writing. `writer` makes that attributable — and it is the only read that
 * works on staging, where the rollup is empty by design.
 *
 * Query:
 *   ?airport=LAS      scope to one airport
 *   ?source=all       include airport-page ISR renders (default: search + chat
 *                     only — an airport page revalidates on a fixed +1d/+8d
 *                     window regardless of whether anyone visits, so counting
 *                     it as a "search" wildly overstates real demand)
 *   ?source=<one>     exactly one of search | chat | airport-page
 *
 * Note: no admin UI consumes this route yet.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { isAdminEmail } from "@/config/admin";
import { captureAPIError } from "@/lib/sentry";

export const dynamic = "force-dynamic";

const LOOKBACK_DAYS = 30;
const ROW_LIMIT = 2000;
const ORGANIC_SOURCES = ["search", "chat"] as const;
const ALL_SOURCES = ["search", "chat", "airport-page"] as const;
type Source = (typeof ALL_SOURCES)[number];

/**
 * Errors that mean "migration 025 hasn't been applied here (or PostgREST's
 * schema cache hasn't caught up with it yet)". PostgREST reports a relation it
 * cannot find as PGRST205 ("Could not find the table ... in the schema cache"),
 * NOT the Postgres SQLSTATE 42P01 — the SQLSTATE only surfaces from a direct
 * connection. Match both so a direct-connection client behaves the same.
 */
function isMissingRelationError(error: { code?: string; message?: string }): boolean {
  return error.code === "PGRST205" || error.code === "42P01";
}

// A missing view is expected until 025 is applied, so it returns 200 with a
// note — but it must still reach Sentry, throttled, or a view that got dropped
// six months from now reads as "nothing is selling out" forever.
let lastMissingReportAt: number | null = null;
const MISSING_REPORT_INTERVAL_MS = 60 * 60 * 1000;
function reportMissingRelationOnce(message: string): void {
  const now = Date.now();
  if (lastMissingReportAt !== null && now - lastMissingReportAt < MISSING_REPORT_INTERVAL_MS) return;
  lastMissingReportAt = now;
  captureAPIError(new Error(`availability_daily unavailable: ${message}`), {
    endpoint: "/api/admin/availability",
    method: "GET",
  });
}

function parseSource(raw: string | null): "all" | Source | "default" {
  if (raw === null) return "default";
  if (raw === "all") return "all";
  return (ALL_SOURCES as readonly string[]).includes(raw) ? (raw as Source) : "default";
}

interface WriterHealthRow {
  env: string;
  source: string;
  last_row_at: string | null;
  rows_24h: number;
  searches_24h: number;
  rows_7d: number;
}

/** What the rollup should look like given what the writer wrote. */
function writerNotes(
  writer: WriterHealthRow[],
  rollupRowCount: number,
  requestedSources: readonly string[] | null
): string[] {
  const notes: string[] = [];
  const recent = writer.filter((w) => w.rows_24h > 0);
  const prodRecent = recent.filter((w) => w.env === "production");
  if (recent.length === 0) {
    const stale = writer.filter((w) => w.rows_7d > 0);
    notes.push(
      stale.length > 0
        ? `no rows written by any env in the last 24h (last row ${stale
            .map((w) => `${w.env}/${w.source} ${w.last_row_at}`)
            .join(", ")}) — the logger may be disabled (AVAILABILITY_LOG_DISABLED), failing (Sentry availability_log.insert), or dropping rows (Sentry availability_log.guard)`
        : "no rows written by any env in the last 7 days — the logger may be disabled (AVAILABILITY_LOG_DISABLED), failing (Sentry availability_log.insert), dropping rows (Sentry availability_log.guard), or the table is empty"
    );
    return notes;
  }
  if (prodRecent.length === 0) {
    notes.push(
      `no production rows in the last 24h but ${recent.map((w) => `${w.env}/${w.source}`).join(", ")} are writing — check NEXT_PUBLIC_APP_ENV / VERCEL_ENV on the production deployment`
    );
    return notes;
  }
  const prodSources = new Set(prodRecent.map((w) => w.source));
  if (!prodSources.has("search")) {
    notes.push(
      `production rows exist only from ${[...prodSources].join(", ")} — /api/search is not reaching the logger`
    );
  }
  if (
    rollupRowCount === 0 &&
    requestedSources !== null &&
    !requestedSources.some((s) => prodSources.has(s))
  ) {
    notes.push(
      `rollup is empty for source=${requestedSources.join("+")} while production rows exist for ${[...prodSources].join(", ")}`
    );
  }
  return notes;
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
    const sourceParam = params.get("source");
    const source = parseSource(sourceParam);
    // `day` in the view is a UTC-day-truncated naive timestamp; compare it to a
    // calendar date so the oldest bucket is included (a mid-day instant would
    // exclude it and silently make a 30-day lookback 29 days + today).
    const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);

    const supabase = await createAdminClient();
    let query = supabase
      .from("availability_daily")
      .select(
        "airport_code, check_in, day, source, origin_searches, lots_seen, lots_known, lots_unknown, lots_sold_out, lots_unsellable, pct_sold_out"
      )
      .gte("day", since)
      .order("day", { ascending: false })
      .order("pct_sold_out", { ascending: false, nullsFirst: false })
      // Ask for one more row than the limit so we can tell "exactly at the
      // limit" apart from "truncated" without a second count query.
      .limit(ROW_LIMIT + 1);
    if (airport) query = query.eq("airport_code", airport.toUpperCase());
    if (source === "default") query = query.in("source", [...ORGANIC_SOURCES]);
    else if (source !== "all") query = query.eq("source", source);

    // Writer health is read regardless of env so an empty rollup is
    // attributable. Its own failure is reported but never fails the rollup —
    // a rejection (not just an { error }) from it is caught here so it cannot
    // reach the outer catch and 500 a perfectly good rollup.
    const [rollup, health] = await Promise.all([
      query,
      supabase
        .from("availability_writer_health")
        .select("env, source, last_row_at, rows_24h, searches_24h, rows_7d")
        .order("env")
        .order("source")
        .then(
          (r) => r,
          (e: unknown) => ({
            data: null,
            error: { message: e instanceof Error ? e.message : String(e), code: undefined as string | undefined },
          })
        ),
    ]);

    const notes: string[] = [];
    if (sourceParam !== null && source === "default") {
      notes.push(`unknown source "${sourceParam}" ignored; showing search + chat`);
    }

    if (rollup.error) {
      // The view doesn't exist until migration 025 is applied — report it as
      // an empty rollup with a note rather than a 500, so the dashboard
      // degrades the same way the logger does. Any other DB error (bad grant,
      // connection failure, a view missing a column) is a real failure and
      // must not be silently swallowed into a 200.
      if (isMissingRelationError(rollup.error)) {
        reportMissingRelationOnce(rollup.error.message);
        return NextResponse.json({
          days: [],
          lookbackDays: LOOKBACK_DAYS,
          truncated: false,
          writer: null,
          note: [`availability_daily unavailable: ${rollup.error.message}`, ...notes].join("; "),
        });
      }
      captureAPIError(new Error(rollup.error.message), {
        endpoint: "/api/admin/availability",
        method: "GET",
      });
      return NextResponse.json(
        { error: "Failed to fetch availability" },
        { status: 500 }
      );
    }

    let writer: WriterHealthRow[] | null = null;
    if (health.error) {
      notes.push(`writer health unavailable: ${health.error.message}`);
      if (!isMissingRelationError(health.error)) {
        captureAPIError(new Error(`availability_writer_health: ${health.error.message}`), {
          endpoint: "/api/admin/availability",
          method: "GET",
        });
      }
    }

    const rows = rollup.data ?? [];
    const truncated = rows.length > ROW_LIMIT;

    if (!health.error) {
      writer = (health.data ?? []) as WriterHealthRow[];
      const requested =
        source === "all" ? null : source === "default" ? ORGANIC_SOURCES : [source];
      notes.push(...writerNotes(writer, rows.length, requested));
    }

    return NextResponse.json({
      days: truncated ? rows.slice(0, ROW_LIMIT) : rows,
      lookbackDays: LOOKBACK_DAYS,
      truncated,
      writer,
      ...(notes.length > 0 ? { note: notes.join("; ") } : {}),
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
