import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/server";
import { stripeKeyMode } from "@/lib/cancellation/source-guard";
import { captureAPIError } from "@/lib/sentry";
import type { UnifiedLot } from "@/types/lot";
import { SHUTTLE_WAIT_VALUES, type ShuttleWait } from "./schema";

/**
 * Read side of booking_reviews (migration 037): per-lot rating + the latest
 * published review text, for lot pages, search cards and airport-page cards.
 *
 * - Every row is a verified stay (written only through the signed post-trip
 *   link), so every rating counts toward the average.
 * - Text and first name are shown ONLY when publish_consent is true. Taking a
 *   review down = set publish_consent false (display_name must then be NULL,
 *   enforced by booking_reviews_display_name_consent); its rating still counts.
 *   The takedown is NOT instant: this module caches per instance for
 *   SUCCESS_TTL_MS (lot pages), and /api/search responses sit in the CDN for
 *   up to 5 min + 10 min stale (search cards). Airport pages (ISR, 1 h) carry
 *   the rating and count only, never the text.
 * - The average is withheld below MIN_REVIEWS_FOR_RATING so one stay can never
 *   read as a lot's "5.0".
 * - Staging and production share one database: a live deployment reads only
 *   reviews of live (or pre-livemode NULL) bookings, a test deployment only
 *   livemode = false ones — the cron's rule, so test reviews never show live.
 *
 * Shape (the booking-popularity pattern, src/lib/search/booking-popularity.ts):
 * the table is small and changes rarely, so each instance reads the whole table
 * for its mode once — paged under PostgREST's 1,000-row cap up to ROW_CAP, one
 * shared deadline — and serves every search, lot page and airport page from
 * that copy. Success and failure are both cached (a database blip can't add
 * 2.5 s to every search), a failure is reported at most every ten minutes,
 * and the read never rejects. Display-only, off the money path: when anything
 * is wrong the page renders exactly as it does today (no rating, no reviews)
 * — never a rating computed from part of the data.
 */

export const MIN_REVIEWS_FOR_RATING = 3;
/** Published reviews kept per lot (lot page). Search cards take the first. */
export const MAX_PUBLISHED_PER_LOT = 6;
const QUERY_TIMEOUT_MS = 2_500;
const PAGE = 1_000;
/** ~20 reviews a month today; the cap guards a runaway table. Past it, every rating is withheld and reported. */
const ROW_CAP = 5_000;
const SUCCESS_TTL_MS = 5 * 60 * 1000;
const FAILURE_TTL_MS = 5 * 60 * 1000;
const REPORT_INTERVAL_MS = 10 * 60 * 1000;

export function lotReviewsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LOT_REVIEWS_DISPLAY_ENABLED === "true";
}

export interface PublishedReview {
  rating: number;
  comment: string;
  /** The guest's first name, or null → shown as "Verified guest". */
  name: string | null;
  shuttleWait: ShuttleWait | null;
  extraCharges: boolean | null;
  /** ISO timestamp the review was written. */
  createdAt: string;
}

export interface LotReviewSummary {
  /** Mean rating 1–5 rounded to 1 decimal; null below MIN_REVIEWS_FOR_RATING. */
  average: number | null;
  /** Every verified review for the lot (with or without text). */
  count: number;
  /** Consented reviews with text, newest first, at most MAX_PUBLISHED_PER_LOT. */
  published: PublishedReview[];
}

/** booking_reviews identifies a lot by reslab_location_id OR direct_lot_id (= the direct lot's payload id). */
export function lotReviewKey(lot: Pick<UnifiedLot, "source" | "sourceId" | "reslabLocationId">): string | null {
  if (lot.source === "reslab") return lot.reslabLocationId !== undefined ? `r:${lot.reslabLocationId}` : null;
  return lot.sourceId ? `d:${lot.sourceId}` : null;
}

export const reviewRowSchema = z.object({
  /** Required so the page-boundary dedupe above can never switch off silently: a row without one fails here and is reported. */
  id: z.string(),
  reslab_location_id: z.number().int().nullable(),
  direct_lot_id: z.string().nullable(),
  rating: z.number().int().min(1).max(5),
  comment: z.string().nullable(),
  publish_consent: z.boolean(),
  display_name: z.string().nullable(),
  shuttle_wait: z.enum(SHUTTLE_WAIT_VALUES).nullable(),
  extra_charges: z.boolean().nullable(),
  created_at: z.string(),
});
export type ReviewRow = z.infer<typeof reviewRowSchema>;

