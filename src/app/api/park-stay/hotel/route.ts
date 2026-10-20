/**
 * GET /api/park-stay/hotel?hotelKey&airport&night&arrivalTime&returnDate&returnTime&adults
 *
 * One Park & Stay hotel, priced FRESH (plan v3 §8.1, §8.4): up to 6 rates
 * (the cheapest per room key, always including the cheapest refundable and
 * the cheapest overall), the hotel's own parking quote, and content. Same
 * checks, same single budget ticket and same failure posture as search; no
 * micro-cache — the page compares its total with the search's `seen` value
 * and says "Price updated" when they differ.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { checkParkStayHotelRateLimit } from "@/lib/attribution/limiter";
import { findEnabledHotelLot } from "@/lib/hotels/hotel-lots";
import { PARK_STAY_HOTEL_PAGE_MAX_RATES, PARK_STAY_REQUEST_BUDGET_MS } from "@/lib/hotels/plans";
import { prepareParkStay, quoteParkStayHotel, type HiddenReason, type ParkStayHotelSummary, type ParkStayRoomOffer } from "@/lib/hotels/search";
import {
  NO_STORE,
  clientKey,
  gateParkStayRequest,
  noticePeriodResponse,
  reportAnomaliesOnce,
  supplierFailure,
  takeParkStayTicket,
} from "../_lib/request";

// Same request-wide deadline as search (start + 28 s, every leg capped by what
// is left; < 3 s left → 503 without calling LiteAPI). See the search route.
export const maxDuration = 30;
export const dynamic = "force-dynamic";

const CALLER = "/api/park-stay/hotel";

const hotelKeySchema = z.string().regex(/^[a-z0-9-]{1,64}$/, "hotelKey is required");

export type ParkStayHotelResponse =
  | {
      status: "ok";
      hotel: ParkStayHotelSummary;
      leading: ParkStayRoomOffer;
      rooms: ParkStayRoomOffer[];
      search: { night: string; departureDate: string; arrivalTime: string; returnDate: string; returnTime: string; adults: number };
      sandbox: boolean | null;
    }
  | { status: "unavailable"; reason: HiddenReason };

export async function GET(request: NextRequest) {
  const nowDate = new Date();
  // The request-wide deadline (review pass 2, H1): every leg after this is
  // bounded by what is left of it.
  const deadlineMs = nowDate.getTime() + PARK_STAY_REQUEST_BUDGET_MS;
  const gate = await gateParkStayRequest(request, nowDate, CALLER);
  if (!gate.ok) return gate.response;
  const { airport, window: w, adults } = gate.request;

  const key = hotelKeySchema.safeParse(gate.params.get("hotelKey") ?? "");
  if (!key.success) {
    return NextResponse.json({ error: "Invalid hotel", fields: { hotelKey: ["hotelKey is required"] } }, { status: 400, headers: NO_STORE });
  }
  const entry = findEnabledHotelLot(airport.code, key.data);
  if (!entry) return NextResponse.json({ error: "Not found" }, { status: 404, headers: NO_STORE });

  if (!checkParkStayHotelRateLimit(clientKey(request))) {
    return NextResponse.json({ error: "Too many requests, please slow down" }, { status: 429, headers: NO_STORE });
  }

  try {
    // Account and id before the ticket (H6) — see the search route.
    const prepared = prepareParkStay([entry], airport.code, CALLER);
    const ticket = await takeParkStayTicket(CALLER);
    const outcome = await quoteParkStayHotel(
      prepared,
      { deadlineMs, airport: { code: airport.code, timezone: airport.timezone }, window: w, adults, ticket, now: nowDate, caller: CALLER },
      PARK_STAY_HOTEL_PAGE_MAX_RATES,
      (a) => reportAnomaliesOnce(CALLER, a)
    );
    // ResLab's own notice refusal arrives as an "unavailable" reason; it gets the same answer (M3).
    if (outcome.kind === "notice_period" || (outcome.kind === "unavailable" && outcome.reason === "notice_period")) {
      return noticePeriodResponse();
    }
    let body: ParkStayHotelResponse;
    if (outcome.kind === "unavailable") {
      body = { status: "unavailable", reason: outcome.reason };
    } else {
      body = {
        status: "ok",
        hotel: outcome.hotel,
        leading: outcome.leading,
        rooms: outcome.rooms,
        search: {
          night: w.night,
          departureDate: w.departureDate,
          arrivalTime: w.arrivalTime,
          returnDate: w.returnDate,
          returnTime: w.returnTime,
          adults,
        },
        sandbox: outcome.sandbox,
      };
    }
    return NextResponse.json(body, { headers: NO_STORE });
  } catch (error) {
    return supplierFailure(error, CALLER);
  }
}
