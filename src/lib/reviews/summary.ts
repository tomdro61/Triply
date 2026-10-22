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
 * - The average is withheld below MIN_REVIEWS_FOR_RATING so one stay can never
 *   read as a lot's "5.0".
 * - Staging and production share one database: a live deployment reads only
 *   reviews of live (or pre-livemode NULL) bookings, a test deployment only
 *   livemode = false ones — the cron's rule, so test reviews never show live.
 *
 * Display-only and off the money path: any read failure is reported and the
 * page renders exactly as it does today (no rating, no reviews).
 */

export const MIN_REVIEWS_FOR_RATING = 3;
/** Published reviews kept per lot (lot page). Search cards take the first. */
export const MAX_PUBLISHED_PER_LOT = 6;
/** Hard cap on rows read per call (newest first). */
const ROW_CAP = 2_000;
const DB_TIMEOUT_MS = 2_500;

export function lotReviewsEnabled(): boolean {
  return process.env.LOT_REVIEWS_DISPLAY_ENABLED === "true";
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

function rowKey(r: ReviewRow): string | null {
  if (r.reslab_location_id !== null) return `r:${r.reslab_location_id}`;
  if (r.direct_lot_id !== null) return `d:${r.direct_lot_id}`;
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

/** Only ids that are safe inside a PostgREST in.(…) list. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Reads summaries for the given lots. Never throws; empty map when off, unconfigured or failing. */
export async function fetchLotReviewSummaries(
  lots: Pick<UnifiedLot, "source" | "sourceId" | "reslabLocationId">[],
  surface: string
): Promise<Map<string, LotReviewSummary>> {
  if (!lotReviewsEnabled() || lots.length === 0) return new Map();
  // No database reads while `next build` prerenders (no runtime env there).
  if (process.env.NEXT_PHASE === "phase-production-build") return new Map();
  const mode = stripeKeyMode();
  if (!mode) {
    captureAPIError(new Error("lot-reviews: STRIPE_SECRET_KEY is missing or not a live/test key"), {
      endpoint: surface,
      method: "GET",
      stage: "lot-reviews-config",
    });
    return new Map();
  }

  const reslabIds = [...new Set(lots.flatMap((l) => (l.source === "reslab" && l.reslabLocationId !== undefined ? [l.reslabLocationId] : [])))];
  const directIds = [...new Set(lots.flatMap((l) => (l.source === "direct" && SAFE_ID.test(l.sourceId) ? [l.sourceId] : [])))];
  const lotFilters = [
    ...(reslabIds.length ? [`reslab_location_id.in.(${reslabIds.join(",")})`] : []),
    ...(directIds.length ? [`direct_lot_id.in.(${directIds.join(",")})`] : []),
  ];
  if (lotFilters.length === 0) return new Map();

  try {
    const supabase = await createAdminClient();
    let query = supabase
      .from("booking_reviews")
      .select(
        "reslab_location_id, direct_lot_id, rating, comment, publish_consent, display_name, shuttle_wait, extra_charges, created_at, bookings!inner(livemode)"
      )
      .or(lotFilters.join(","));
    query =
      mode === "live"
        ? query.or("livemode.is.null,livemode.eq.true", { referencedTable: "bookings" })
        : query.eq("bookings.livemode", false);
    const { data, error } = await query
      .order("created_at", { ascending: false })
      .limit(ROW_CAP)
      .abortSignal(AbortSignal.timeout(DB_TIMEOUT_MS));
    if (error) throw Object.assign(new Error(`lot-reviews read failed: ${error.message}`), { code: error.code });

    const rows: ReviewRow[] = [];
    let invalid = 0;
    for (const raw of data ?? []) {
      const parsed = reviewRowSchema.safeParse(raw);
      if (parsed.success) rows.push(parsed.data);
      else invalid++;
    }
    if (invalid > 0) {
      captureAPIError(new Error("lot-reviews: rows failed validation"), {
        endpoint: surface,
        method: "GET",
        stage: "lot-reviews-parse",
        extra: { invalid },
      });
    }
    return summarizeReviews(rows);
  } catch (err) {
    captureAPIError(err instanceof Error ? err : new Error(String(err)), {
      endpoint: surface,
      method: "GET",
      stage: "lot-reviews-read",
    });
    return new Map();
  }
}

/**
 * Copies summaries onto lots: rating + reviewCount (already rendered by the
 * lot header, search card and detail slider) and `reviews`. `maxPublished`
 * trims the text carried per lot (search payloads keep one).
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
