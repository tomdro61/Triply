/**
 * Shared request handling for the Park & Stay API routes (plan v3 §4.1, §6):
 * the flag gate, input validation, the budget ticket and the failure answers.
 *
 * Order of checks, identical on both routes:
 *   1. flag (404 when off — Production answers 404 to ANY query, the
 *      post-deploy negative control), 1b. admin viewer (404 for anyone else —
 *      plan §20, the private preview runs in production), 2. input shape (400,
 *      naming the field), 3. airport open for Park & Stay (404), 4. window
 *      rules (400), then the route's per-IP limit (429), and only then a
 *      budget ticket.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { Airport } from "@/config/airports";
import { captureAPIError } from "@/lib/sentry";
import { parkStayFlags } from "@/lib/hotels/flags";
import { parkStayViewerAllowed } from "@/lib/hotels/admin-preview";
import { parkStayAirport } from "@/lib/hotels/park-stay-airports";
import { validateParkStayWindow, type ParkStayWindow } from "@/lib/hotels/parking-window";
import { PARK_STAY_MAX_ADULTS, PARK_STAY_MIN_ADULTS } from "@/lib/hotels/plans";
import { resolveHotelEnv, LiteApiConfigError } from "@/lib/hotels/liteapi/env";
import { takeLiteApiCall, LiteApiBudgetError, type BudgetTicket } from "@/lib/hotels/liteapi/budget";
import { LiteApiError } from "@/lib/hotels/liteapi/client";
import { ParkStayUnavailableError } from "@/lib/hotels/search";

export const NO_STORE = { "Cache-Control": "no-store" } as const;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const searchQuerySchema = z.object({
  airport: z
    .string()
    .regex(/^[A-Za-z]{3}$/, "airport must be a 3-letter IATA code")
    .transform((s) => s.toUpperCase()),
  night: z.string().regex(ISO_DATE, "night is required (YYYY-MM-DD)"),
  arrivalTime: z.string().min(1, "arrivalTime is required (h:mm AM/PM)"),
  returnDate: z.string().regex(ISO_DATE, "returnDate is required (YYYY-MM-DD)"),
  returnTime: z.string().min(1, "returnTime is required (h:mm AM/PM)"),
  adults: z
    .string()
    .regex(/^\d+$/, "adults is required (a whole number)")
    .transform(Number)
    .pipe(z.number().int().min(PARK_STAY_MIN_ADULTS, `adults must be ${PARK_STAY_MIN_ADULTS}–${PARK_STAY_MAX_ADULTS}`).max(PARK_STAY_MAX_ADULTS, `adults must be ${PARK_STAY_MIN_ADULTS}–${PARK_STAY_MAX_ADULTS}`)),
});

export interface ParkStayRequest {
  airport: Airport;
  window: ParkStayWindow;
  adults: number;
}

export type ParkStayGate =
  | { ok: true; request: ParkStayRequest; params: URLSearchParams }
  | { ok: false; response: NextResponse };

function notFound(): NextResponse {
  return NextResponse.json({ error: "Not found" }, { status: 404, headers: NO_STORE });
}

/** Steps 1–4. `now` is injectable for tests. */
export async function gateParkStayRequest(request: NextRequest, now: Date, caller: string): Promise<ParkStayGate> {
  if (!parkStayFlags().enabled) return { ok: false, response: notFound() };
  if (!(await parkStayViewerAllowed(caller))) return { ok: false, response: notFound() };
  const sp = request.nextUrl.searchParams;
  const parsed = searchQuerySchema.safeParse({
    airport: sp.get("airport") ?? "",
    night: sp.get("night") ?? "",
    arrivalTime: sp.get("arrivalTime") ?? "",
    returnDate: sp.get("returnDate") ?? "",
    returnTime: sp.get("returnTime") ?? "",
    adults: sp.get("adults") ?? "",
  });
  if (!parsed.success) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Invalid search parameters", fields: z.flattenError(parsed.error).fieldErrors },
        { status: 400, headers: NO_STORE }
      ),
    };
  }
  const q = parsed.data;
  const airport = parkStayAirport(q.airport);
  if (!airport) return { ok: false, response: notFound() };
  const w = validateParkStayWindow({
    night: q.night,
    arrivalTime: q.arrivalTime,
    returnDate: q.returnDate,
    returnTime: q.returnTime,
    airportTimeZone: airport.timezone,
    now,
  });
  if (!w.ok) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: w.error.message, code: w.error.code, fields: { [w.error.field]: [w.error.message] } },
        { status: 400, headers: NO_STORE }
      ),
    };
  }
  return { ok: true, request: { airport, window: w.window, adults: q.adults }, params: sp };
}

export function clientKey(request: NextRequest): string {
  const fwd = request.headers.get("x-forwarded-for");
  return (fwd ? fwd.split(",")[0].trim() : request.headers.get("x-real-ip")) ?? "unknown";
}

/**
 * Step 3 of §6: one budget ticket per request, taken BEFORE any ResLab or
 * LiteAPI call. Throws LiteApiConfigError (no key) or LiteApiBudgetError
 * (refused) — both answered by `supplierFailure`.
 */
export async function takeParkStayTicket(caller: string): Promise<BudgetTicket> {
  const env = resolveHotelEnv();
  return takeLiteApiCall(env.mode, "/hotels/rates", undefined, undefined, caller);
}

const reportedAnomalies = new Set<string>();

/** Supplier mapping anomalies, once per distinct string per process. */
export function reportAnomaliesOnce(caller: string, anomalies: readonly string[]): void {
  for (const a of anomalies) {
    if (reportedAnomalies.has(a)) continue;
    reportedAnomalies.add(a);
    captureAPIError(new Error(`LiteAPI mapping anomaly: ${a}`), { endpoint: caller, method: "GET", stage: "mapping" });
  }
}

/** Every failure is a 503 with no-store — never an empty body a CDN could cache. */
export function supplierFailure(error: unknown, caller: string): NextResponse {
  const body = { error: "Hotel search is temporarily unavailable", retry: true };
  if (error instanceof LiteApiBudgetError) {
    // budget.ts already reported it (on its refusal ladder for "exhausted").
    return NextResponse.json(body, { status: 503, headers: NO_STORE });
  }
  if (error instanceof ParkStayUnavailableError) {
    if (error.reason === "no_reliable_result" || error.reason === "deadline") {
      captureAPIError(error, { endpoint: caller, method: "GET", stage: error.reason, statusCode: 503 });
    }
    // unknown_reslab_account / no_ids_for_account / reslab_auth were reported at the source (throttled).
    return NextResponse.json(body, { status: 503, headers: NO_STORE });
  }
  const err = error instanceof Error ? error : new Error(String(error));
  captureAPIError(err, {
    endpoint: caller,
    method: "GET",
    stage: error instanceof LiteApiConfigError ? "config" : error instanceof LiteApiError ? "liteapi" : "unexpected",
    statusCode: error instanceof LiteApiError ? error.statusCode : undefined,
    code: error instanceof LiteApiError && error.code !== undefined ? String(error.code) : undefined,
  });
  return NextResponse.json(body, { status: 503, headers: NO_STORE });
}

export function noticePeriodResponse(): NextResponse {
  return NextResponse.json(
    { error: "Choose a later arrival time", code: "notice_period", fields: { arrivalTime: ["Choose a later arrival time"] } },
    { status: 400, headers: NO_STORE }
  );
}

export function __resetParkStayAnomaliesForTests(): void {
  reportedAnomalies.clear();
}
