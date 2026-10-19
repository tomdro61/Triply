import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Review T2(a): the REAL ResLab client and the REAL @/lib/reslab/search module
 * (only the snapshot read and the fingerprint are stubbed), with the network
 * stubbed at fetch. A Park & Stay search must write no parking telemetry and
 * make no location-list calls — and, cold, authenticate once (M1).
 */

const logAvailability = vi.fn();
const logSearchEvent = vi.fn();
const readSnapshot = vi.fn();

vi.mock("@/lib/sentry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sentry")>();
  return { ...actual, captureAPIError: vi.fn() };
});
vi.mock("@/lib/reslab/location-snapshot", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/reslab/location-snapshot")>();
  return { ...actual, keyFingerprint: () => "f5d7c11622bdb289", readSnapshot: (...a: unknown[]) => readSnapshot(...a) };
});
vi.mock("@/lib/availability/log", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/availability/log")>();
  return { ...actual, logAvailability: (...a: unknown[]) => logAvailability(...a) };
});
vi.mock("@/lib/search-events/log", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/search-events/log")>();
  return { ...actual, logSearchEvent: (...a: unknown[]) => logSearchEvent(...a) };
});
vi.mock("@/lib/hotels/liteapi/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/hotels/liteapi/env")>();
  return { ...actual, resolveHotelEnv: () => ({ mode: "sandbox", apiKey: "k", dataBaseUrl: "https://data.test", bookBaseUrl: "https://book.test" }) };
});

import { takeLiteApiCall } from "../liteapi/budget";
import { enabledHotelLotsFor, HOTEL_LOTS } from "../hotel-lots";
import { validateParkStayWindow } from "../parking-window";
import { prepareParkStay, searchParkStay } from "../search";
import { content, hotelRates, locationFor, minPrice, rate } from "./fixtures";

const doubletree = HOTEL_LOTS.find((e) => e.key === "doubletree-jfk")!;
const hampton = HOTEL_LOTS.find((e) => e.key === "hampton-inn-jfk")!;
const urls: string[] = [];

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  urls.length = 0;
  logAvailability.mockReset();
  logSearchEvent.mockReset();
  readSnapshot.mockReset();
  readSnapshot.mockResolvedValue({ kind: "miss", reason: "stub", reportable: false });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      urls.push(url);
      if (url.endsWith("/authenticate")) return json({ token: "t" });
      const m = /\/locations\/(\d+)(\/min-price)?$/.exec(url);
      if (m) {
        const id = Number(m[1]);
        if (m[2]) return json(id === 132 ? minPrice({ grand: 120, sub: 110, tax: 10, lc: 93.5 }) : minPrice({ grand: 90, sub: 80, tax: 10, lc: 64 }));
        return json(id === 132 ? locationFor(doubletree) : locationFor(hampton, { parking_commission: 80 }));
      }
      if (url === "https://data.test/hotels/rates") {
        return json({
          data: [hotelRates("lp27fe6", [rate({ rateId: "a", net: 200, ssp: 230 })]), hotelRates("lp3034d", [rate({ rateId: "b", net: 150, ssp: 170 })])],
          hotels: [content(doubletree), content(hampton)],
          sandbox: true,
        });
      }
      return new Response("unexpected", { status: 500 });
    })
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("Park & Stay search with the real ResLab modules", () => {
  it("prices both hotels, writes no telemetry, never pages /locations, and authenticates once", async () => {
    const w = validateParkStayWindow({ night: "2026-11-10", arrivalTime: "7:00 PM", returnDate: "2026-11-14", returnTime: "6:00 PM", airportTimeZone: "America/New_York", now: new Date("2026-10-20T16:00:00Z") });
    if (!w.ok) throw new Error(w.error.code);
    const ticket = await takeLiteApiCall("sandbox", "/hotels/rates", async () => ({ data: [{ allowed: true, calls: 1, denied: 0 }], error: null }));
    const out = await searchParkStay(
      prepareParkStay(enabledHotelLotsFor("JFK"), "JFK", "/api/park-stay/search"),
      { airport: { code: "JFK", timezone: "America/New_York" }, window: w.window, adults: 2, ticket, now: new Date("2026-10-20T16:00:00Z"), caller: "/api/park-stay/search" },
      () => {}
    );
    expect(out.kind === "results" && out.cards.map((c) => c.hotelKey)).toEqual(["hampton-inn-jfk", "doubletree-jfk"]);
    expect(logAvailability).toHaveBeenCalledTimes(0);
    expect(logSearchEvent).toHaveBeenCalledTimes(0);
    expect(urls.filter((u) => /\/locations\?page=|\/locations\/search/.test(u))).toEqual([]);
    expect(urls.filter((u) => u.endsWith("/authenticate"))).toHaveLength(1);
    expect(urls.filter((u) => /\/locations\/\d+$/.test(u)).sort()).toEqual(["https://reslab.invalid/v1/locations/132", "https://reslab.invalid/v1/locations/304"]);
  });
});