function rowKey(r: { reslab_location_id: number | null; direct_lot_id: string | null }): string | null {
  if (r.reslab_location_id !== null) return `r:${r.reslab_location_id}`;
  if (r.direct_lot_id !== null) return `d:${r.direct_lot_id}`;
  return null;
}

/** The lot key of a row that failed validation, read leniently so that lot can be withheld. */
function rawRowKey(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.reslab_location_id === "number") return `r:${r.reslab_location_id}`;
  if (typeof r.direct_lot_id === "string") return `d:${r.direct_lot_id}`;
  return null;
}

/** Pure aggregation. Rows may arrive in any order. */
export function summarizeReviews(rows: ReviewRow[]): Map<string, LotReviewSummary> {
  const groups = new Map<string, ReviewRow[]>();
  for (const r of rows) {
    const key = rowKey(r);
    if (!key) continue;
    const g = groups.get(key);
    if (g) g.push(r);
    else groups.set(key, [r]);
  }
  const out = new Map<string, LotReviewSummary>();
  for (const [key, g] of groups) {
    const sum = g.reduce((s, r) => s + r.rating, 0);
    const published = g
      .filter((r) => r.publish_consent && r.comment !== null && r.comment.trim() !== "")
      .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0))
      .slice(0, MAX_PUBLISHED_PER_LOT)
      .map((r) => ({
        rating: r.rating,
        comment: r.comment!.trim(),
        name: r.display_name?.trim() || null,
        shuttleWait: r.shuttle_wait,
        extraCharges: r.extra_charges,
        createdAt: r.created_at,
      }));
    out.set(key, {
      average: g.length >= MIN_REVIEWS_FOR_RATING ? Math.round((sum / g.length) * 10) / 10 : null,
      count: g.length,
      published,
    });
  }
  return out;
}

type Mode = "live" | "test";
/** null = the read failed; nothing is shown until the failure cache expires. */
type AllSummaries = Map<string, LotReviewSummary> | null;

let cached: { mode: Mode; value: AllSummaries; expiresAt: number } | null = null;
let inFlight: { mode: Mode; promise: Promise<AllSummaries> } | null = null;
/** Per stage (config / read / parse), so a new kind of failure is never hidden behind another kind's window. */
const reportWindows = new Map<string, { at: number; suppressed: number }>();

export function __resetLotReviewSummariesForTests(): void {
  cached = null;
  inFlight = null;
  reportWindows.clear();
}

/** Tests only: forget the cached result (success or failure) but keep the report windows. */
export function __expireLotReviewCacheForTests(): void {
  cached = null;
}

/** At most one Sentry event per REPORT_INTERVAL_MS per stage per instance; the event carries how many were suppressed. */
function report(err: Error, surface: string, stage: string, extra: Record<string, unknown> = {}, code?: string): void {
  const now = Date.now();
  const w = reportWindows.get(stage);
  if (w && now - w.at < REPORT_INTERVAL_MS) {
    w.suppressed++;
    return;
  }
  captureAPIError(err, {
    endpoint: surface,
    method: "GET",
    stage,
    ...(code && { code }),
    extra: { ...extra, suppressedSinceLastReport: w?.suppressed ?? 0 },
  });
  reportWindows.set(stage, { at: now, suppressed: 0 });
}

/**
 * Reads summaries for the given lots. Never throws; empty map when off,
 * unconfigured, failing, or when the lot has no reviews.
 */
export async function fetchLotReviewSummaries(
  lots: Pick<UnifiedLot, "source" | "sourceId" | "reslabLocationId">[],
  surface: string
): Promise<Map<string, LotReviewSummary>> {
  if (!lotReviewsEnabled() || lots.length === 0) return new Map();
  // No database reads while `next build` prerenders (no runtime env there).
  if (process.env.NEXT_PHASE === "phase-production-build") return new Map();
  const mode = stripeKeyMode();
  if (!mode) {
    report(new Error("lot-reviews: STRIPE_SECRET_KEY is missing or not a live/test key"), surface, "lot-reviews-config");
    return new Map();
  }
  const all = await getAllSummaries(mode, surface);
  const out = new Map<string, LotReviewSummary>();
  if (!all) return out;
  for (const lot of lots) {
    const key = lotReviewKey(lot);
    const s = key ? all.get(key) : undefined;
    if (key && s) out.set(key, s);
  }
  return out;
}

