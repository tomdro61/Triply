/**
 * GET /api/park-stay/search — Park & Stay results (Phase A: read-only).
 *
 * Plan: notes/2026-09-18-park-and-stay-plan-v2.md §1, §5, §7.
 *
 * Every input is validated here with NO fallbacks: parking dates AND times
 * are required (the package total is a firm number and parking is billed by
 * day), adults 1–4 is required (occupancy changes the rate), the night is an
 * enum. The hotel night is DERIVED server-side from the parking window and
 * never accepted from the client.
 *
 * Failure posture: a LiteAPI or ResLab failure is a 503 with `no-store`,
 * never an empty "no hotels" body that a CDN could cache (the 2026-06-29
 * search incident). Supplier anomalies (unknown tags, fee descriptions,
 * photo hosts) are reported once per distinct string per process.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { airportsByCode } from "@/config/airports";
import { searchParking, isLocationBackoffError } from "@/lib/reslab/search";
import { calculateServiceFee } from "@/lib/utils/service-fee";
import { captureAPIError } from "@/lib/sentry";
import { maxAdvanceBookingDate, toLocalISODate } from "@/lib/booking-window";
import { checkParkStaySearchRateLimit } from "@/lib/attribution/limiter";
import { isParkStayEnabledFor } from "@/lib/hotels/flags";
import {
  PARK_STAY_NIGHTS,
  PARK_STAY_MIN_ADULTS,
  PARK_STAY_MAX_ADULTS,
  PARK_STAY_HOTEL_RADIUS_M,
  PARK_STAY_MAX_HOTELS_PRICED,
  PARK_STAY_SEARCH_CACHE_TTL_MS,
  HOTEL_MARGIN_PERCENT,
} from "@/lib/hotels/plans";
import { deriveHotelNight, isHotelCheckinBookable, shiftIsoDate, todayInZone } from "@/lib/hotels/dates";
import { pickParkingLot } from "@/lib/hotels/pairing";
import { priceHotelsNear } from "@/lib/hotels/liteapi/rates";
import { LiteApiError } from "@/lib/hotels/liteapi/client";
import { LiteApiConfigError } from "@/lib/hotels/liteapi/env";
import { priceRoom, packagePrice, type PackagePrice } from "@/lib/hotels/pricing";
import { roomRefundabilitySummary, type RoomRefundability } from "@/lib/hotels/refundability";

// The pairing search transitively reaches the 40 s location sweep; 30 was the
// August outage configuration (plan §5).
export const maxDuration = 60;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_12H = /^\d{1,2}:\d{2}\s[AP]M$/;

const querySchema = z.object({
  airport: z.string().regex(/^[A-Za-z]{3}$/, "Airport must be a 3-letter code").transform((s) => s.toUpperCase()),
  checkin: z.string().regex(ISO_DATE, "checkin must be YYYY-MM-DD"),
  checkout: z.string().regex(ISO_DATE, "checkout must be YYYY-MM-DD"),
  checkinTime: z.string().regex(TIME_12H, "checkinTime is required (h:mm AM/PM)"),
  checkoutTime: z.string().regex(TIME_12H, "checkoutTime is required (h:mm AM/PM)"),
  adults: z.coerce.number().int().min(PARK_STAY_MIN_ADULTS).max(PARK_STAY_MAX_ADULTS),
  night: z.enum(PARK_STAY_NIGHTS),
});

/** Longest parking window a package may span (matches the waitlist/search cap). */
const MAX_PARKING_STAY_DAYS = 60;

export interface ParkStayOfferCard {
  hotelId: string;
  name: string;
  stars: number | null;
  rating: number | null;
  reviewCount: number | null;
  address: string;
  distanceM: number;
  photoUrl: string | null;
  shuttle: boolean;
  room: {
    name: string;
    boardName: string | null;
    refundability: RoomRefundability;
    refundabilitySummary: string;
  };
  price: PackagePrice;
  /** Phase B signs this into a short-lived token for /api/checkout/lot. */
  offerRef: { offerId: string; rateId: string };
}

export interface ParkStaySearchResponse {
  airport: { code: string; name: string; timezone: string };
  parking: { checkin: string; checkout: string; checkinTime: string; checkoutTime: string };
  hotel: { checkin: string; checkout: string; night: (typeof PARK_STAY_NIGHTS)[number] };
  adults: number;
  lot: { id: string; name: string; slug: string; reslabLocationId: number | null; parkingOnlineCents: number; serviceFeeCents: number } | null;
  offers: ParkStayOfferCard[];
  /** `no_parking`: no lot at this airport qualifies for a package right now. */
  status: "ok" | "no_parking" | "no_hotels";
  sandbox: boolean | null;
  diagnostics: {
    hotelsPriced: number;
    unpriceable: number;
    rejectedLots: Record<string, number>;
    ratesDurationMs: number;
    rateLimitRemaining: number | null;
    cached: boolean;
  };
}

