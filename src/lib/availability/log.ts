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
 *     process-hour, so a missing table doesn't flood logs or the alert inbox;
 *   - drops individual rows that would violate a table CHECK rather than
 *     letting Postgres reject the whole batch (rowIsInsertable).
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
  /**
   * ResLab reservation.sold_out. null when ResLab omitted it OR when the
   * pricing call for this lot failed — "we looked and don't know" is a real
   * observation the rollup needs (it is what keeps a 1-of-12 sample from
   * reading like a census), and a fabricated false would bias the metric.
   */
  sold_out: boolean | null;
  available_spots: number | null;
  /** reservation.grand_total in cents; null when the lot didn't price. */
  grand_total_cents: number | null;
  source: AvailabilitySource;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whole days between two YYYY-MM-DD dates, UTC. Returns null on an unparseable
 * input. Callers must skip the row: for a dataset that can never be backfilled
 * a missing row is strictly better than an invented `lead_days = 0`, which
 * would read as "searched on the day of travel" — the single most consequential
 * bucket for the book-by calendar.
 */
export function dayDiff(fromDate: string, toDate: string): number | null {
  const from = Date.parse(`${fromDate}T00:00:00Z`);
  const to = Date.parse(`${toDate}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
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

/**
 * The environment tag every row carries; availability_daily aggregates
 * 'production' only. NEXT_PUBLIC_APP_ENV is the project's own setting; when
 * it is absent fall back to VERCEL_ENV, which Vercel sets on every deployment
 * (production | preview | development) — so a missing project var can no
 * longer make production rows land as 'unknown' and leave the rollup empty
 * forever with nothing to say why.
 */
export function resolveEnv(): string {
  const configured = process.env.NEXT_PUBLIC_APP_ENV;
  if (configured) return configured;
  const vercel = process.env.VERCEL_ENV;
  if (vercel === "production" || vercel === "preview" || vercel === "development") {
    return vercel;
  }
  return "unknown";
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A real calendar date in YYYY-MM-DD. The shape check alone is not enough:
 * "2026-02-30" matches the regex, Date.parse rolls it to March 2, and
 * Postgres rejects it (22008) — which would sink the whole batch. /api/search
 * validates shape only, so this is reachable from a URL.
 */
export function isRealDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
}

const INT4_MIN = -2147483648;
const INT4_MAX = 2147483647;
function isInt4(v: number): boolean {
  return Number.isInteger(v) && v >= INT4_MIN && v <= INT4_MAX;
}

/**
 * Why a row cannot be inserted (empty = insertable). Postgres rejects a
 * multi-row INSERT as a whole on one bad row, and the insert is
 * error-swallowing by contract — so one out-of-window date (a replayed stale
 * URL, an LLM-supplied past date on the chat path) would otherwise silently
 * discard the entire search's observations. Mirrors 025's CHECKs and the
 * NOT NULL column types. Dropped rows are REPORTED with these reasons.
 *
 * The nullable per-lot ints (available_spots, grand_total_cents) are NOT
 * checked here — they are coerced to null in sanitizeRow instead, so a bad
 * value from ResLab for one lot costs a number, not the sold_out observation
 * (dropping the row would silently shrink lots_seen and bias pct_sold_out).
 */
export function uninsertableReasons(row: AvailabilityRow): string[] {
  const reasons: string[] = [];
  if (!isInt4(row.lead_days) || row.lead_days < -1) reasons.push(`lead_days=${row.lead_days}`);
  if (!isInt4(row.stay_days) || row.stay_days < 0) reasons.push(`stay_days=${row.stay_days}`);
  if (!isRealDate(row.check_in)) reasons.push(`check_in=${String(row.check_in).slice(0, 32)}`);
  if (!isRealDate(row.check_out)) reasons.push(`check_out=${String(row.check_out).slice(0, 32)}`);
  if (!isInt4(row.reslab_location_id)) reasons.push(`reslab_location_id=${row.reslab_location_id}`);
  return reasons;
}

export function rowIsInsertable(row: AvailabilityRow): boolean {
  return uninsertableReasons(row).length === 0;
}

/** Coerce the nullable per-lot ints to null when they could not be stored as int4. */
export function sanitizeRow(row: AvailabilityRow): AvailabilityRow {
  const spots = row.available_spots;
  const cents = row.grand_total_cents;
  const okSpots = spots === null || isInt4(spots);
  const okCents = cents === null || isInt4(cents);
  if (okSpots && okCents) return row;
  return {
    ...row,
    available_spots: okSpots ? spots : null,
    grand_total_cents: okCents ? cents : null,
  };
}

function killSwitchOn(): boolean {
  const v = (process.env.AVAILABILITY_LOG_DISABLED ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
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

/** supabase-js / PostgREST error shape (a plain object, not an Error). */
interface PostgrestLikeError {
  message?: string;
  code?: string;
  details?: string;
  hint?: string;
}

function toError(detail: unknown): { err: Error; extra: string } {
  if (detail instanceof Error) return { err: detail, extra: "" };
  if (detail && typeof detail === "object") {
    // Keep the PostgREST code in the message: it is what distinguishes
    // "schema cache is stale" (PGRST205) from "a CHECK rejected the batch"
    // (23514) from "grant revoked" (42501) in the one Sentry event per hour.
    // `details` is deliberately NOT in the message — for a CHECK violation it
    // is "Failing row contains (<id>, <search_id>, …)", unique per event, and
    // Sentry groups a stackless Error by message: every failed batch would
    // become its own issue (= its own alert email). It goes to the console.
    const e = detail as PostgrestLikeError;
    const head = [e.code, e.message].filter(
      (p): p is string => typeof p === "string" && p.length > 0
    );
    const extra = [e.details, e.hint].filter(
      (p): p is string => typeof p === "string" && p.length > 0
    );
    return {
      err: new Error(head.length > 0 ? head.join(": ") : "unknown insert error"),
      extra: extra.join(" | "),
    };
  }
  return { err: new Error(String(detail)), extra: "" };
}

function warnOnce(detail: unknown): void {
  const { err, extra } = toError(detail);
  if (!warned) {
    warned = true;
    // Later inserts still run; only the console line is one-per-process.
    console.warn(
      "[availability] insert failed (further failures reported to Sentry hourly):",
      err.message,
      extra
    );
  }
  const now = Date.now();
  if (lastReportedAt === null || now - lastReportedAt >= REPORT_INTERVAL_MS) {
    lastReportedAt = now;
    // details/hint ride as context, not in the message: they name the failing
    // row (the only pointer to which column/value violated) without changing
    // the event's grouping.
    captureAPIError(err, {
      endpoint: "availability_log.insert",
      method: "INSERT",
      ...(extra ? { extra: { postgrest: extra } } : {}),
    });
  }
}

// Rows dropped by rowIsInsertable are a distinct signal from a failed insert
// (nothing hit the DB) and are throttled on their own clock, so a burst of
// replayed stale URLs cannot mask a real insert failure or vice versa.
let lastDropReportedAt: number | null = null;

function reportDropped(dropped: number, total: number, sample: AvailabilityRow): void {
  const now = Date.now();
  if (lastDropReportedAt !== null && now - lastDropReportedAt < REPORT_INTERVAL_MS) return;
  lastDropReportedAt = now;
  captureAPIError(
    new Error(
      `availability_log: dropped ${dropped}/${total} uninsertable rows (${sample.airport_code} ${sample.source}: ` +
        `${uninsertableReasons(sample).join(", ")})`
    ),
    {
      endpoint: "availability_log.guard",
      method: "INSERT",
      extra: { sample },
    }
  );
}

/** Test seam — reset module-level warn/report state between cases. */
export function __resetAvailabilityLogWarnStateForTests(): void {
  warned = false;
  lastReportedAt = null;
  lastDropReportedAt = null;
}

/**
 * Fire-and-forget insert of one search's worth of rows. Returns immediately;
 * the caller must not await it. Never throws.
 */
export function logAvailability(rows: AvailabilityRow[]): void {
  try {
    if (rows.length === 0) return;
    // Every Vercel build of every branch runs generateStaticParams → after() at
    // build time, with the service-role key injected — without this guard every
    // build of every branch would write into the (real, production) table.
    if (process.env.NEXT_PHASE === "phase-production-build") return;
    // Kill switch for an incident or a load test. Vercel env var changes don't
    // reach already-running deployments, so this needs a redeploy, not just a
    // flip in the dashboard.
    if (killSwitchOn()) return;
    // Sampling, if volume ever demands it, goes HERE — drop a share of rows (or
    // of whole searches) before the insert. Deliberately not sampling today:
    // /api/search is CDN-cached 300s so origin search volume is modest, and a
    // sampled log answers "was it sold out?" much less crisply than a full one.

    const insertable = rows.filter(rowIsInsertable).map(sanitizeRow);
    const dropped = rows.length - insertable.length;
    if (dropped > 0) {
      // Every field rowIsInsertable checks is shared by all rows of one
      // search, so a drop is the whole search — the one failure this table
      // cannot afford to have go unnoticed (an unrecorded day cannot be
      // backfilled).
      const sample = rows.find((r) => !rowIsInsertable(r)) ?? rows[0];
      reportDropped(dropped, rows.length, sample);
    }
    if (insertable.length === 0) return;

    const env = resolveEnv();
    // One id per call (i.e. per search), shared by every row it writes — lets
    // the view count DISTINCT search_id instead of DISTINCT searched_at, which
    // is exact even if a future retry writes two transactions for one search.
    const searchId = crypto.randomUUID();
    const insertRows = insertable.map((row) => ({ ...row, env, search_id: searchId }));

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
        if (error) warnOnce(error);
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
  } catch (err) {
    // The contract is "never throws", enforced here rather than by trusting
    // every caller to wrap us.
    warnOnce(err);
  }
}
