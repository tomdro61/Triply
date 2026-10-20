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
const fingerprint = vi.fn(() => "f5d7c11622bdb289");
const warmToken = vi.fn(async () => {});
const viewerAllowed = vi.fn(async (_caller: string) => true);

vi.mock("@/lib/hotels/flags", () => ({
  parkStayFlags: () => flags,
  isParkStayEnabledFor: (code: string) => flags.enabled && flags.airports.has(code.toUpperCase()),
}));
vi.mock("@/lib/hotels/admin-preview", () => ({ parkStayViewerAllowed: (caller: string) => viewerAllowed(caller) }));
vi.mock("@/lib/attribution/limiter", () => ({ checkParkStaySearchRateLimit: () => rateLimitOk() }));
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
  return { ...actual, warmReslabToken: () => warmToken(), reslab: { ...actual.reslab, getLocation: (...a: unknown[]) => getLocation(...a), getMinPrice: (...a: unknown[]) => getMinPrice(...a) } };
});
vi.mock("@/lib/reslab/search", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/reslab/search")>();
  return { ...actual, getChannelLocationsNoSweep: () => getChannelLocationsNoSweep() };
});
vi.mock("@/lib/reslab/location-snapshot", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/reslab/location-snapshot")>();
  return { ...actual, keyFingerprint: () => fingerprint() };
});

import { GET, __resetParkStaySearchCacheForTests } from "@/app/api/park-stay/search/route";
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
  const base: Record<string, string> = { airport: "JFK", night, arrivalTime: "7:00 PM", returnDate: shiftIsoDate(night, 4), returnTime: "6:00 PM", adults: "2" };
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...base, ...over })) if (v !== null) q.set(k, v);
  return new NextRequest(`http://localhost/api/park-stay/search?${q}`);
}

let liteStatus = 200;

