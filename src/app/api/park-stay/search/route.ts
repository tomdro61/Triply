/**
 * GET /api/park-stay/search?airport&night&arrivalTime&returnDate&returnTime&adults
 *
 * Park & Stay results (Phase A: read-only, behind ENABLE_PARK_STAY — 404 when
 * off). Plan: notes/2026-10-19-park-stay-search-plan.md (v3) §4, §6, §7.
 *
 * Every input is required and validated with NO fallbacks (§4.1). Each
 * enabled hotel in the map shows with ITS OWN ResLab lot, priced together
 * with its room; a hotel shows only when both are available (M3).
 *
 * Supplier calls per uncached request: 1 LiteAPI (one budget ticket, taken
 * before anything else is sent), 0 `/locations?page=N`, one bounded
 * min-price per eligible lot (5-minute cache), `/locations/{id}` only where
 * the no-sweep list is unavailable (Preview), cached 4 h.
 *
 * Failure posture: `no-store` on EVERY response; a supplier failure is a 503,
 * never an empty 200 a CDN could cache (the 2026-06-29 incident).
 */

import { NextRequest, NextResponse } from "next/server";
import { checkParkStaySearchRateLimit } from "@/lib/attribution/limiter";
import { enabledHotelLotsFor } from "@/lib/hotels/hotel-lots";
import { PARK_STAY_REQUEST_BUDGET_MS, PARK_STAY_SEARCH_CACHE_TTL_MS } from "@/lib/hotels/plans";
import { prepareParkStay, searchParkStay, type EmptyReason, type HiddenCounts, type ParkStayCard } from "@/lib/hotels/search";
import {
  NO_STORE,
  clientKey,
  gateParkStayRequest,
  noticePeriodResponse,
  reportAnomaliesOnce,
  supplierFailure,
  takeParkStayTicket,
} from "../_lib/request";

// Time budget: one request-wide deadline of start + 28 s (PARK_STAY_REQUEST_BUDGET_MS),
// ~2 s under maxDuration. Legs, each also capped by what is left: budget RPC 2 s,
// snapshot read 5 s (a timeout = no list → the getLocation path), ONE token
// warm-up 3 s, getLocation 4 s, then LiteAPI 15 s ∥ min-price 8 s. With < 3 s
// left, LiteAPI isn't called and the answer is 503. No sweep can run from here.
export const maxDuration = 30;
export const dynamic = "force-dynamic";

const CALLER = "/api/park-stay/search";

export interface ParkStaySearchResponse {
  status: "ok" | "empty";
  airport: { code: string; name: string; timezone: string };
  search: {
    night: string;
    /** Hotel check-out = departure day (shown, not asked). */
    departureDate: string;
    arrivalTime: string;
    returnDate: string;
    returnTime: string;
    adults: number;
  };
  offers: ParkStayCard[];
  /** Some hotels could not be checked reliably right now; never cached. */
  partial: boolean;
  /** Null when there are offers, or when an empty answer is only partial ("we couldn't check"). */
  emptyReason: EmptyReason | null;
  sandbox: boolean | null;
  diagnostics: { hidden: HiddenCounts; cached: boolean };
}

// ── 60 s per-lambda micro-cache: complete, non-empty answers only, keyed on every input ──
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
  if (PARK_STAY_SEARCH_CACHE_TTL_MS <= 0) return;
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

export async function GET(request: NextRequest) {
  const nowDate = new Date();
  // The request-wide deadline (review pass 2, H1): every leg after this is
  // bounded by what is left of it.
  const deadlineMs = nowDate.getTime() + PARK_STAY_REQUEST_BUDGET_MS;
  const gate = await gateParkStayRequest(request, nowDate, CALLER);
  if (!gate.ok) return gate.response;
  const { airport, window: w, adults } = gate.request;

  if (!checkParkStaySearchRateLimit(clientKey(request))) {
    return NextResponse.json({ error: "Too many searches, please slow down" }, { status: 429, headers: NO_STORE });
  }

  const now = nowDate.getTime();
  const cacheKey = [airport.code, w.night, w.arrivalTime, w.returnDate, w.returnTime, adults].join("|");
  const cached = cacheGet(cacheKey, now);
  if (cached) {
    return NextResponse.json({ ...cached, diagnostics: { ...cached.diagnostics, cached: true } }, { headers: NO_STORE });
  }

  try {
    // The ResLab account and ids first (pure): an unknown account / no ids
    // fails closed here WITHOUT spending a LiteAPI budget call (H6).
    const prepared = prepareParkStay(enabledHotelLotsFor(airport.code), airport.code, CALLER);
    // Nothing has been sent to LiteAPI or ResLab before this line.
    const ticket = await takeParkStayTicket(CALLER);
    const outcome = await searchParkStay(
      prepared,
      { deadlineMs, airport: { code: airport.code, timezone: airport.timezone }, window: w, adults, ticket, now: nowDate, caller: CALLER },
      (a) => reportAnomaliesOnce(CALLER, a)
    );
    if (outcome.kind === "notice_period") return noticePeriodResponse();

    const body: ParkStaySearchResponse = {
      status: outcome.cards.length > 0 ? "ok" : "empty",
      airport: { code: airport.code, name: airport.name, timezone: airport.timezone },
      search: {
        night: w.night,
        departureDate: w.departureDate,
        arrivalTime: w.arrivalTime,
        returnDate: w.returnDate,
        returnTime: w.returnTime,
        adults,
      },
      offers: outcome.cards,
      partial: outcome.partial,
      emptyReason: outcome.emptyReason,
      sandbox: outcome.sandbox,
      diagnostics: { hidden: outcome.hidden, cached: false },
    };
    // Only a complete, non-empty answer is worth reusing (an empty or partial
    // one may be a blip).
    // ...and one where LiteAPI left out a requested hotel is not reused either.
    if (body.status === "ok" && !body.partial && outcome.cacheable) cacheSet(cacheKey, body, now);
    return NextResponse.json(body, { headers: NO_STORE });
  } catch (error) {
    return supplierFailure(error, CALLER);
  }
}
