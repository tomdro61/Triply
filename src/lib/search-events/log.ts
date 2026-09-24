/**
 * search_events logging — the per-search HEADER row, keyed on the same
 * `search_id` that availability_log (src/lib/availability/log.ts) writes for
 * every lot of the same search, so stay-length and lead-time demand can
 * finally be joined against sold-out/pricing observations for that search
 * (see supabase/migrations/027_search_events.sql for the full why).
 *
 * Written from inside searchParking (src/lib/reslab/search.ts), the same
 * place and the same call as availability_log — NOT from the route handler —
 * so chat and airport-page searches get a header row too, and so both tables
 * agree on `search_id`, `env`, `source`, and lead/stay days (both are
 * measured against localToday(airport.timezone), never UTC).
 *
 * Contract, mirroring src/lib/availability/log.ts:
 *   - never awaited by the caller — the search response is never delayed or
 *     failed by this;
 *   - never throws, including before migration 027 is applied (PGRST205,
 *     table not found) or after a later schema drift (PGRST204, unknown
 *     column) — both are logged via console.warn, and hourly to Sentry;
 *   - a no-op during `next build` (NEXT_PHASE=phase-production-build), same
 *     reason as availability_log — every build of every branch has the
 *     service-role key injected;
 *   - a SEARCH_EVENTS_LOG_DISABLED kill switch, same shape as
 *     AVAILABILITY_LOG_DISABLED, for an incident or a load test — off by
 *     default, since this table has no incident history yet to warrant it,
 *     but a redeploy-only flip (like its sibling) is cheap enough to add
 *     upfront rather than under incident pressure;
 *   - drops a row that would violate a 027 CHECK / NOT NULL rather than
 *     letting Postgres reject it, and reports the drop on its OWN Sentry
 *     signature and clock (uninsertableReasons below) — see why there.
 */

import { after } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { captureAPIError } from "@/lib/sentry";
import { isInt4, isRealDate } from "@/lib/availability/log";

/** Call sites that can log a search_events row. Shares the three real search
 *  surfaces with availability_log's AvailabilitySource, plus the homepage's
 *  automated featured-parking widget, which fires a real /api/search request
 *  on every homepage view and airport-tab click with fixed tomorrow/+7 dates
 *  — a fixed background poll, not a person choosing those dates, and must be
 *  distinguishable from real search demand (see the 027 migration header). */
export const SEARCH_EVENT_SOURCES = ["search", "chat", "airport-page", "homepage-featured"] as const;
export type SearchEventSource = (typeof SEARCH_EVENT_SOURCES)[number];

export interface SearchEventRow {
  /** Shared with the availability_log rows this same search wrote — the join key. */
  search_id: string;
  env: string;
  airport_code: string;
  /** YYYY-MM-DD */
  check_in: string;
  /** YYYY-MM-DD */
  check_out: string;
  stay_days: number;
  /** From localToday(airport.timezone) — same baseline availability_log uses. */
  lead_days: number;
  /** True when checkin/checkout were NOT supplied by the caller and the route
   *  substituted its tomorrow/+7 pricing-estimate fallback. Without this, the
   *  mode of the stay/lead-time distribution is that fallback, not anything
   *  a person typed. */
  dates_defaulted: boolean;
  results_count: number;
  /** Cheapest priced result's grand total, in cents. Null when nothing priced
   *  OR when the result is degraded — a "cheapest" computed from a partial
   *  ResLab response is not a real cheapest, it's whatever survived. */
  cheapest_price_cents: number | null;
  /** Count of lots ResLab reported sold_out === true, computed from the same
   *  per-lot pricing results the availability_log rows are built from. Null
   *  when nothing priced (no lots to have an opinion about). */
  sold_out_count: number | null;
  /** Some/all ResLab pricing calls failed, or the location list build was
   *  thin — the result under-reports. Mirrors SearchParkingResult.degraded. */
  degraded: boolean;
  /** The location list was complete but past its TTL — the result is full,
   *  just not fresh. Mirrors SearchParkingResult.stale. */
  stale: boolean;
  /** Call site — same enum as availability_log.source, plus
   *  "homepage-featured" (see SearchEventSource above). */
  source: SearchEventSource;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  ga_client_id: string | null;
}

/** One column this row could not be stored in, and the value that failed. */
export interface UninsertableReason {
  column: string;
  value: string;
}

