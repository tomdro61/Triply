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

import { liteApiRequest, type LiteApiRateLimit } from "./client";
import type { BudgetTicket } from "./budget";
import { safePhotoUrl } from "../photo-hosts";
import { normaliseRefundableTag, refundabilityFromPolicies, type LiteApiCancellationPolicies, type RefundableTag } from "../cancellation";
import type { RoomRefundability } from "../refundability";
import { dollarsToCents } from "../pricing";
import { LITEAPI_RATES_TIMEOUT_MS } from "../plans";

// ───────────────────────────── wire shapes ─────────────────────────────

interface LiteApiMoney {
  amount: number;
  currency: string;
  source?: string;
}

export interface LiteApiTaxOrFee {
  included: boolean;
  description?: string;
  amount: number;
  currency?: string;
}

export interface LiteApiRate {
  rateId: string;
  name?: string;
  maxOccupancy?: number;
  adultCount?: number;
  boardType?: string;
  boardName?: string;
  retailRate?: {
    total?: LiteApiMoney[];
    suggestedSellingPrice?: LiteApiMoney[];
    initialPrice?: LiteApiMoney[];
    taxesAndFees?: LiteApiTaxOrFee[] | null;
  };
  cancellationPolicies?: LiteApiCancellationPolicies;
  paymentTypes?: string[];
}

export interface LiteApiRoomType {
  roomTypeId?: string;
  offerId: string;
  supplier?: string;
  supplierId?: number;
  rates?: LiteApiRate[];
  paymentTypes?: string[];
}

export interface LiteApiHotelRates {
  hotelId: string;
  roomTypes?: LiteApiRoomType[];
}

/** One entry of the top-level `hotels[]` block (snake_case, per the 15 Oct and 19 Oct samples). */
export interface LiteApiHotelContentWire {
  id: string;
  name?: string;
  main_photo?: string;
  thumbnail?: string;
  address?: string;
  country_code?: string;
  city_name?: string;
  latitude?: number;
  longitude?: number;
  rating?: number;
  stars?: number;
  review_count?: number;
}

interface LiteApiRatesResponse {
  data?: LiteApiHotelRates[];
  hotels?: LiteApiHotelContentWire[];
  sandbox?: boolean;
}

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
  /** Non-null hides the hotel (B13). */
  hiddenReason: "non_usd_collected_fee" | null;
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

function usdCents(list: LiteApiMoney[] | undefined): number | null {
  const m = list?.find((x) => x.currency === "USD" && Number.isFinite(x.amount) && x.amount >= 0);
  return m ? dollarsToCents(m.amount) : null;
}

const finiteOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Map one hotel's rates. Exported for tests. */
export function mapHotelRates(hr: LiteApiHotelRates, hotelTimeZone: string, anomalies: Set<string>): HotelRatesMapped {
  const rates: MappedRate[] = [];
  let hiddenReason: HotelRatesMapped["hiddenReason"] = null;
  for (const rt of hr.roomTypes ?? []) {
    for (const rate of rt.rates ?? []) {
      const net = usdCents(rate.retailRate?.total);
      if (net === null) continue; // a non-USD rate is never priced
      const fees: PropertyFeeDueAtHotel[] = [];
      for (const tf of rate.retailRate?.taxesAndFees ?? []) {
        if (tf.included !== false) continue;
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
      const { refundability, anomaly } = refundabilityFromPolicies(rate.cancellationPolicies, hotelTimeZone);
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
        propertyFeesDueAtHotelCents: fees.reduce((s, f) => s + f.cents, 0),
        paymentTypes: rate.paymentTypes ?? rt.paymentTypes ?? [],
      });
    }
  }
  return { hotelId: hr.hotelId, rates, hiddenReason };
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

/**
 * Price the given hotels for one night. Spends `ticket` (the request's one
 * LiteAPI budget call). Throws `LiteApiError` / `LiteApiConfigError` — the
 * route answers 503 — and never returns an empty result for a failure.
 */
export async function fetchParkStayRates(params: {
  hotelIds: string[];
  checkin: string;
  checkout: string;
  adults: number;
  /** For cancellation deadlines that carry no timezone of their own. */
  hotelTimeZone: string;
  ticket: BudgetTicket;
}): Promise<ParkStayRatesResult> {
  const anomalies = new Set<string>();
  const r = await liteApiRequest<LiteApiRatesResponse>("data", "/hotels/rates", {
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
  const wanted = new Set(params.hotelIds);
  const rates = new Map<string, HotelRatesMapped>();
  for (const hr of r.data.data ?? []) {
    if (!hr || typeof hr.hotelId !== "string" || !wanted.has(hr.hotelId)) {
      anomalies.add(`rates returned for an unrequested hotelId ${JSON.stringify(hr?.hotelId)}`);
      continue;
    }
    rates.set(hr.hotelId, mapHotelRates(hr, params.hotelTimeZone, anomalies));
  }
  const content = new Map<string, HotelContent>();
  for (const h of r.data.hotels ?? []) {
    if (!h || typeof h.id !== "string" || !wanted.has(h.id)) continue;
    content.set(h.id, mapHotelContent(h, anomalies));
  }
  return {
    rates,
    content,
    anomalies: [...anomalies],
    sandbox: typeof r.data.sandbox === "boolean" ? r.data.sandbox : null,
    rateLimit: r.rateLimit,
    durationMs: r.durationMs,
  };
}