function getAllSummaries(mode: Mode, surface: string): Promise<AllSummaries> {
  const now = Date.now();
  if (cached && cached.mode === mode && now < cached.expiresAt) return Promise.resolve(cached.value);
  if (inFlight && inFlight.mode === mode) return inFlight.promise;
  const promise = load(mode, surface)
    .then((value) => {
      cached = { mode, value, expiresAt: Date.now() + (value ? SUCCESS_TTL_MS : FAILURE_TTL_MS) };
      return value;
    })
    .catch((): AllSummaries => null)
    .finally(() => {
      if (inFlight?.promise === promise) inFlight = null;
    });
  inFlight = { mode, promise };
  return promise;
}

async function load(mode: Mode, surface: string): Promise<AllSummaries> {
  try {
    const supabase = await createAdminClient();
    const signal = AbortSignal.timeout(QUERY_TIMEOUT_MS);
    const raw: unknown[] = [];
    for (let from = 0; from <= ROW_CAP; from += PAGE) {
      const to = Math.min(from + PAGE - 1, ROW_CAP);
      const base = supabase
        .from("booking_reviews")
        .select(
          "id, reslab_location_id, direct_lot_id, rating, comment, publish_consent, display_name, shuttle_wait, extra_charges, created_at, bookings!inner(livemode)"
        );
      // The inner join makes the embedded filter exclude the review row itself.
      // Live: livemode true OR NULL (pre-livemode bookings are live) — the same
      // `not … is false` the daily digest writes. Test: livemode = false only.
      const filtered = mode === "live" ? base.not("bookings.livemode", "is", false) : base.eq("bookings.livemode", false);
      // Offset paging under an order where a row written BETWEEN two page reads
      // sorts last (created_at), not anywhere (a random UUID id alone) — so the
      // boundary never shifts and no row repeats (pass-2 review). The id is
      // the tiebreaker, and repeats are dropped by id below regardless.
      const { data, error } = await filtered.order("created_at").order("id").range(from, to).abortSignal(signal);
      if (error) {
        throw Object.assign(new Error(`booking_reviews: ${error.code || "?"} ${error.message}`), {
          code: error.code,
          details: error.details,
          hint: error.hint,
        });
      }
      const page: unknown[] = data ?? [];
      raw.push(...page);
      if (page.length < to - from + 1) break;
    }
    if (raw.length > ROW_CAP) throw new Error(`booking_reviews: more than ${ROW_CAP} rows; every rating withheld`);
    const seen = new Set<string>();
    const unique = raw.filter((r) => {
      const id = typeof r === "object" && r !== null ? (r as { id?: unknown }).id : undefined;
      if (typeof id !== "string") return true; // an id-less row is left to validation below
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });

    // A row that fails validation (schema drift, e.g. a new shuttle_wait value
    // added to the DB check before SHUTTLE_WAIT_VALUES) withholds ITS lot: an
    // average over part of a lot's reviews would be a wrong number shown as
    // verified. Other lots are unaffected.
    const rows: ReviewRow[] = [];
    const withheld = new Set<string>();
    let invalid = 0;
    let firstIssue: unknown;
    for (const r of unique) {
      const parsed = reviewRowSchema.safeParse(r);
      if (parsed.success) {
        rows.push(parsed.data);
        continue;
      }
      invalid++;
      firstIssue ??= parsed.error.issues[0];
      const key = rawRowKey(r);
      if (key) withheld.add(key);
    }
    const summaries = summarizeReviews(rows);
    for (const key of withheld) summaries.delete(key);
    if (invalid > 0) {
      report(new Error("lot-reviews: rows failed validation; their lots are withheld"), surface, "lot-reviews-parse", {
        mode,
        invalid,
        withheldLots: [...withheld],
        firstIssue,
      });
    }
    return summaries;
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    const { code, details, hint } = e as Error & { code?: string; details?: string; hint?: string };
    report(e, surface, "lot-reviews-read", { mode, details, hint }, code);
    return null;
  }
}

/**
 * Copies summaries onto lots: rating + reviewCount (already rendered by the
 * lot header, search card and airport card) and `reviews`. `maxPublished`
 * trims the text carried per lot (search payloads keep one; airport pages
 * none).
 */
export function withReviews<T extends UnifiedLot>(lots: T[], summaries: Map<string, LotReviewSummary>, maxPublished = MAX_PUBLISHED_PER_LOT): T[] {
  if (summaries.size === 0) return lots;
  return lots.map((lot) => {
    const key = lotReviewKey(lot);
    const s = key ? summaries.get(key) : undefined;
    if (!s) return lot;
    return {
      ...lot,
      rating: s.average ?? undefined,
      reviewCount: s.average !== null ? s.count : undefined,
      reviews: { ...s, published: s.published.slice(0, maxPublished) },
    };
  });
}
