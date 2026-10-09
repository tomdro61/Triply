/**
 * Kept bookings per ResLab lot over the last 90 days — the "Most booked" signal
 * behind search's Recommended order (src/lib/search/ranking.ts).
 *
 * An ordering-only signal: no price, availability or booking decision reads it,
 * and nothing a customer is charged depends on it. So a failure degrades the
 * Recommended order to cheapest-first instead of failing the search.
 *
 * Bounds: one shared 3 s deadline for every query; PostgREST caps a select at
 * 1,000 rows, so rows are paged under a fixed order (the digest's pagedRows
 * pattern) up to ROW_CAP. Success is cached per instance for an hour; a failure
 * for five minutes (so a database blip can't add 3 s to every search) and
 * reported at most every ten minutes. Never rejects.
 *
 * Callers skip this on Vercel previews: they price against STAGING ResLab, whose
 * location ids are not production's (see searchParking).
 */
import { createAdminClient } from "@/lib/supabase/server";
import { isAtTestLot } from "@/config/admin";
import { captureAPIError } from "@/lib/sentry";

export const POPULARITY_WINDOW_DAYS = 90;
const QUERY_TIMEOUT_MS = 3_000;
const SUCCESS_TTL_MS = 60 * 60 * 1000;
const FAILURE_TTL_MS = 5 * 60 * 1000;
const REPORT_INTERVAL_MS = 10 * 60 * 1000;
const PAGE = 1_000;
// ~6 bookings/day → ~540 rows in 90 days; the cap only guards a runaway table.
const ROW_CAP = 20_000;
// `.in()` rides in the query string; keep each batch well under a 414.
const IN_BATCH = 200;

/** ok:false = the counts are unknown (query failed); the order degrades. */
export type LotBookingCounts =
  | { ok: true; counts: ReadonlyMap<number, number> }
  | { ok: false };

/** Off for "off" / "false" / "0" / "no" (any case); on otherwise. */
export function isRecommendedRankingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !["off", "false", "0", "no"].includes((env.SEARCH_RECOMMENDED_RANKING ?? "").trim().toLowerCase());
}

let cached: { value: LotBookingCounts; expiresAt: number } | null = null;
let inFlight: Promise<LotBookingCounts> | null = null;
let lastReportAt: number | null = null;

export function __resetLotBookingCountsForTests(): void {
  cached = null;
  inFlight = null;
  lastReportAt = null;
}

export function getLotBookingCounts(env: NodeJS.ProcessEnv = process.env): Promise<LotBookingCounts> {
  const now = Date.now();
  if (cached && now < cached.expiresAt) return Promise.resolve(cached.value);
  if (inFlight) return inFlight;
  inFlight = load(env)
    .then((value) => {
      cached = { value, expiresAt: Date.now() + (value.ok ? SUCCESS_TTL_MS : FAILURE_TTL_MS) };
      return value;
    })
    .catch((): LotBookingCounts => ({ ok: false }))
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

type BookingRow = {
  reslab_location_id: number | null;
  livemode: boolean | null;
  stripe_payment_intent_id: string | null;
};

async function load(env: NodeJS.ProcessEnv): Promise<LotBookingCounts> {
  try {
    const supabase = await createAdminClient();
    const signal = AbortSignal.timeout(QUERY_TIMEOUT_MS);
    const since = new Date(Date.now() - POPULARITY_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const rows: BookingRow[] = [];
    for (let from = 0; from <= ROW_CAP; from += PAGE) {
      const to = Math.min(from + PAGE - 1, ROW_CAP);
      // 'confirmed' = kept bookings only. A refund/cancellation is not demand
      // we want to promote, and a 'disputed' charge is a customer contesting
      // the stay — both deliberately excluded (the recovery cron's
      // LIVE_BOOKING_STATUSES answers a different question: "is this trip
      // already booked?").
      const { data, error } = await supabase
        .from("bookings")
        .select("reslab_location_id, livemode, stripe_payment_intent_id")
        .eq("status", "confirmed")
        .not("reslab_location_id", "is", null)
        .gte("created_at", since)
        .order("id")
        .range(from, to)
        .abortSignal(signal);
      if (error) throw new Error(`bookings: ${error.code ?? "?"} ${error.message}`);
      const page: BookingRow[] = data ?? [];
      rows.push(...page);
      if (page.length < to - from + 1) break;
    }
    if (rows.length > ROW_CAP) throw new Error(`bookings: more than ${ROW_CAP} rows in ${POPULARITY_WINDOW_DAYS} days`);

    // bookings.livemode was not written by fulfilment from migration 034
    // (2026-10-05) until the Oct 2026 fix, so older rows can still be NULL. For
    // those the staged payment row (pending_bookings.livemode) is authoritative —
    // the same join the daily digest makes. NULL with no staged row = a pre-015
    // booking (live).
    const unresolved = [
      ...new Set(
        rows.flatMap((r) => (r.livemode === null && r.stripe_payment_intent_id ? [r.stripe_payment_intent_id] : []))
      ),
    ];
    const stagedLivemode = new Map<string, boolean>();
    for (let i = 0; i < unresolved.length; i += IN_BATCH) {
      const { data, error } = await supabase
        .from("pending_bookings")
        .select("stripe_payment_intent_id, livemode")
        .in("stripe_payment_intent_id", unresolved.slice(i, i + IN_BATCH))
        .abortSignal(signal);
      if (error) throw new Error(`pending_bookings: ${error.code ?? "?"} ${error.message}`);
      for (const p of data ?? []) {
        if (typeof p.livemode === "boolean") stagedLivemode.set(p.stripe_payment_intent_id, p.livemode);
      }
    }

    const counts = new Map<number, number>();
    for (const r of rows) {
      const id = r.reslab_location_id;
      if (id === null || isAtTestLot(id)) continue;
      const live =
        r.livemode ?? (r.stripe_payment_intent_id ? stagedLivemode.get(r.stripe_payment_intent_id) : undefined) ?? true;
      if (!live) continue;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }

    // Production has ~6 kept bookings a day, so none in 90 days means the read
    // is wrong (a mis-set key, a filter matching nothing), not that nobody
    // booked. Treat it as a failure so it is reported and retried.
    if (counts.size === 0 && env.VERCEL_ENV === "production") {
      throw new Error(`bookings: 0 kept bookings in ${POPULARITY_WINDOW_DAYS} days in production`);
    }
    return { ok: true, counts };
  } catch (err) {
    const now = Date.now();
    if (lastReportAt === null || now - lastReportAt >= REPORT_INTERVAL_MS) {
      lastReportAt = now;
      captureAPIError(err instanceof Error ? err : new Error(String(err)), {
        endpoint: "searchParking.bookingPopularity",
        method: "GET",
      });
    }
    return { ok: false };
  }
}
