import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/server";
import { resolveCmsImageUrl } from "@/lib/cms";
import { getAirportByCode } from "@/config/airports";
import { captureAPIError } from "@/lib/sentry";
import { resolveEnv } from "@/lib/env";
import { isDirectLotVisible, parseVisibility, type DirectLotVisibility } from "./visibility";

/**
 * Read path for DIRECT lots (plan B2 as amended by the gate): the main app
 * reads `payload.lots*` through `public.direct_lots()` — a service-role-only
 * Postgres function (migration 035) — never over HTTP to the CMS. The CMS and
 * its API key are therefore off every request path.
 *
 * Contract (review H1): a failure is TYPED so callers can act on it —
 *   misconfigured  function missing / grant revoked / schema drift → search
 *                  degrades to ResLab-only, the pending route fails closed
 *   timeout        the 4 s bound hit
 *   unavailable    anything else (network, unexpected shape)
 * and a single lot lookup distinguishes `not_found` from `invalid` (the row
 * exists but does not parse — a broken CMS record, never "no such lot").
 *
 * Boundaries:
 * - Every row is Zod-parsed; a row that doesn't parse is DROPPED and reported
 *   (throttled per instance, review H2), never guessed at.
 * - The function returns drafts, inactive and staging-only lots by design;
 *   `isSellable` applies the rule, with the environment resolved HERE so no
 *   caller can forget it (B11).
 * - Timezone comes from the airport config; a lot at an airport we don't list
 *   (or have disabled) is not sellable.
 * - `media.url` is a RELATIVE CMS path (/api/media/file/...); resolved here.
 * - Never imports anything under src/lib/reslab (import-guard test).
 */

const DB_TIMEOUT_MS = 4_000;

/** A required number as PostgREST (JSON number) or node-postgres (numeric string) delivers it — never null/"" → 0. */
const requiredNumber = z.union([z.number(), z.string().regex(/^-?\d+(\.\d+)?$/)]).pipe(z.coerce.number());
const optionalNumber = requiredNumber.nullable();

/**
 * Exactly the columns `public.direct_lots()` returns (migration 035), in the
 * same order. `.strict()`: an unexpected key means the function and this
 * module have drifted apart, which must fail the integration test, not be
 * silently ignored.
 */
export const directLotRowSchema = z
  .object({
    id: requiredNumber.pipe(z.number().int().positive()),
    name: z.string().min(1),
    slug: z.string().min(1),
    airport_code: z.string().regex(/^[A-Z]{3}$/),
    reslab_location_id: optionalNumber.pipe(z.number().int().nullable()),
    description_short: z.string().nullable(),
    content: z.unknown().nullable(),
    seo_meta_title: z.string().nullable(),
    seo_meta_description: z.string().nullable(),
    featured_image_url: z.string().nullable(),
    featured_image_alt: z.string().nullable(),
    gallery_urls: z.array(z.string().nullable()),
    distance_to_terminal_minutes: optionalNumber,
    shuttle_details: z.string().nullable(),
    shuttle_phone: z.string().nullable(),
    address_street: z.string().min(1),
    address_city: z.string().min(1),
    address_state: z.string().regex(/^[A-Z]{2}$/),
    address_zip: z.string().min(1),
    lat: requiredNumber.pipe(z.number().min(-90).max(90)),
    lng: requiredNumber.pipe(z.number().min(-180).max(180)),
    booking_instructions: z.object({
      beforeArrival: z.string().nullable(),
      whenYouArrive: z.string().nullable(),
      importantNotes: z.string().nullable(),
      whenYouReturn: z.string().nullable(),
      gettingToAirport: z.string().nullable(),
    }),
    faqs: z.array(z.object({ question: z.string(), answer: z.unknown() })),
    amenities: z.array(z.object({ id: requiredNumber, name: z.string(), icon: z.string().nullable() })),
    is_active: z.boolean(),
    visibility: z.string(),
    min_stay_days: optionalNumber,
    min_lead_hours: optionalNumber,
    base_daily_rate: requiredNumber.pipe(z.number().positive()),
    tax_rate_percent: requiredNumber.pipe(z.number().min(0).max(100)),
    tax_collected_by: z.enum(["triply", "lot"]),
    partner_share_percent: requiredNumber.pipe(z.number().min(0).max(100)),
    notification_emails: z.array(z.string()),
    status: z.enum(["draft", "published"]),
    published_at: z.string().nullable(),
    updated_at: z.string(),
  })
  .strict();