/**
 * Why this row cannot be inserted (empty = insertable). Mirrors migration
 * 027's CHECKs and NOT NULL column types — 027's own header promises the
 * logger carries this contract ("a bad value here means the whole header row
 * is dropped, not silently coerced: keep the two in sync"), and until now it
 * did not.
 *
 * This is NOT belt-and-braces. /api/search validates date SHAPE only
 * (`\d{4}-\d{2}-\d{2}`), and searchParking derives stay/lead days with
 * dayDiff, which returns a NUMBER — not null — for input Postgres refuses:
 * "2026-02-30" (Date.parse rolls it to Mar 2, the date column rejects it as
 * 22008), a reversed range (stay_days < 0), a long-past check-in (lead_days
 * < -1). All three are reachable from a URL a bot can replay.
 *
 * Without this gate each of those rejections lands in the swallowed insert
 * and burns warnOnce's one-per-process-hour Sentry slot, so a replay loop
 * masks a real PGRST205 / revoked-grant failure for an hour per instance —
 * the exact alert 027's post-apply checklist tells the operator to trust.
 * Dropped rows are reported instead, on their own signature
 * ("search_events.dropped_row") and their own clock, so neither failure can
 * hide the other.
 *
 * The NULLABLE ints (cheapest_price_cents, sold_out_count) are NOT checked
 * here — sanitizeRow coerces them to null instead, mirroring
 * availability/log.ts: there is exactly ONE header row per search, so a junk
 * price from ResLab must cost a number, never the stay/lead-time observation
 * that is the whole point of the table.
 */
export function uninsertableReasons(row: SearchEventRow): UninsertableReason[] {
  const reasons: UninsertableReason[] = [];
  const bad = (column: string, value: unknown) =>
    reasons.push({ column, value: String(value).slice(0, 32) });

  if (!isRealDate(row.check_in)) bad("check_in", row.check_in);
  if (!isRealDate(row.check_out)) bad("check_out", row.check_out);
  if (!isInt4(row.stay_days) || row.stay_days < 0) bad("stay_days", row.stay_days);
  if (!isInt4(row.lead_days) || row.lead_days < -1) bad("lead_days", row.lead_days);
  if (!isInt4(row.results_count)) bad("results_count", row.results_count);
  // 027 CHECK (airport_code = upper(airport_code)): a lowercase code would
  // split one airport's demand across two GROUP BY buckets, so the table
  // refuses it outright. Codes come from src/config/airports.ts, so this can
  // only trip on a config typo — which is precisely a thing to be told about
  // rather than to lose a day of an airport's searches to.
  //
  // String() rather than row.airport_code.toUpperCase(): this predicate must
  // be TOTAL. A throw here would land in logSearchEvent's outer catch and be
  // reported as an INSERT failure — the exact conflation the separate drop
  // clock exists to prevent. (A null/undefined code stringifies to
  // "null"/"undefined", which is not its own uppercase, so it is still
  // correctly rejected rather than waved through.)
  const code = String(row.airport_code);
  if (code !== code.toUpperCase()) bad("airport_code", row.airport_code);
  // Mirrors 027's CHECK (source IN (...)). The TS union is derived from the
  // same tuple, but a runtime value can only be trusted at the boundary —
  // and a fifth source added to the type without the SQL would otherwise
  // send every row into the swallowing insert and burn its hourly slot.
  if (!(SEARCH_EVENT_SOURCES as readonly string[]).includes(String(row.source))) {
    bad("source", row.source);
  }
  return reasons;
}

export function rowIsInsertable(row: SearchEventRow): boolean {
  return uninsertableReasons(row).length === 0;
}

/**
 * Coerce the NULLABLE ints to null when they could not be stored as int4.
 * Same trade as availability/log.ts sanitizeRow: lose the number, keep the
 * row. Both columns are already documented as "NULL when nothing priced", so
 * a null here reads exactly as "no usable figure", not as a fabricated zero.
 */
export function sanitizeRow(row: SearchEventRow): SearchEventRow {
  const cents = row.cheapest_price_cents;
  const soldOut = row.sold_out_count;
  const okCents = cents === null || isInt4(cents);
  const okSoldOut = soldOut === null || isInt4(soldOut);
  if (okCents && okSoldOut) return row;
  return {
    ...row,
    cheapest_price_cents: okCents ? cents : null,
    sold_out_count: okSoldOut ? soldOut : null,
  };
}

