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
import { PARK_STAY_HOTEL_PAGE_MAX_RATES } from "@/lib/hotels/plans";
import { quoteParkStayHotel, type HiddenReason, type ParkStayHotelSummary, type ParkStayRoomOffer } from "@/lib/hotels/search";
import {
  NO_STORE,
  clientKey,
  gateParkStayRequest,
  noticePeriodResponse,
  reportAnomaliesOnce,
  supplierFailure,
  takeParkStayTicket,
} from "../_lib/request";

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
  const gate = gateParkStayRequest(request, nowDate);
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
    const ticket = await takeParkStayTicket(CALLER);
    const outcome = await quoteParkStayHotel(
      entry,
      { airport: { code: airport.code, timezone: airport.timezone }, window: w, adults, ticket, now: nowDate, caller: CALLER },
      PARK_STAY_HOTEL_PAGE_MAX_RATES,
      (a) => reportAnomaliesOnce(CALLER, a)
    );
    if (outcome.kind === "notice_period") return noticePeriodResponse();
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
