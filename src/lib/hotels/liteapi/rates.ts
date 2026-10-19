/**
 * LiteAPI `/hotels/rates` for the MAPPED hotels only (plan v3 §6 step 5).
 *
 * - Rates are requested by `hotelIds` (the hand-checked map) — the 6 km
 *   radius search is gone (B2): a hotel without its own ResLab parking can
 *   never appear.
 * - ONE call per request, spending the caller's prepaid budget ticket (B12).
 * - Hotel content comes from the response's top-level `hotels[]` (snake_case)
 *   — no separate content calls. V2 (19 Oct, sandbox): `hotels[]` is returned
 *   for a `hotelIds` query ONLY with `includeHotelData: true`; without it the
 *   response has `data[]` alone.
 * - TOTAL mapping of every supplier string we branch on: an unrecognised
 *   `refundableTag` becomes non-refundable + an anomaly; an unrecognised
 *   `taxesAndFees.description` stays "paid at the hotel" + an anomaly. The
 *   caller reports anomalies once per process — this module never imports
 *   Sentry, so it stays pure apart from the one fetch.
 * - EVERY USD rate is mapped (B14: the leading rate is chosen after pricing,
 *   by headline total, not by net here). A hotel with a hotel-collected fee in
 *   any currency other than USD (or with no currency) is hidden, because its
 *   total could not be stated honestly (B13).
 */

import { z } from "zod";
import { LiteApiError, liteApiRequest, type LiteApiRateLimit, type LiteApiResult } from "./client";
import type { BudgetTicket } from "./budget";
import { safePhotoUrl } from "../photo-hosts";
import { normaliseRefundableTag, refundabilityFromPolicies, type RefundableTag } from "../cancellation";
import type { RoomRefundability } from "../refundability";
import { dollarsToCents } from "../pricing";
import { LITEAPI_RATES_TIMEOUT_MS } from "../plans";

// ───────────────────────────── wire shapes (validated at the boundary) ─────────────────────────────
//
// The 200 body is untrusted JSON. The top level must be `{ data: [...] }` —
// an error body or anything else is a LiteApiError (→ 503), never "sold out".
// Each room type and rate is parsed on its own, so one odd rate is skipped
// and reported instead of failing the whole search. Optional fields are
// `nullish`: LiteAPI sends nulls.

const moneySchema = z.object({ amount: z.number(), currency: z.string(), source: z.string().nullish() });
const taxOrFeeSchema = z.object({
  included: z.boolean().nullish(),
  description: z.string().nullish(),
  amount: z.number(),
  currency: z.string().nullish(),
});
const cancelInfoSchema = z.object({
  cancelTime: z.string().nullish(),
  amount: z.number().nullish(),
  currency: z.string().nullish(),
  type: z.string().nullish(),
  timezone: z.string().nullish(),
});
const policiesSchema = z.object({
  refundableTag: z.string().nullish(),
  cancelPolicyInfos: z.array(cancelInfoSchema).nullish(),
  hotelRemarks: z.array(z.string()).nullish(),
});
const rateSchema = z.object({
  rateId: z.string().min(1),
  name: z.string().nullish(),
  boardType: z.string().nullish(),
  boardName: z.string().nullish(),
  retailRate: z
    .object({
      total: z.array(moneySchema).nullish(),
      suggestedSellingPrice: z.array(moneySchema).nullish(),
      taxesAndFees: z.array(taxOrFeeSchema).nullish(),
    })
    .nullish(),
  cancellationPolicies: policiesSchema.nullish(),
  paymentTypes: z.array(z.string()).nullish(),
});
const roomTypeSchema = z.object({
  roomTypeId: z.string().nullish(),
  offerId: z.string().min(1),
  rates: z.array(z.unknown()).nullish(),
  paymentTypes: z.array(z.string()).nullish(),
});
const hotelRatesSchema = z.object({ hotelId: z.string().min(1), roomTypes: z.array(z.unknown()).nullish() });
const contentSchema = z.object({
  id: z.string().min(1),
  name: z.string().nullish(),
  main_photo: z.string().nullish(),
  thumbnail: z.string().nullish(),
  address: z.string().nullish(),
  country_code: z.string().nullish(),
  city_name: z.string().nullish(),
  latitude: z.number().nullish(),
  longitude: z.number().nullish(),
  rating: z.number().nullish(),
  stars: z.number().nullish(),
  review_count: z.number().nullish(),
});
const ratesBodySchema = z.object({
  data: z.array(z.unknown()),
  hotels: z.array(z.unknown()).nullish(),
  sandbox: z.boolean().nullish(),
});

