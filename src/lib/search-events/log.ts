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
 *     upfront rather than under incident pressure.
 */

import { after } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { captureAPIError } from "@/lib/sentry";
import type { AvailabilitySource } from "@/lib/availability/log";

/** Call sites that can log a search_events row. Shares the three real search
 *  surfaces with availability_log's AvailabilitySource, plus the homepage's
 *  automated featured-parking widget, which fires a real /api/search request
 *  on every homepage view and airport-tab click with fixed tomorrow/+7 dates
 *  — a fixed background poll, not a person choosing those dates, and must be
 *  distinguishable from real search demand (see the 027 migration header). */
export type SearchEventSource = AvailabilitySource | "homepage-featured";

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

/** Test seam — reset module-level warn/report state between cases. */
export function __resetSearchEventsLogWarnStateForTests(): void {
  warned = false;
  lastReportedAt = null;
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
 */
export function logSearchEvent(row: SearchEventRow): void {
  try {
    // Every Vercel build of every branch runs generateStaticParams → after()
    // at build time, with the service-role key injected — see
    // availability/log.ts for the full reasoning.
    if (process.env.NEXT_PHASE === "phase-production-build") return;
    if (killSwitchOn()) return;

    // On Vercel a dangling promise can be cut off the moment the response is
    // sent. `after()` keeps the function alive until the insert settles,
    // without delaying the response. It throws when called outside a request
    // scope (unit tests, scripts) — fall back to plain fire-and-forget there.
    try {
      after(() => insert(row));
    } catch {
      void insert(row).catch(() => {
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