// ── 60 s server-side micro-cache (bounded; keyed on everything that changes a price) ──
const cache = new Map<string, { at: number; body: ParkStaySearchResponse }>();
const CACHE_MAX_KEYS = 500;

function cacheGet(key: string, now: number): ParkStaySearchResponse | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (PARK_STAY_SEARCH_CACHE_TTL_MS <= 0 || now - hit.at > PARK_STAY_SEARCH_CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.body;
}
function cacheSet(key: string, body: ParkStaySearchResponse, now: number): void {
  cache.set(key, { at: now, body });
  while (cache.size > CACHE_MAX_KEYS) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}
export function __resetParkStaySearchCacheForTests(): void {
  cache.clear();
}

// ── once-per-process supplier anomaly reporting ──
const reportedAnomalies = new Set<string>();
function reportAnomalies(anomalies: string[]): void {
  for (const a of anomalies) {
    if (reportedAnomalies.has(a)) continue;
    reportedAnomalies.add(a);
    captureAPIError(new Error(`LiteAPI mapping anomaly: ${a}`), {
      endpoint: "/api/park-stay/search",
      method: "GET",
      stage: "mapping",
    });
  }
}

const NO_STORE = { "Cache-Control": "no-store" } as const;

function clientKey(request: NextRequest): string {
  const fwd = request.headers.get("x-forwarded-for");
  return (fwd ? fwd.split(",")[0] : request.headers.get("x-real-ip")) ?? "unknown";
}

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const parsed = querySchema.safeParse({
    airport: sp.get("airport") ?? "",
    checkin: sp.get("checkin") ?? "",
    checkout: sp.get("checkout") ?? "",
    checkinTime: sp.get("checkinTime") ?? "",
    checkoutTime: sp.get("checkoutTime") ?? "",
    adults: sp.get("adults") ?? "",
    night: sp.get("night") ?? "",
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid search parameters", fields: parsed.error.flatten().fieldErrors },
      { status: 400, headers: NO_STORE }
    );
  }
  const q = parsed.data;

  // Flag gate — the off-state for a non-allowlisted airport is a 404, which is
  // also the post-deploy negative control (plan §7).
  if (!isParkStayEnabledFor(q.airport)) {
    return NextResponse.json({ error: "Park & Stay is not available for this airport" }, { status: 404, headers: NO_STORE });
  }
  const airport = airportsByCode[q.airport];
  if (!airport || !airport.enabled) {
    return NextResponse.json({ error: "Invalid airport code" }, { status: 400, headers: NO_STORE });
  }

  // Date rules, evaluated in the AIRPORT's calendar, not the server's.
  const today = todayInZone(airport.timezone);
  const maxCheckin = toLocalISODate(maxAdvanceBookingDate());
  if (q.checkin < today) {
    return NextResponse.json({ error: "Check-in can't be in the past", code: "checkin_past" }, { status: 400, headers: NO_STORE });
  }
  if (q.checkin > maxCheckin) {
    return NextResponse.json({ error: "Check-in is beyond the booking window", code: "checkin_too_far" }, { status: 400, headers: NO_STORE });
  }
  if (q.checkout < q.checkin) {
    return NextResponse.json({ error: "Check-out must be on or after check-in", code: "checkout_before_checkin" }, { status: 400, headers: NO_STORE });
  }
  if (q.checkout > shiftIsoDate(q.checkin, MAX_PARKING_STAY_DAYS)) {
    return NextResponse.json({ error: "Parking stay is too long", code: "stay_too_long" }, { status: 400, headers: NO_STORE });
  }
  const night = deriveHotelNight(q.checkin, q.checkout, q.night);
  if (!isHotelCheckinBookable(night.checkin, airport.timezone)) {
    // "Night before" a same-day trip: the hotel night is already in the past at the airport.
    return NextResponse.json(
      { error: "The night before this trip has already passed. Choose the night you get back.", code: "night_unavailable" },
      { status: 400, headers: NO_STORE }
    );
  }

  if (!checkParkStaySearchRateLimit(clientKey(request))) {
    return NextResponse.json({ error: "Too many searches, please slow down" }, { status: 429, headers: NO_STORE });
  }

  const now = Date.now();
  const cacheKey = [q.airport, night.checkin, night.checkout, q.adults, q.checkin, q.checkout, q.checkinTime, q.checkoutTime].join("|");
  const cached = cacheGet(cacheKey, now);
  if (cached) {
    return NextResponse.json({ ...cached, diagnostics: { ...cached.diagnostics, cached: true } }, { headers: NO_STORE });
  }

  // ── 1. Pair the parking lot from the existing cached parking search, WITH the real times.
  let lotResult;
  try {
    lotResult = await searchParking({
      airport: q.airport,
      checkin: q.checkin,
      checkout: q.checkout,
      checkinTime: q.checkinTime,
      checkoutTime: q.checkoutTime,
      source: "search",
    });
  } catch (error) {
    if (!isLocationBackoffError(error)) {
      captureAPIError(error instanceof Error ? error : new Error(String(error)), {
        endpoint: "/api/park-stay/search",
        method: "GET",
        stage: "parking",
      });
    }
    return NextResponse.json({ error: "Parking search is temporarily unavailable" }, { status: 503, headers: NO_STORE });
  }
  const { paired, rejected } = pickParkingLot(lotResult.results);

  const base: Omit<ParkStaySearchResponse, "offers" | "status" | "sandbox" | "diagnostics" | "lot"> = {
    airport: { code: airport.code, name: airport.name, timezone: airport.timezone },
    parking: { checkin: q.checkin, checkout: q.checkout, checkinTime: q.checkinTime, checkoutTime: q.checkoutTime },
    hotel: { checkin: night.checkin, checkout: night.checkout, night: q.night },
    adults: q.adults,
  };

  if (!paired) {
    // Honest empty: not cached at the CDN, not cached here either (a lot may
    // come back on the next parking-list refresh).
    const body: ParkStaySearchResponse = {
      ...base,
      lot: null,
      offers: [],
      status: "no_parking",
      sandbox: null,
      diagnostics: { hotelsPriced: 0, unpriceable: 0, rejectedLots: rejected, ratesDurationMs: 0, rateLimitRemaining: null, cached: false },
    };
    return NextResponse.json(body, { headers: NO_STORE });
  }

  // Service fee on the parking base only (D5), in cents.
  const parkingBaseDollars = (paired.lot.pricing?.subtotal ?? 0) + (paired.lot.pricing?.feesTotal ?? 0);
  const serviceFeeCents = Math.round(calculateServiceFee(parkingBaseDollars) * 100);

  // ── 2. Hotels: search + price at margin 0, map, report anomalies once.
  let priced;
  try {
    priced = await priceHotelsNear({
      airport: { latitude: airport.latitude, longitude: airport.longitude, timezone: airport.timezone },
      radiusM: PARK_STAY_HOTEL_RADIUS_M,
      maxHotels: PARK_STAY_MAX_HOTELS_PRICED,
      checkin: night.checkin,
      checkout: night.checkout,
      adults: q.adults,
    });
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    const status = error instanceof LiteApiError ? error.statusCode : undefined;
    captureAPIError(err, {
      endpoint: "/api/park-stay/search",
      method: "GET",
      stage: error instanceof LiteApiConfigError ? "config" : "liteapi",
      statusCode: status,
      code: error instanceof LiteApiError && error.code !== undefined ? String(error.code) : undefined,
    });
    // Config error = our deploy is wrong; rate limit / transient = theirs. All 503 + no-store.
    return NextResponse.json({ error: "Hotel search is temporarily unavailable" }, { status: 503, headers: NO_STORE });
  }
  reportAnomalies(priced.anomalies);

  const offers: ParkStayOfferCard[] = priced.offers.map((h) => {
    const room = priceRoom({
      roomNetCents: h.offer.roomNetCents,
      sspCents: h.offer.sspCents,
      propertyFeesDueAtHotelCents: h.offer.propertyFeesDueAtHotelCents,
      marginPercent: HOTEL_MARGIN_PERCENT,
    });
    const price = packagePrice({
      room,
      parkingOnlineCents: paired.parkingOnlineCents,
      serviceFeeCents,
      promoDiscountCents: 0,
      // D2: never pre-selected on a package; the premium is added at checkout if chosen.
      protectionPremiumCents: 0,
    });
    return {
      hotelId: h.hotelId,
      name: h.name,
      stars: h.stars,
      rating: h.rating,
      reviewCount: h.reviewCount,
      address: h.address,
      distanceM: h.distanceM,
      photoUrl: h.photoUrl,
      shuttle: h.shuttle,
      room: {
        name: h.offer.roomName,
        boardName: h.offer.boardName,
        refundability: h.offer.refundability,
        refundabilitySummary: roomRefundabilitySummary(h.offer.refundability),
      },
      price,
      offerRef: { offerId: h.offer.offerId, rateId: h.offer.rateId },
    };
  });
  offers.sort((a, b) => a.price.headlineTotalCents - b.price.headlineTotalCents);

  const body: ParkStaySearchResponse = {
    ...base,
    lot: {
      id: paired.lot.id,
      name: paired.lot.name,
      slug: paired.lot.slug,
      reslabLocationId: paired.lot.reslabLocationId ?? null,
      parkingOnlineCents: paired.parkingOnlineCents,
      serviceFeeCents,
    },
    offers,
    status: offers.length > 0 ? "ok" : "no_hotels",
    sandbox: priced.sandbox,
    diagnostics: {
      hotelsPriced: offers.length,
      unpriceable: priced.unpriceable,
      rejectedLots: rejected,
      ratesDurationMs: priced.ratesDurationMs,
      rateLimitRemaining: priced.rateLimit.remaining,
      cached: false,
    },
  };
  // Only a non-empty, clean result is worth a 60 s reuse (an empty one may be a blip).
  if (offers.length > 0) cacheSet(cacheKey, body, now);
  return NextResponse.json(body, { headers: NO_STORE });
}