export type LiteApiTaxOrFee = z.infer<typeof taxOrFeeSchema>;
export type LiteApiRate = z.infer<typeof rateSchema>;
type LiteApiMoney = z.infer<typeof moneySchema>;
/** A room type as tests build it; on the wire its `rates` are validated one by one. */
export interface LiteApiRoomType {
  roomTypeId?: string | null;
  offerId: string;
  rates?: readonly unknown[] | null;
  paymentTypes?: string[] | null;
}
export interface LiteApiHotelRates {
  hotelId: string;
  roomTypes?: readonly unknown[] | null;
}
/** One entry of the top-level `hotels[]` block (snake_case, per the 15 Oct and 19 Oct samples). */
export type LiteApiHotelContentWire = z.infer<typeof contentSchema>;

/** LiteAPI's "no availability" error code on /hotels/rates — a genuine empty, not an outage. */
export const LITEAPI_NO_AVAILABILITY_CODE = 2001;

// ───────────────────────────── domain shapes ─────────────────────────────

/**
 * `taxesAndFees.description` values we have SEEN and understood. Anything else
 * is still treated as paid at the hotel (the conservative direction) and
 * reported so this list can grow. Never used to decide collection — M16.
 */
export const KNOWN_PROPERTY_FEE_DESCRIPTIONS: ReadonlySet<string> = new Set(["City tax", "TAX"]);

export interface PropertyFeeDueAtHotel {
  description: string;
  cents: number;
}

export interface HotelContent {
  hotelId: string;
  name: string;
  /** Allowlisted https URL, or null → placeholder. */
  photoUrl: string | null;
  stars: number | null;
  /** LiteAPI's guest rating (0–10) when present; display-only. */
  rating: number | null;
  reviewCount: number | null;
  address: string;
  city: string;
  latitude: number | null;
  longitude: number | null;
}

export interface MappedRate {
  offerId: string;
  rateId: string;
  roomTypeId: string | null;
  /** Stable across searches for the same room offer: `${roomTypeId}|${boardType}|${refundableTag}` (L-M5). */
  roomKey: string;
  roomName: string;
  boardType: string | null;
  boardName: string | null;
  refundableTag: RefundableTag;
  refundability: RoomRefundability;
  /** `retailRate.total` at margin 0, cents. */
  roomNetCents: number;
  sspCents: number | null;
  propertyFeesDueAtHotel: PropertyFeeDueAtHotel[];
  propertyFeesDueAtHotelCents: number;
  /** Verbatim, for Phase B. */
  paymentTypes: string[];
}

export interface HotelRatesMapped {
  hotelId: string;
  /** Every USD rate; empty when the hotel returned none we can price. */
  rates: MappedRate[];
  /**
   * Non-null hides the hotel: a hotel-collected fee we can't state in USD
   * (B13, a policy hide), or rates we received but could not read (a DATA
   * failure — the caller marks the search partial and reports it).
   */
  hiddenReason: "non_usd_collected_fee" | "rates_malformed" | null;
  /** Room types / rates that failed validation (each also an anomaly). */
  malformed: number;
}

export interface ParkStayRatesResult {
  rates: Map<string, HotelRatesMapped>;
  content: Map<string, HotelContent>;
  /** Distinct anomaly strings; the caller reports each once. */
  anomalies: string[];
  sandbox: boolean | null;
  rateLimit: LiteApiRateLimit;
  durationMs: number;
}

// ───────────────────────────── mapping (pure) ─────────────────────────────

function usdCents(list: readonly LiteApiMoney[] | null | undefined): number | null {
  const m = list?.find((x) => x.currency === "USD" && Number.isFinite(x.amount) && x.amount >= 0);
  return m ? dollarsToCents(m.amount) : null;
}

const finiteOrNull = (v: number | null | undefined): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

const issuePaths = (issues: readonly { path: readonly PropertyKey[] }[]) =>
  issues.map((i) => i.path.map(String).join(".")).join(", ").slice(0, 120);

