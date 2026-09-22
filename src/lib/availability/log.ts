/**
 * Availability logging — record which airports sell out, and when.
 *
 * The sold-out signal is computed on every parking search (ResLab
 * reservation.sold_out / available_spots, read in searchParking) and then
 * discarded when unavailable lots are filtered out of the response. ResLab has
 * no history endpoint, so a day we don't record is a day we can never know
 * about. This writes it down.
 *
 * Contract: this is BEST-EFFORT and must never cost a search.
 *   - never awaited by the caller;
 *   - never throws — including when migration 025 has not been applied yet and
 *     the table or its columns don't exist;
 *   - a no-op during `next build` — see the NEXT_PHASE check below;
 *   - warns at most once per process, and reports to Sentry at most once per
 *     process-hour, so a missing table doesn't flood logs or the alert inbox.
 *
 * See supabase/migrations/025_availability_log.sql.
 */

import { after } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { captureAPIError } from "@/lib/sentry";

export type AvailabilitySource = "search" | "chat" | "airport-page";

/** One lot, as it looked for one search. Mirrors the availability_log columns. */
export interface AvailabilityRow {
  airport_code: string;
  /** YYYY-MM-DD */
  check_in: string;
  /** YYYY-MM-DD */
  check_out: string;
  /** check_in minus the search date (in the airport's local timezone), in days. */
  lead_days: number;
  stay_days: number;
  reslab_location_id: number;
  /** ResLab omits this on some responses — null rather than a fabricated false. */
  sold_out: boolean | null;
  available_spots: number | null;
  /** reservation.grand_total in cents; null when the lot didn't price. */
  grand_total_cents: number | null;
  source: AvailabilitySource;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whole days between two YYYY-MM-DD dates, UTC. Returns 0 on an unparseable
 * input rather than NaN — the columns are NOT NULL int and a NaN would fail the
 * insert (silently, since we swallow errors), losing the whole batch.
 */
export function dayDiff(fromDate: string, toDate: string): number {
  const from = Date.parse(`${fromDate}T00:00:00Z`);
  const to = Date.parse(`${toDate}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return 0;
  return Math.round((to - from) / DAY_MS);
}

/** Today in UTC as YYYY-MM-DD — the baseline for lead_days when no timezone is known. */
export function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Today as YYYY-MM-DD in `timeZone` (an IANA zone, e.g. an airport's local
 * timezone). A US evening search is still "today" in New York but already
 * "tomorrow" in UTC — using utcToday() for lead_days systematically
 * under-counts by a day for evening searches. Falls back to UTC if the zone
 * is invalid rather than throwing.
 */
export function localToday(timeZone: string): string {
  try {
    // en-CA formats as YYYY-MM-DD, so no manual reassembly is needed.
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
  } catch {
    return utcToday();
  }
}

// One console warning per process — the expected failure is "table doesn't
// exist yet", which would otherwise warn on every single search until 025 is
// applied. Sentry is separate: warnOnce alone means a permanently broken
// insert (bad column, revoked grant) never surfaces past a log line nobody
// reads, so we also report once per process-hour, mirroring
// lastBackoffReportAt in reslab/search.ts.
let warned = false;
let lastReportedAt: number | null = null;
const REPORT_INTERVAL_MS = 60 * 60 * 1000;

function warnOnce(detail: unknown): void {
  const err = detail instanceof Error ? detail : new Error(String(detail));
  if (!warned) {
    warned = true;
    console.warn("[availability] logging disabled for this process — insert failed:", err.message);
  }
  const now = Date.now();
  if (lastReportedAt === null || now - lastReportedAt >= REPORT_INTERVAL_MS) {
    lastReportedAt = now;
    captureAPIError(err, { endpoint: "availability_log.insert", method: "INSERT" });
  }
}

/** Test seam — reset module-level warn/report state between cases. */
export function __resetAvailabilityLogWarnStateForTests(): void {
  warned = false;
  lastReportedAt = null;
}

/**
 * Fire-and-forget insert of one search's worth of rows. Returns immediately;
 * the caller must not await it.
 */
export function logAvailability(rows: AvailabilityRow[]): void {
  if (rows.length === 0) return;
  // Every Vercel build of every branch runs generateStaticParams → after() at
  // build time, with the service-role key injected — without this guard every
  // build of every branch would write into the (real, production) table.
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  // Kill switch for an incident or a load test. Vercel env var changes don't
  // reach already-running deployments, so this needs a redeploy, not just a
  // flip in the dashboard.
  if (process.env.AVAILABILITY_LOG_DISABLED === "1") return;
  // Sampling, if volume ever demands it, goes HERE — drop a share of rows (or
  // of whole searches) before the insert. Deliberately not sampling today:
  // /api/search is CDN-cached 300s so origin search volume is modest, and a
  // sampled log answers "was it sold out?" much less crisply than a full one.

  const env = process.env.NEXT_PUBLIC_APP_ENV || "unknown";
  // One id per call (i.e. per search), shared by every row it writes — lets
  // the view count DISTINCT search_id instead of DISTINCT searched_at, which
  // is exact even if a future retry writes two transactions for one search.
  const searchId = crypto.randomUUID();
  const insertRows = rows.map((row) => ({ ...row, env, search_id: searchId }));

  const insert = async () => {
    try {
      const supabase = await createAdminClient();
      const { error } = await supabase
        .from("availability_log")
        .insert(insertRows)
        // ISR/build-time callers must not hang on a slow or wedged insert.
        .abortSignal(AbortSignal.timeout(3000));
      // supabase-js reports failures in `error` rather than throwing, so the
      // missing-table / missing-column case lands here, not in the catch.
      if (error) warnOnce(error.message || error);
    } catch (err) {
      // Anything else: no service-role key, network, a thrown client, the
      // abort timeout firing. Telemetry is never worth an exception on the
      // customer's path.
      warnOnce(err);
    }
  };

  // On Vercel a dangling promise can be cut off the moment the response is
  // sent. `after()` keeps the function alive until the insert settles, without
  // delaying the response. It throws when called outside a request scope (unit
  // tests, scripts) — fall back to plain fire-and-forget there.
  try {
    after(insert);
  } catch {
    void insert();
  }
}
