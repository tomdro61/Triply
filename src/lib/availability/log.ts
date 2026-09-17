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
 *   - never throws — including when migration 024 has not been applied yet and
 *     the table or its columns don't exist;
 *   - warns at most once per process, so a missing table doesn't flood logs.
 *
 * See supabase/migrations/024_availability_log.sql.
 */

import { after } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";

export type AvailabilitySource = "search" | "chat" | "airport-page";

/** One lot, as it looked for one search. Mirrors the availability_log columns. */
export interface AvailabilityRow {
  airport_code: string;
  /** YYYY-MM-DD */
  check_in: string;
  /** YYYY-MM-DD */
  check_out: string;
  /** check_in minus the search date, in days. */
  lead_days: number;
  stay_days: number;
  reslab_location_id: number;
  sold_out: boolean;
  available_spots: number | null;
  /** reservation.grand_total in cents; null when the lot didn't price. */
  min_price_cents: number | null;
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

/** Today in UTC as YYYY-MM-DD — the baseline for lead_days. */
export function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

// One warning per process. The expected failure is "table doesn't exist yet",
// which would otherwise warn on every single search until 024 is applied.
let warned = false;
function warnOnce(detail: unknown): void {
  if (warned) return;
  warned = true;
  console.warn(
    "[availability] logging disabled for this process — insert failed:",
    detail instanceof Error ? detail.message : detail
  );
}

/**
 * Fire-and-forget insert of one search's worth of rows. Returns immediately;
 * the caller must not await it.
 */
export function logAvailability(rows: AvailabilityRow[]): void {
  if (rows.length === 0) return;
  // Kill switch for an incident or a load test — no deploy required.
  if (process.env.AVAILABILITY_LOG_DISABLED === "1") return;
  // Sampling, if volume ever demands it, goes HERE — drop a share of rows (or
  // of whole searches) before the insert. Deliberately not sampling today:
  // /api/search is CDN-cached 300s so origin search volume is modest, and a
  // sampled log answers "was it sold out?" much less crisply than a full one.

  const insert = async () => {
    try {
      const supabase = await createAdminClient();
      const { error } = await supabase.from("availability_log").insert(rows);
      // supabase-js reports failures in `error` rather than throwing, so the
      // missing-table / missing-column case lands here, not in the catch.
      if (error) warnOnce(error.message || error);
    } catch (err) {
      // Anything else: no service-role key, network, a thrown client. Telemetry
      // is never worth an exception on the customer's path.
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