/** Map one hotel's rates. `now` decides whether a free-cancellation deadline has passed. Exported for tests. */
export function mapHotelRates(hr: LiteApiHotelRates, hotelTimeZone: string, now: Date, anomalies: Set<string>): HotelRatesMapped {
  const rates: MappedRate[] = [];
  let hiddenReason: HotelRatesMapped["hiddenReason"] = null;
  let malformed = 0;
  for (const rawRt of hr.roomTypes ?? []) {
    const rtParsed = roomTypeSchema.safeParse(rawRt);
    if (!rtParsed.success) {
      malformed++;
      anomalies.add(`malformed roomType on hotel ${hr.hotelId} (${issuePaths(rtParsed.error.issues)}) — skipped`);
      continue;
    }
    const rt = rtParsed.data;
    for (const rawRate of rt.rates ?? []) {
      const rateParsed = rateSchema.safeParse(rawRate);
      if (!rateParsed.success) {
        malformed++;
        anomalies.add(`malformed rate on hotel ${hr.hotelId} (${issuePaths(rateParsed.error.issues)}) — skipped`);
        continue;
      }
      const rate = rateParsed.data;
      const net = usdCents(rate.retailRate?.total);
      if (net === null) continue; // a non-USD rate is never priced
      const fees: PropertyFeeDueAtHotel[] = [];
      for (const tf of rate.retailRate?.taxesAndFees ?? []) {
        if (tf.included === true) continue;
        if (tf.included !== false) {
          // The file's rule: anything not confirmed as included is paid at the hotel.
          anomalies.add(`taxesAndFees entry without "included" on hotel ${hr.hotelId} — treated as paid at the hotel`);
        }
        if (tf.currency !== "USD" || !Number.isFinite(tf.amount) || tf.amount < 0) {
          anomalies.add(`hotel-collected fee in ${JSON.stringify(tf.currency ?? null)} (amount ${tf.amount}) on hotel ${hr.hotelId} — hotel hidden`);
          hiddenReason = "non_usd_collected_fee";
          continue;
        }
        const description = (tf.description ?? "").trim() || "(no description)";
        if (!KNOWN_PROPERTY_FEE_DESCRIPTIONS.has(description)) {
          anomalies.add(`unrecognised taxesAndFees.description ${JSON.stringify(description)} — treated as paid at the hotel`);
        }
        fees.push({ description, cents: dollarsToCents(tf.amount) });
      }
      const { tag, anomaly: tagAnomaly } = normaliseRefundableTag(rate.cancellationPolicies?.refundableTag);
      if (tagAnomaly) anomalies.add(`${tagAnomaly} (hotel ${hr.hotelId})`);
      const { refundability, anomaly } = refundabilityFromPolicies(rate.cancellationPolicies, hotelTimeZone, now);
      if (anomaly && anomaly !== tagAnomaly) anomalies.add(`${anomaly} (hotel ${hr.hotelId})`);
      const roomTypeId = typeof rt.roomTypeId === "string" && rt.roomTypeId.length > 0 ? rt.roomTypeId : null;
      const boardType = typeof rate.boardType === "string" && rate.boardType.length > 0 ? rate.boardType : null;
      rates.push({
        offerId: rt.offerId,
        rateId: rate.rateId,
        roomTypeId,
        roomKey: `${roomTypeId ?? "none"}|${boardType ?? "none"}|${tag}`,
        roomName: rate.name?.trim() || "Room",
        boardType,
        boardName: rate.boardName?.trim() || null,
        refundableTag: tag,
        refundability,
        roomNetCents: net,
        sspCents: usdCents(rate.retailRate?.suggestedSellingPrice),
        propertyFeesDueAtHotel: fees,
        propertyFeesDueAtHotelCents: fees.reduce((sum, f) => sum + f.cents, 0),
        paymentTypes: rate.paymentTypes ?? rt.paymentTypes ?? [],
      });
    }
  }
  if (hiddenReason === null && rates.length === 0 && malformed > 0) hiddenReason = "rates_malformed";
  return { hotelId: hr.hotelId, rates, hiddenReason, malformed };
}

/** Map one `hotels[]` entry. Exported for tests. */
export function mapHotelContent(h: LiteApiHotelContentWire, anomalies: Set<string>): HotelContent {
  const photo = safePhotoUrl(h.main_photo ?? h.thumbnail);
  if (photo.rejectedHost) anomalies.add(`photo host rejected: ${photo.rejectedHost}`);
  return {
    hotelId: h.id,
    name: (h.name ?? "").trim(),
    photoUrl: photo.url,
    stars: finiteOrNull(h.stars),
    rating: finiteOrNull(h.rating),
    reviewCount: finiteOrNull(h.review_count),
    address: (h.address ?? "").trim(),
    city: (h.city_name ?? "").trim(),
    latitude: finiteOrNull(h.latitude),
    longitude: finiteOrNull(h.longitude),
  };
}

