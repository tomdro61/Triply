/**
 * LiteAPI search + rates → `HotelOffer` (the one shape the rest of Park & Stay
 * consumes). Shapes verified against the sandbox on 2026-09-24 (plan §2.2,
 * "Phase A findings").
 *
 * Mapping rules (plan §2.1 / §2.3):
 * - TOTAL mapping of every supplier string we branch on. An unrecognised
 *   `refundableTag` becomes non-refundable + an anomaly; an unrecognised
 *   `taxesAndFees.description` stays "payable at the hotel" + an anomaly. The
 *   caller reports anomalies (one Sentry event per distinct anomaly per
 *   process) — this module never imports Sentry so it stays pure and testable.
 * - The cheapest USD rate per hotel is the offer. Non-USD rates are skipped.
 * - Photo URLs go through `safePhotoUrl()`; a rejected host is an anomaly.
 */

import { liteApiRequest, type LiteApiRateLimit } from "./client";
import { safePhotoUrl } from "../photo-hosts";
import { refundabilityFromPolicies, type LiteApiCancellationPolicies } from "../cancellation";
import type { RoomRefundability } from "../refundability";
import { dollarsToCents } from "../pricing";
import { LITEAPI_SHUTTLE_FACILITY_IDS } from "../plans";

// ───────────────────────────── wire shapes ─────────────────────────────

export interface LiteApiHotelSummary {
  id: string;
  name: string;
  hotelDescription?: string;
  chain?: string;
  currency?: string;
  country?: string;
  city?: string;
  latitude?: number;
  longitude?: number;
  address?: string;
  zip?: string;
  main_photo?: string;
  thumbnail?: string;
  stars?: number;
  rating?: number;
  reviewCount?: number;
  facilityIds?: number[];
  deletedAt?: string | null;
}

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

interface LiteApiHotelsResponse {
  data?: LiteApiHotelSummary[];
}
interface LiteApiRatesResponse {
  data?: LiteApiHotelRates[];
  sandbox?: boolean;
}

// ───────────────────────────── domain shape ─────────────────────────────

/**
 * `taxesAndFees.description` values we have SEEN and understood. Anything else
 * is still treated as payable at the hotel (the conservative direction) and
 * reported so this list can grow. Never used to decide collection — Q10.
 */
export const KNOWN_PROPERTY_FEE_DESCRIPTIONS: ReadonlySet<string> = new Set(["City tax", "TAX"]);

export interface PropertyFeeDueAtHotel {
  description: string;
  cents: number;
}

export interface HotelOffer {
  hotelId: string;
  name: string;
  stars: number | null;
  /** LiteAPI's guest rating (0–10) when present; display-only. */
  rating: number | null;
  reviewCount: number | null;
  address: string;
  city: string;
  latitude: number;
  longitude: number;
  /** Great-circle distance from the airport point, metres (integer). */
  distanceM: number;
  /** Allowlisted https URL, or null → placeholder. */
  photoUrl: string | null;
  shuttle: boolean;
  offer: {
    offerId: string;
    rateId: string;
    roomName: string;
    boardName: string | null;
    /** `retailRate.total` at margin 0, cents. */
    roomNetCents: number;
    sspCents: number | null;
    propertyFeesDueAtHotel: PropertyFeeDueAtHotel[];
    propertyFeesDueAtHotelCents: number;
    refundability: RoomRefundability;
    /** Verbatim, for the Phase A payment-type measurement and Phase B. */
    paymentTypes: string[];
    /** Verbatim policies, stored later on the row (plan §3). */
    cancellationPolicies: LiteApiCancellationPolicies | null;
    /** Verbatim taxes and fees, stored later on the row. */
    taxesAndFees: LiteApiTaxOrFee[];
  };
}

export interface RatesMappingResult {
  offers: HotelOffer[];
  /** Distinct anomaly strings; the caller reports each once. */
  anomalies: string[];
  /** Hotels that returned rates but none we could price (non-USD, malformed). */
  unpriceable: number;
  sandbox: boolean | null;
  rateLimit: LiteApiRateLimit;
  ratesDurationMs: number;
}

// ───────────────────────────── helpers ─────────────────────────────

const EARTH_RADIUS_M = 6_371_000;

export function distanceMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a)));
}

function usdCents(list: LiteApiMoney[] | undefined): number | null {
  const m = list?.find((x) => x.currency === "USD" && Number.isFinite(x.amount));
  return m ? dollarsToCents(m.amount) : null;
}