export type DirectLotRow = z.infer<typeof directLotRowSchema>;
export const DIRECT_LOT_ROW_KEYS = Object.keys(directLotRowSchema.shape).sort();

/** The app-side shape: parsed, resolved, with airport-derived fields. */
export interface DirectLot {
  id: string;
  payloadId: number;
  name: string;
  slug: string;
  airportCode: string;
  timezone: string;
  reslabLocationId: number | null;
  descriptionShort: string | null;
  content: unknown;
  seo: { metaTitle: string | null; metaDescription: string | null };
  featuredImage: { url: string; alt: string | null } | null;
  galleryUrls: string[];
  distanceToTerminalMinutes: number | null;
  shuttleDetails: string | null;
  shuttlePhone: string | null;
  address: { street: string; city: string; state: string; zip: string };
  coordinates: { lat: number; lng: number };
  bookingInstructions: DirectLotRow["booking_instructions"];
  faqs: DirectLotRow["faqs"];
  amenities: Array<{ id: number; name: string; icon: string | null }>;
  isActive: boolean;
  visibility: DirectLotVisibility;
  status: "draft" | "published";
  minStayDays: number;
  minLeadHours: number;
  /** Integer cents. */
  rateCents: number;
  taxRatePercent: number;
  taxCollectedBy: "triply" | "lot";
  /** Partner-facing — must never reach a browser (Phase 2 adapter omits it). */
  partnerSharePercent: number;
  /** Partner-facing — must never reach a browser. */
  notificationEmails: string[];
  updatedAt: string;
}

export const DIRECT_LOT_ID_PREFIX = "direct-";
export const directLotUnifiedId = (payloadId: number): string => `${DIRECT_LOT_ID_PREFIX}${payloadId}`;
/** Canonical form only: "direct-7" → 7; "direct-007" → null. */
export function parseDirectLotUnifiedId(id: string): number | null {
  const m = /^direct-(\d{1,9})$/.exec(id);
  if (!m) return null;
  const n = Number(m[1]);
  return directLotUnifiedId(n) === id ? n : null;
}

/** Pure: row → DirectLot, or null with a reason (field path + issue, never values). */
export function directLotFromRow(raw: unknown): { lot: DirectLot } | { lot: null; reason: string } {
  const parsed = directLotRowSchema.safeParse(raw);
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    return { lot: null, reason: `row does not match direct_lots() shape at ${i?.path.join(".") || "(root)"}: ${i?.code}` };
  }
  const r = parsed.data;
  const visibility = parseVisibility(r.visibility);
  if (!visibility) return { lot: null, reason: "unknown visibility value" };
  const airport = getAirportByCode(r.airport_code);
  if (!airport || !airport.enabled) return { lot: null, reason: `airport '${r.airport_code}' is not configured or not enabled` };
  const rateCents = Math.round(r.base_daily_rate * 100);
  if (rateCents <= 0) return { lot: null, reason: "non-positive rate" };
  return {
    lot: {
      id: directLotUnifiedId(r.id),
      payloadId: r.id,
      name: r.name,
      slug: r.slug,
      airportCode: r.airport_code,
      timezone: airport.timezone,
      reslabLocationId: r.reslab_location_id,
      descriptionShort: r.description_short,
      content: r.content ?? null,
      seo: { metaTitle: r.seo_meta_title, metaDescription: r.seo_meta_description },
      featuredImage: r.featured_image_url ? { url: resolveCmsImageUrl(r.featured_image_url), alt: r.featured_image_alt } : null,
      // A media row mid-upload has a NULL url; that is cosmetic, never a reason to hide the lot.
      galleryUrls: r.gallery_urls.filter((u): u is string => !!u).map(resolveCmsImageUrl),
      distanceToTerminalMinutes: r.distance_to_terminal_minutes,
      shuttleDetails: r.shuttle_details,
      shuttlePhone: r.shuttle_phone,
      address: { street: r.address_street, city: r.address_city, state: r.address_state, zip: r.address_zip },
      coordinates: { lat: r.lat, lng: r.lng },
      bookingInstructions: r.booking_instructions,
      faqs: r.faqs,
      amenities: r.amenities,
      isActive: r.is_active,
      visibility,
      status: r.status,
      // Lot-configuration defaults (not customer data): the CMS defaults these to
      // 1 and 2, but Payload stores NULL if an editor clears the box. The
      // collection defaults are the documented meaning of "blank".
      minStayDays: Math.max(1, Math.round(r.min_stay_days ?? 1)),
      minLeadHours: Math.max(0, r.min_lead_hours ?? 2),
      rateCents,
      taxRatePercent: r.tax_rate_percent,
      taxCollectedBy: r.tax_collected_by,
      partnerSharePercent: r.partner_share_percent,
      notificationEmails: r.notification_emails,
      updatedAt: r.updated_at,
    },
  };
}