beforeEach(async () => {
  flags.enabled = true;
  viewerAllowed.mockReset();
  viewerAllowed.mockResolvedValue(true);
  warmToken.mockResolvedValue(undefined);
  __resetParkStaySearchCacheForTests();
  __resetHotelLotResolveForTests();
  for (const m of [warmToken, takeLiteApiCall, getLocation, getMinPrice, getChannelLocationsNoSweep, captureAPIError, fetchMock]) m.mockReset();
  rateLimitOk.mockReturnValue(true);
  fingerprint.mockReturnValue("f5d7c11622bdb289");
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

const supplierCalls = () => warmToken.mock.calls.length + getLocation.mock.calls.length + getMinPrice.mock.calls.length + getChannelLocationsNoSweep.mock.calls.length + fetchMock.mock.calls.length;

describe("GET /api/park-stay/search — gate order (§4.1)", () => {
  it("flag off → 404 for ANY query, checked before validation", async () => {
    flags.enabled = false;
    for (const req of [request(), request({ night: "garbage", adults: null })]) {
      const res = await GET(req);
      expect(res.status).toBe(404);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
    }
    expect(takeLiteApiCall).not.toHaveBeenCalled();
    expect(supplierCalls()).toBe(0);
  });

  it("not a signed-in admin → the same 404 for ANY query, before validation and with no supplier call (§20)", async () => {
    viewerAllowed.mockResolvedValue(false);
    for (const req of [request(), request({ night: "garbage", adults: null })]) {
      const res = await GET(req);
      expect(res.status).toBe(404);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      expect(await res.json()).toEqual({ error: "Not found" });
    }
    expect(viewerAllowed).toHaveBeenCalledWith("/api/park-stay/search");
    expect(takeLiteApiCall).not.toHaveBeenCalled();
    expect(supplierCalls()).toBe(0);
  });

  it("a cached result is never served to a non-admin (§20)", async () => {
    const first = await GET(request());
    expect(first.status).toBe(200);
    viewerAllowed.mockResolvedValue(false);
    expect((await GET(request())).status).toBe(404);
  });

  it("a missing input is a 400 naming the field — never defaulted", async () => {
    for (const [field, over] of [
      ["arrivalTime", { arrivalTime: null }],
      ["returnTime", { returnTime: null }],
      ["adults", { adults: null }],
      ["adults", { adults: "5" }],
      ["night", { night: null }],
    ] as const) {
      const res = await GET(request(over));
      expect(res.status, field).toBe(400);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      expect(Object.keys((await res.json()).fields)).toContain(field);
    }
    expect(takeLiteApiCall).not.toHaveBeenCalled();
  });

  it("a malformed time (13:99 PM) is refused before ResLab could see 25:99:00", async () => {
    const res = await GET(request({ arrivalTime: "13:99 PM" }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("arrival_invalid");
  });

  it("an airport that is not open for Park & Stay → 404", async () => {
    expect((await GET(request({ airport: "BOS" }))).status).toBe(404);
    flags.airports = new Set(["JFK"]);
    expect((await GET(request({ airport: "LGA" }))).status).toBe(404);
    flags.airports = new Set(["JFK", "LGA", "EWR"]);
  });

  it("rate-limited → 429, no ticket taken", async () => {
    rateLimitOk.mockReturnValue(false);
    expect((await GET(request())).status).toBe(429);
    expect(takeLiteApiCall).not.toHaveBeenCalled();
  });
});

describe("GET /api/park-stay/search — budget ticket (§7.2)", () => {
  it("takes exactly one ticket per uncached request, and the rates call spends it (no self-meter)", async () => {
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect(takeLiteApiCall).toHaveBeenCalledTimes(1);
    expect(takeLiteApiCall.mock.calls[0].slice(0, 2)).toEqual(["sandbox", "/hotels/rates"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.offers.map((o: { hotelKey: string }) => o.hotelKey)).toEqual(["hampton-inn-jfk", "doubletree-jfk"]);
  });

  it("a refused ticket → 503 no-store and ZERO ResLab or LiteAPI calls", async () => {
    takeLiteApiCall.mockRejectedValue(new LiteApiBudgetError("exhausted", "spent"));
    const res = await GET(request());
    expect(res.status).toBe(503);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(supplierCalls()).toBe(0);
    expect(captureAPIError).not.toHaveBeenCalled();
  });
});

describe("GET /api/park-stay/search — answers and the micro-cache (§6 step 9)", () => {
  it("a complete, non-empty answer is reused for 60 s without a second ticket", async () => {
    expect((await GET(request())).status).toBe(200);
    const again = await GET(request());
    expect((await again.json()).diagnostics.cached).toBe(true);
    expect(again.headers.get("Cache-Control")).toBe("no-store");
    expect(takeLiteApiCall).toHaveBeenCalledTimes(1);
    // a different input is a different key
    await GET(request({ adults: "3" }));
    expect(takeLiteApiCall).toHaveBeenCalledTimes(2);
  });

  it("a partial answer is 200 partial:true and NOT cached", async () => {
    getMinPrice.mockImplementation(async (id: number) => {
      if (id === 304) throw new ReslabError(502, "bad gateway");
      return minPrice({ grand: 120, sub: 110, tax: 10, lc: 93.5 });
    });
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect((await res.json()).partial).toBe(true);
    await GET(request());
    expect(takeLiteApiCall).toHaveBeenCalledTimes(2);
  });

  it("an honest empty is 200 and NOT cached", async () => {
    getMinPrice.mockResolvedValue(minPrice({ grand: 100, sub: 100, soldOut: true }));
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "empty", offers: [], emptyReason: "sold_out" });
    await GET(request());
    expect(takeLiteApiCall).toHaveBeenCalledTimes(2);
  });

  it("LiteAPI down → 503 with a Sentry stage", async () => {
    liteStatus = 500;
    const res = await GET(request());
    expect(res.status).toBe(503);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(captureAPIError.mock.calls.some((c) => (c[1] as { stage: string }).stage === "liteapi")).toBe(true);
  });

  it("every lot failing transiently → 503", async () => {
    getMinPrice.mockRejectedValue(new ReslabError(503, "down"));
    expect((await GET(request())).status).toBe(503);
  });

  it("a late same-night search that clears no lot's notice period → 400 'Choose a later arrival time'", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-20T22:10:00Z")); // 6:10 PM in New York
    try {
      const res = await GET(request({ night: "2026-10-20", arrivalTime: "6:30 PM", returnDate: "2026-10-23" }));
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: "notice_period", error: "Choose a later arrival time" });
      expect(getMinPrice).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      // never a start time in the past: 6:00 PM is refused by the same rule
      expect((await GET(request({ night: "2026-10-20", arrivalTime: "6:00 PM", returnDate: "2026-10-23" }))).status).toBe(400);
      // 7:00 PM clears the 30-minute lead and prices
      expect((await GET(request({ night: "2026-10-20", arrivalTime: "7:00 PM", returnDate: "2026-10-23" }))).status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("GET /api/park-stay/search — review pass 1", () => {
  it("H6: an unknown ResLab account answers 503 WITHOUT taking a budget ticket", async () => {
    fingerprint.mockReturnValue("ffffffffffffffff");
    const res = await GET(request());
    expect(res.status).toBe(503);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(takeLiteApiCall).not.toHaveBeenCalled();
    expect(supplierCalls()).toBe(0);
  });

  it("T4b: one lot transient + one hidden for min stay → 200 empty, partial, no reason, NOT cached", async () => {
    getLocation.mockImplementation(async (id: number) => (id === 132 ? locationFor(doubletree) : locationFor(hampton, { parking_commission: 80, minimum_booking_days: 2 })));
    getMinPrice.mockRejectedValue(new ReslabError(503, "down"));
    const oneDay = { returnDate: shiftIsoDate(night, 1), returnTime: "6:00 PM" };
    const res = await GET(request(oneDay));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "empty", offers: [], partial: true, emptyReason: null });
    await GET(request(oneDay));
    expect(takeLiteApiCall).toHaveBeenCalledTimes(2);
  });

  it("a 200 LiteAPI body without data[] is a 503, not an empty 'sold out' (H1)", async () => {
    fetchMock.mockImplementation(async () => new Response("{}", { status: 200 }));
    const res = await GET(request());
    expect(res.status).toBe(503);
  });
});

describe("GET /api/park-stay/search — review pass 3", () => {
  it("an answer where LiteAPI left out a requested hotel is shown but NOT micro-cached", async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify({ sandbox: true, data: [hotelRates("lp3034d", [rate({ rateId: "b", net: 150, ssp: 170 })])], hotels: [content(hampton)] }), { status: 200 })
    );
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect((await res.json()).offers.map((o: { hotelKey: string }) => o.hotelKey)).toEqual(["hampton-inn-jfk"]);
    await GET(request());
    expect(takeLiteApiCall).toHaveBeenCalledTimes(2);
  });
});