/** Pure: pick the cheapest USD rate for one hotel and map it. Exported for tests. */
export function mapHotelOffer(
  summary: LiteApiHotelSummary,
  rates: LiteApiHotelRates,
  airport: { latitude: number; longitude: number; timezone: string },
  anomalies: Set<string>
): HotelOffer | null {
  let best: { rt: LiteApiRoomType; rate: LiteApiRate; net: number } | null = null;
  for (const rt of rates.roomTypes ?? []) {
    for (const rate of rt.rates ?? []) {
      const net = usdCents(rate.retailRate?.total);
      if (net === null) continue;
      if (best === null || net < best.net) best = { rt, rate, net };
    }
  }
  if (!best) return null;
  const { rt, rate, net } = best;

  const fees: PropertyFeeDueAtHotel[] = [];
  const taxesAndFees = rate.retailRate?.taxesAndFees ?? [];
  for (const tf of taxesAndFees) {
    if (tf.included !== false) continue;
    if (tf.currency && tf.currency !== "USD") {
      anomalies.add(`taxesAndFees entry in ${tf.currency} on hotel ${summary.id} — skipped`);
      continue;
    }
    const description = (tf.description ?? "").trim() || "(no description)";
    if (!KNOWN_PROPERTY_FEE_DESCRIPTIONS.has(description)) {
      anomalies.add(`unrecognised taxesAndFees.description ${JSON.stringify(description)} — treated as payable at the hotel`);
    }
    fees.push({ description, cents: dollarsToCents(tf.amount) });
  }

  const { refundability, anomaly } = refundabilityFromPolicies(rate.cancellationPolicies, airport.timezone);
  if (anomaly) anomalies.add(`${anomaly} (hotel ${summary.id})`);

  const photo = safePhotoUrl(summary.main_photo ?? summary.thumbnail);
  if (photo.rejectedHost) anomalies.add(`photo host rejected: ${photo.rejectedHost}`);

  const lat = summary.latitude ?? NaN;
  const lng = summary.longitude ?? NaN;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    anomalies.add(`hotel ${summary.id} has no coordinates — skipped`);
    return null;
  }

  return {
    hotelId: summary.id,
    name: summary.name,
    stars: typeof summary.stars === "number" ? summary.stars : null,
    rating: typeof summary.rating === "number" ? summary.rating : null,
    reviewCount: typeof summary.reviewCount === "number" ? summary.reviewCount : null,
    address: summary.address ?? "",
    city: summary.city ?? "",
    latitude: lat,
    longitude: lng,
    distanceM: distanceMeters(airport.latitude, airport.longitude, lat, lng),
    photoUrl: photo.url,
    shuttle: (summary.facilityIds ?? []).some((id) => LITEAPI_SHUTTLE_FACILITY_IDS.has(id)),
    offer: {
      offerId: rt.offerId,
      rateId: rate.rateId,
      roomName: rate.name ?? "Room",
      boardName: rate.boardName ?? null,
      roomNetCents: net,
      sspCents: usdCents(rate.retailRate?.suggestedSellingPrice),
      propertyFeesDueAtHotel: fees,
      propertyFeesDueAtHotelCents: fees.reduce((s, f) => s + f.cents, 0),
      refundability,
      paymentTypes: rate.paymentTypes ?? rt.paymentTypes ?? [],
      cancellationPolicies: rate.cancellationPolicies ?? null,
      taxesAndFees,
    },
  };
}

// ───────────────────────────── network ─────────────────────────────

export async function searchHotelsNear(
  latitude: number,
  longitude: number,
  radiusM: number,
  limit: number
): Promise<{ hotels: LiteApiHotelSummary[]; rateLimit: LiteApiRateLimit; durationMs: number }> {
  const q = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    radius: String(radiusM),
    limit: String(limit),
  });
  const r = await liteApiRequest<LiteApiHotelsResponse>("data", `/data/hotels?${q}`);
  const hotels = (r.data.data ?? []).filter((h) => !h.deletedAt);
  return { hotels, rateLimit: r.rateLimit, durationMs: r.durationMs };
}

export async function fetchRates(params: {
  hotelIds: string[];
  checkin: string;
  checkout: string;
  adults: number;
}): Promise<{ hotels: LiteApiHotelRates[]; sandbox: boolean | null; rateLimit: LiteApiRateLimit; durationMs: number }> {
  const r = await liteApiRequest<LiteApiRatesResponse>("data", "/hotels/rates", {
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
    },
    timeoutMs: 15_000,
  });
  return {
    hotels: r.data.data ?? [],
    sandbox: typeof r.data.sandbox === "boolean" ? r.data.sandbox : null,
    rateLimit: r.rateLimit,
    durationMs: r.durationMs,
  };
}

/** Search + price + map, sorted by room net ascending (the route re-sorts by package total). */
export async function priceHotelsNear(params: {
  airport: { latitude: number; longitude: number; timezone: string };
  radiusM: number;
  maxHotels: number;
  checkin: string;
  checkout: string;
  adults: number;
}): Promise<RatesMappingResult> {
  const anomalies = new Set<string>();
  const found = await searchHotelsNear(params.airport.latitude, params.airport.longitude, params.radiusM, params.maxHotels);
  if (found.hotels.length === 0) {
    return { offers: [], anomalies: [], unpriceable: 0, sandbox: null, rateLimit: found.rateLimit, ratesDurationMs: 0 };
  }
  const byId = new Map(found.hotels.map((h) => [h.id, h]));
  const priced = await fetchRates({
    hotelIds: found.hotels.map((h) => h.id),
    checkin: params.checkin,
    checkout: params.checkout,
    adults: params.adults,
  });
  const offers: HotelOffer[] = [];
  let unpriceable = 0;
  for (const hr of priced.hotels) {
    const summary = byId.get(hr.hotelId);
    if (!summary) {
      anomalies.add(`rates returned for unknown hotelId ${hr.hotelId}`);
      continue;
    }
    const offer = mapHotelOffer(summary, hr, params.airport, anomalies);
    if (offer) offers.push(offer);
    else unpriceable++;
  }
  offers.sort((a, b) => a.offer.roomNetCents - b.offer.roomNetCents);
  return {
    offers,
    anomalies: [...anomalies],
    unpriceable,
    sandbox: priced.sandbox,
    rateLimit: priced.rateLimit,
    ratesDurationMs: priced.durationMs,
  };
}