/**
 * Published + active + visible in THIS environment. The environment is
 * resolved here (B11); the parameter exists for tests only.
 */
export function isSellable(lot: DirectLot, env: string = resolveEnv()): boolean {
  return lot.status === "published" && lot.isActive && isDirectLotVisible(lot.visibility, env);
}

export type DirectLotsFailureKind = "misconfigured" | "timeout" | "unavailable";
export type DirectLotsResult =
  | { ok: true; lots: DirectLot[]; dropped: number }
  | { ok: false; kind: DirectLotsFailureKind; code: string; message: string };

// 42501 grant revoked · 42883/PGRST202/PGRST203 function missing or ambiguous ·
// 42P01/3F000 table or schema missing · 42703 column renamed under the function ·
// 42804 column type changed (RETURN QUERY shape mismatch) · PGRST301 JWT/role.
const MISCONFIGURED_CODES = new Set(["42501", "42883", "42P01", "42703", "42804", "3F000", "PGRST202", "PGRST203", "PGRST301"]);

function classifyFailure(code: string, message: string): DirectLotsFailureKind {
  if (MISCONFIGURED_CODES.has(code)) return "misconfigured";
  if (!code && /AbortError|TimeoutError|aborted/i.test(message)) return "timeout";
  return "unavailable";
}

// Review H2: one bad CMS row or a revoked grant must not fire a Sentry event
// on every search. One capture per instance per (stage, key) per 5 minutes;
// the count of suppressed repeats rides along on the next one.
const CAPTURE_INTERVAL_MS = 5 * 60 * 1000;
const lastCaptureAt = new Map<string, number>();
const suppressed = new Map<string, number>();
/** Tests only: a fresh instance between cases. */
export function __resetCaptureThrottleForTests(): void {
  lastCaptureAt.clear();
  suppressed.clear();
}
function captureThrottled(key: string, error: Error, context: { endpoint: string; stage: string; code?: string; extra?: Record<string, unknown> }) {
  const now = Date.now();
  const last = lastCaptureAt.get(key) ?? 0;
  if (now - last < CAPTURE_INTERVAL_MS) {
    suppressed.set(key, (suppressed.get(key) ?? 0) + 1);
    return;
  }
  lastCaptureAt.set(key, now);
  const n = suppressed.get(key) ?? 0;
  suppressed.set(key, 0);
  captureAPIError(error, {
    endpoint: context.endpoint,
    method: "GET",
    stage: context.stage,
    code: context.code,
    extra: { ...context.extra, suppressedSinceLastCapture: n },
  });
}

