/**
 * search_events logging — fire-and-forget record of one parking search, so
 * stay-length and lead-time demand can finally be measured (see
 * supabase/migrations/027_search_events.sql for the why).
 *
 * Contract, mirroring src/lib/availability/log.ts:
 *   - never awaited by the caller — the search response is never delayed or
 *     failed by this;
 *   - never throws, including before migration 027 is applied (PGRST205,
 *     table not found) or after a later schema drift (PGRST204, unknown
 *     column) — both are logged via console.warn, never raised;
 *   - always on. Unlike availability_log this has no incident history yet to
 *     warrant a kill switch, and the codebase's convention (see
 *     AVAILABILITY_LOG_DISABLED) is to add one only once there's a reason to.
 */

import { after } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";

export interface SearchEventRow {
  airport_code: string;
  /** YYYY-MM-DD */
  check_in: string;
  /** YYYY-MM-DD */
  check_out: string;
  stay_days: number;
  lead_days: number;
  results_count: number;
  /** Cheapest priced result's grand total, in cents. Null when nothing priced. */
  cheapest_price_cents: number | null;
  /** Reserved — see the migration; not populated by the route today. */
  sold_out_count: number | null;
  source: string | null;
  medium: string | null;
  campaign: string | null;
  ga_client_id: string | null;
}

async function insert(row: SearchEventRow): Promise<void> {
  try {
    const supabase = await createAdminClient();
    const { error } = await supabase.from("search_events").insert(row);
    // supabase-js reports failures in `error`, not a throw — PGRST205 (table
    // missing, migration 027 not applied yet) and PGRST204 (unknown column,
    // a later schema drift) land here. Logged, never thrown: a search must
    // never fail or wait on this.
    if (error) {
      console.warn("[search-events]", error.code, error.message);
    }
  } catch (err) {
    // No service-role key, network failure, a thrown client — same rule.
    console.warn(
      "[search-events]",
      "EXCEPTION",
      err instanceof Error ? err.message : String(err)
    );
  }
}

/**
 * Fire-and-forget insert of one search's demand row. Returns immediately; the
 * caller must not await it.
 */
export function logSearchEvent(row: SearchEventRow): void {
  // On Vercel a dangling promise can be cut off the moment the response is
  // sent. `after()` keeps the function alive until the insert settles,
  // without delaying the response. It throws when called outside a request
  // scope (unit tests, scripts) — fall back to plain fire-and-forget there.
  try {
    after(() => insert(row));
  } catch {
    void insert(row);
  }
}