function killSwitchOn(): boolean {
  const v = (process.env.SEARCH_EVENTS_LOG_DISABLED ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/**
 * The environment tag every row carries, identical rule to
 * src/lib/availability/log.ts resolveEnv — duplicated rather than imported
 * across a fire-and-forget telemetry boundary would be fine either way, but
 * importing keeps the two tables from ever disagreeing on what "production"
 * means.
 */
export { resolveEnv } from "@/lib/availability/log";

// One console warning per process, then hourly to Sentry — identical pattern
// to availability/log.ts warnOnce, so a stale schema cache or a revoked grant
// surfaces the same way for both tables instead of one going silently dark
// while the other alerts.
let warned = false;
let lastReportedAt: number | null = null;
const REPORT_INTERVAL_MS = 60 * 60 * 1000;

interface PostgrestLikeError {
  message?: string;
  code?: string;
  details?: string;
  hint?: string;
}

function toError(detail: unknown): { err: Error; extra: string } {
  if (detail instanceof Error) return { err: detail, extra: "" };
  if (detail && typeof detail === "object") {
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
    // Later inserts still run; only the console line is one-per-process —
    // same reasoning as availability/log.ts.
    console.warn(
      "[search-events] insert failed (further failures reported to Sentry hourly):",
      err.message,
      extra
    );
  }
  const now = Date.now();
  if (lastReportedAt === null || now - lastReportedAt >= REPORT_INTERVAL_MS) {
    lastReportedAt = now;
    captureAPIError(err, {
      endpoint: "search_events.insert",
      method: "INSERT",
      ...(extra ? { extra: { postgrest: extra } } : {}),
    });
  }
}

// A row dropped by uninsertableReasons is a DIFFERENT failure from a failed
// insert — nothing reached the DB, so no PostgREST code exists to report —
// and it rides its own clock so a bot replaying invalid dates can never
// consume warnOnce's budget and hide a real insert failure behind an hour of
// "dropped row" noise (and vice versa).
let lastDropReportedAt: number | null = null;

function reportDropped(row: SearchEventRow, reasons: UninsertableReason[]): void {
  const now = Date.now();
  if (lastDropReportedAt !== null && now - lastDropReportedAt < REPORT_INTERVAL_MS) return;
  lastDropReportedAt = now;
  // Only the COLUMN NAMES go in the message: Sentry groups a stackless Error
  // by message, and the offending values are attacker-supplied and unbounded
  // ("check_in=2026-02-30", "…=2026-02-31", …) — in the message they would
  // make every distinct bad date its own issue, i.e. its own alert email.
  // The values ride in context, which does not affect grouping.
  captureAPIError(
    new Error(
      `search_events: dropped an uninsertable header row (${reasons
        .map((r) => r.column)
        .join(", ")})`
    ),
    {
      endpoint: "search_events.dropped_row",
      method: "INSERT",
      extra: {
        reasons,
        // Deliberately NOT the whole row: utm_*/ga_client_id are attribution
        // fields this table is careful to keep out of anywhere they aren't
        // needed, and none of them can cause a drop.
        row: {
          env: row.env,
          airport_code: row.airport_code,
          check_in: row.check_in,
          check_out: row.check_out,
          stay_days: row.stay_days,
          lead_days: row.lead_days,
          source: row.source,
          dates_defaulted: row.dates_defaulted,
        },
      },
    }
  );
}

/** Test seam — reset module-level warn/report state between cases. */
export function __resetSearchEventsLogWarnStateForTests(): void {
  warned = false;
  lastReportedAt = null;
  lastDropReportedAt = null;
}

async function insert(row: SearchEventRow): Promise<void> {
  try {
    const supabase = await createAdminClient();
    const { error } = await supabase
      .from("search_events")
      .insert(row)
      // ISR/build-time callers must not hang on a slow or wedged insert —
      // same ceiling as availability_log.
      .abortSignal(AbortSignal.timeout(3000));
    // supabase-js reports failures in `error`, not a throw — PGRST205 (table
    // missing, migration 027 not applied yet) and PGRST204 (unknown column,
    // a later schema drift) land here.
    if (error) warnOnce(error);
  } catch (err) {
    // No service-role key, network failure, a thrown client, the abort
    // timeout firing — same rule: never worth an exception on the search path.
    warnOnce(err);
  }
}

/**
 * Fire-and-forget insert of one search's demand header row. Returns
 * immediately; the caller must not await it. Never throws.
 *
 * A row migration 027 would reject is DROPPED here (and reported on its own
 * Sentry signature) rather than handed to the swallowed insert — see
 * uninsertableReasons.
 */
export function logSearchEvent(row: SearchEventRow): void {
  try {
    // Every Vercel build of every branch runs generateStaticParams → after()
    // at build time, with the service-role key injected — see
    // availability/log.ts for the full reasoning.
    if (process.env.NEXT_PHASE === "phase-production-build") return;
    if (killSwitchOn()) return;

    // Gate BEFORE the insert: a row 027 would reject must never reach the
    // error-swallowing insert, where it would burn warnOnce's hourly slot and
    // mask a real writer outage. See uninsertableReasons for the full why.
    const reasons = uninsertableReasons(row);
    if (reasons.length > 0) {
      try {
        reportDropped(row, reasons);
      } catch {
        /* Sentry itself unavailable. Deliberately NOT routed to warnOnce:
         * that would consume the one-per-hour `search_events.insert` alert
         * slot for a row that never reached the DB — the precise conflation
         * the separate drop clock exists to prevent. The drop still happens. */
      }
      return;
    }
    const clean = sanitizeRow(row);

    // On Vercel a dangling promise can be cut off the moment the response is
    // sent. `after()` keeps the function alive until the insert settles,
    // without delaying the response. It throws when called outside a request
    // scope (unit tests, scripts) — fall back to plain fire-and-forget there.
    try {
      after(() => insert(clean));
    } catch {
      void insert(clean).catch(() => {
        /* insert() already swallows and reports every failure via warnOnce;
         * this catch exists only so a rejected promise can never surface as
         * an unhandled rejection when after() isn't available. */
      });
    }
  } catch (err) {
    // The contract is "never throws", enforced here rather than by trusting
    // every caller to wrap us.
    warnOnce(err);
  }
}