/**
 * All direct lots (optionally for one airport / one id), parsed, with
 * unparseable rows dropped and reported. Callers apply `isSellable` — kept
 * separate so admin/ops views can see inactive lots.
 */
export async function fetchDirectLots(
  filter: { airportCode?: string; payloadId?: number } = {},
  endpoint = "direct_lots",
): Promise<DirectLotsResult> {
  const airportCode = filter.airportCode?.trim().toUpperCase() ?? null;
  try {
    const supabase = await createAdminClient();
    const { data, error } = await supabase
      .rpc("direct_lots", { p_airport_code: airportCode, p_id: filter.payloadId ?? null })
      .abortSignal(AbortSignal.timeout(DB_TIMEOUT_MS));
    if (error) {
      const kind = classifyFailure(error.code ?? "", error.message ?? "");
      captureThrottled(`read:${kind}:${error.code}`, new Error(`direct_lots: read failed (${kind}) — ${error.message}`), {
        endpoint,
        stage: "direct_lots_read",
        code: error.code || undefined,
        extra: { kind, details: error.details ?? null, hint: error.hint ?? null },
      });
      return { ok: false, kind, code: error.code ?? "", message: error.message ?? "" };
    }
    if (!Array.isArray(data)) {
      captureThrottled("read:shape", new Error(`direct_lots: unexpected response shape (${typeof data})`), { endpoint, stage: "direct_lots_read" });
      return { ok: false, kind: "unavailable", code: "", message: "unexpected response shape" };
    }
    const lots: DirectLot[] = [];
    const reasons: string[] = [];
    for (const raw of data as unknown[]) {
      const out = directLotFromRow(raw);
      if (out.lot) lots.push(out.lot);
      else reasons.push(out.reason);
    }
    // One throttle key per DISTINCT reason, so a lot that stays broken can never
    // hide a newly broken one behind its key (reasons are field path + issue
    // code, never values, so cardinality stays bounded).
    for (const reason of new Set(reasons)) {
      captureThrottled(`parse:${reason}`, new Error(`direct_lots: row(s) dropped — ${reason}`), {
        endpoint,
        stage: "direct_lots_parse",
        extra: { droppedTotal: reasons.length, withThisReason: reasons.filter((x) => x === reason).length },
      });
    }
    return { ok: true, lots, dropped: reasons.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const kind = classifyFailure("", message);
    captureThrottled(`throw:${kind}`, new Error(`direct_lots: read threw (${kind}) — ${message}`), { endpoint, stage: "direct_lots_read", extra: { kind } });
    return { ok: false, kind, code: "", message };
  }
}

/** Sellable lots for an airport in this environment (what search merges in). */
export async function fetchSellableDirectLots(airportCode: string, endpoint?: string, env: string = resolveEnv()): Promise<DirectLotsResult> {
  const r = await fetchDirectLots({ airportCode }, endpoint);
  return r.ok ? { ...r, lots: r.lots.filter((l) => isSellable(l, env)) } : r;
}

export type DirectLotLookup =
  | { status: "found"; lot: DirectLot }
  | { status: "not_found" }
  /** The row exists but does not parse — a broken CMS record, never "no such lot". */
  | { status: "invalid"; reason: string }
  | { status: "unavailable"; kind: DirectLotsFailureKind; message: string };

/** One lot by Payload id. Does NOT apply `isSellable` — callers decide what a non-sellable hit means. */
export async function fetchDirectLot(payloadId: number, endpoint = "direct_lots"): Promise<DirectLotLookup> {
  if (!Number.isInteger(payloadId) || payloadId <= 0) return { status: "not_found" };
  const r = await fetchDirectLots({ payloadId }, endpoint);
  if (!r.ok) return { status: "unavailable", kind: r.kind, message: r.message };
  if (r.lots.length > 0) return { status: "found", lot: r.lots[0] };
  if (r.dropped > 0) return { status: "invalid", reason: "row did not parse (see Sentry direct_lots_parse)" };
  return { status: "not_found" };
}