// ───────────────────────────── network ─────────────────────────────

function errorBody(body: unknown): { code: number | null; description: string } | null {
  if (!body || typeof body !== "object" || !("error" in body)) return null;
  const e = body.error;
  if (!e || typeof e !== "object") return { code: null, description: "error" };
  const code = "code" in e && typeof e.code === "number" ? e.code : null;
  const description = "description" in e && typeof e.description === "string" ? e.description : "error";
  return { code, description };
}

function emptyResult(rateLimit: LiteApiRateLimit, durationMs: number): ParkStayRatesResult {
  return { rates: new Map(), content: new Map(), anomalies: [], sandbox: null, rateLimit, durationMs };
}

/**
 * Price the given hotels for one night. Spends `ticket` (the request's one
 * LiteAPI budget call). Throws `LiteApiError` / `LiteApiConfigError` — the
 * route answers 503 — and never turns a failure into an empty result:
 *   - `{ data: [...] }` (possibly empty) is the answer;
 *   - LiteAPI's no-availability code 2001, as a 200 error body or a 4xx, is a
 *     genuine empty (no rates), not an outage — no 503, no Sentry;
 *   - any other error body, a body without `data`, or non-JSON → LiteApiError 502.
 */
export async function fetchParkStayRates(params: {
  hotelIds: string[];
  checkin: string;
  checkout: string;
  adults: number;
  /** The hotel's zone: cancellation deadlines are shown on its wall clock. */
  hotelTimeZone: string;
  now: Date;
  ticket: BudgetTicket;
}): Promise<ParkStayRatesResult> {
  const anomalies = new Set<string>();
  let r: LiteApiResult;
  try {
    r = await liteApiRequest("data", "/hotels/rates", {
      meter: "prepaid",
      ticket: params.ticket,
      method: "POST",
      body: {
        hotelIds: params.hotelIds,
        checkin: params.checkin,
        checkout: params.checkout,
        occupancies: [{ adults: params.adults }],
        currency: "USD",
        guestNationality: "US",
        // NEVER rely on the dashboard margin: `total` at margin 0 is the net we
        // will be charged; the sell price is computed in pricing.ts.
        margin: 0,
        // V2: without this a hotelIds query returns no `hotels[]` content.
        includeHotelData: true,
      },
      timeoutMs: LITEAPI_RATES_TIMEOUT_MS,
    });
  } catch (err) {
    if (err instanceof LiteApiError && err.code === LITEAPI_NO_AVAILABILITY_CODE && err.statusCode >= 400 && err.statusCode < 500) {
      return emptyResult({ limit: null, remaining: null }, 0);
    }
    throw err;
  }
  const errBody = errorBody(r.data);
  if (errBody) {
    if (errBody.code === LITEAPI_NO_AVAILABILITY_CODE) return emptyResult(r.rateLimit, r.durationMs);
    throw new LiteApiError(502, `LiteAPI /hotels/rates answered 200 with an error body: ${errBody.description}`, r.data, errBody.code ?? undefined);
  }
  const body = ratesBodySchema.safeParse(r.data);
  if (!body.success) {
    throw new LiteApiError(502, `LiteAPI /hotels/rates answered 200 without a readable data[] (${issuePaths(body.error.issues) || "(root)"})`, r.data);
  }
  const wanted = new Set(params.hotelIds);
  const rates = new Map<string, HotelRatesMapped>();
  for (const raw of body.data.data) {
    const hr = hotelRatesSchema.safeParse(raw);
    if (!hr.success || !wanted.has(hr.data.hotelId)) {
      anomalies.add(`rates entry that is malformed or for an unrequested hotel: ${JSON.stringify(hr.success ? hr.data.hotelId : null)}`);
      continue;
    }
    rates.set(hr.data.hotelId, mapHotelRates(hr.data, params.hotelTimeZone, params.now, anomalies));
  }
  const content = new Map<string, HotelContent>();
  for (const raw of body.data.hotels ?? []) {
    const h = contentSchema.safeParse(raw);
    if (!h.success) {
      anomalies.add("malformed hotels[] entry — skipped (the hotel shows under the map's name)");
      continue;
    }
    if (!wanted.has(h.data.id)) continue;
    content.set(h.data.id, mapHotelContent(h.data, anomalies));
  }
  return {
    rates,
    content,
    anomalies: [...anomalies],
    sandbox: typeof body.data.sandbox === "boolean" ? body.data.sandbox : null,
    rateLimit: r.rateLimit,
    durationMs: r.durationMs,
  };
}
