import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const flags = { enabled: true, airports: new Set(["JFK", "LGA", "EWR"]) };
const rateLimitOk = vi.fn(() => true);
const takeLiteApiCall = vi.fn();
const getLocation = vi.fn();
const getMinPrice = vi.fn();
const getChannelLocationsNoSweep = vi.fn();
const captureAPIError = vi.fn();
const fetchMock = vi.fn();

vi.mock("@/lib/hotels/flags", () => ({
  parkStayFlags: () => flags,
  isParkStayEnabledFor: (code: string) => flags.enabled && flags.airports.has(code.toUpperCase()),
}));
vi.mock("@/lib/attribution/limiter", () => ({ checkParkStayHotelRateLimit: () => rateLimitOk() }));
vi.mock("@/lib/sentry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sentry")>();
  return { ...actual, captureAPIError: (...a: unknown[]) => captureAPIError(...a) };
});
vi.mock("@/lib/hotels/liteapi/budget", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/hotels/liteapi/budget")>();
  return { ...actual, takeLiteApiCall: (...a: Parameters<typeof actual.takeLiteApiCall>) => takeLiteApiCall(...a) };
});
vi.mock("@/lib/hotels/liteapi/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/hotels/liteapi/env")>();
  return { ...actual, resolveHotelEnv: () => ({ mode: "sandbox", apiKey: "k", dataBaseUrl: "https://data.test", bookBaseUrl: "https://book.test" }) };
});
vi.mock("@/lib/reslab/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/reslab/client")>();
  return { ...actual, reslab: { ...actual.reslab, getLocation: (...a: unknown[]) => getLocation(...a), getMinPrice: (...a: unknown[]) => getMinPrice(...a) } };
});
vi.mock("@/lib/reslab/search", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/reslab/search")>();
  return { ...actual, getChannelLocationsNoSweep: () => getChannelLocationsNoSweep() };
});
vi.mock("@/lib/reslab/location-snapshot", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/reslab/location-snapshot")>();
  return { ...actual, keyFingerprint: () => "f5d7c11622bdb289" };
});

import { GET } from "@/app/api/park-stay/hotel/route";
import { LiteApiBudgetError } from "@/lib/hotels/liteapi/budget";
import { ReslabError } from "@/lib/reslab/client";
import { __resetHotelLotResolveForTests } from "@/lib/hotels/hotel-lot-resolve";
import { shiftIsoDate, todayInZone } from "@/lib/hotels/dates";
import { HOTEL_LOTS } from "@/lib/hotels/hotel-lots";
import { content, hotelRates, locationFor, minPrice, rate } from "@/lib/hotels/__tests__/fixtures";

const doubletree = HOTEL_LOTS.find((e) => e.key === "doubletree-jfk")!;
const hampton = HOTEL_LOTS.find((e) => e.key === "hampton-inn-jfk")!;

// B9: dates built from the AIRPORT's calendar, never toISOString().
const night = shiftIsoDate(todayInZone("America/New_York"), 21);

function request(over: Record<string, string | null> = {}): NextRequest {
  const base: Record<string, string> = { hotelKey: "doubletree-jfk", airport: "JFK", night, arrivalTime: "7:00 PM", returnDate: shiftIsoDate(night, 4), returnTime: "6:00 PM", adults: "2" };
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...base, ...over })) if (v !== null) q.set(k, v);
  return new NextRequest(`http://localhost/api/park-stay/hotel?${q}`);
}

let liteStatus = 200;

beforeEach(async () => {
  flags.enabled = true;
  __resetHotelLotResolveForTests();
  for (const m of [takeLiteApiCall, getLocation, getMinPrice, getChannelLocationsNoSweep, captureAPIError, fetchMock]) m.mockReset();
  rateLimitOk.mockReturnValue(true);
  const actual = await vi.importActual<typeof import("@/lib/hotels/liteapi/budget")>("@/lib/hotels/liteapi/budget");
  takeLiteApiCall.mockImplementation((mode: "sandbox" | "live", path: string) =>
    actual.takeLiteApiCall(mode, path, async () => ({ data: [{ allowed: true, calls: 1, denied: 0 }], error: null }))
  );
  getChannelLocationsNoSweep.mockResolvedValue(null);
  getLocation.mockImplementation(async (id: number) => (id === 132 ? locationFor(doubletree) : locationFor(hampton, { parking_commission: 80 })));
  getMinPrice.mockImplementation(async (id: number) =>
    id === 132 ? minPrice({ grand: 120, sub: 110, tax: 10, lc: 93.5 }) : minPrice({ grand: 90, sub: 80, tax: 10, lc: 64 })
  );
  liteStatus = 200;
  fetchMock.mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          sandbox: true,
          data: [hotelRates("lp27fe6", [rate({ rateId: "a", net: 200, ssp: 230 })]), hotelRates("lp3034d", [rate({ rateId: "b", net: 150, ssp: 170 })])],
          hotels: [content(doubletree), content(hampton)],
        }),
        { status: liteStatus }
      )
  );
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const supplierCalls = () => getLocation.mock.calls.length + getMinPrice.mock.calls.length + getChannelLocationsNoSweep.mock.calls.length + fetchMock.mock.calls.length;

describe("GET /api/park-stay/hotel", () => {
  it("flag off → 404 before validation", async () => {
    flags.enabled = false;
    expect((await GET(request({ hotelKey: null, night: "x" }))).status).toBe(404);
    expect(supplierCalls()).toBe(0);
  });

  it("unknown, disabled (Red Carpet, D2) or other-airport keys → 404 with no ticket", async () => {
    expect((await GET(request({ hotelKey: "nope" }))).status).toBe(404);
    expect((await GET(request({ hotelKey: "red-carpet-inn-ewr", airport: "EWR" }))).status).toBe(404);
    expect((await GET(request({ hotelKey: "laguardia-marriott" }))).status).toBe(404);
    expect((await GET(request({ hotelKey: "Bad Key!" }))).status).toBe(400);
    expect(takeLiteApiCall).not.toHaveBeenCalled();
  });

  it("prices fresh with one ticket, only this hotel's lot, and lists its rooms", async () => {
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.hotel.hotelKey).toBe("doubletree-jfk");
    expect(body.rooms).toHaveLength(1);
    expect(getMinPrice.mock.calls.map((c) => c[0])).toEqual([132]);
    expect(takeLiteApiCall).toHaveBeenCalledTimes(1);
    // no micro-cache on the hotel page
    await GET(request());
    expect(takeLiteApiCall).toHaveBeenCalledTimes(2);
  });

  it("a refused ticket → 503 with zero supplier calls", async () => {
    takeLiteApiCall.mockRejectedValue(new LiteApiBudgetError("unavailable", "db down"));
    expect((await GET(request())).status).toBe(503);
    expect(supplierCalls()).toBe(0);
  });

  it("transient parking failure → 503", async () => {
    getMinPrice.mockRejectedValue(new ReslabError(504, "timeout"));
    expect((await GET(request())).status).toBe(503);
  });
});
