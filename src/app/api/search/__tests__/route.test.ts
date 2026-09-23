/**
 * search_events (the per-search demand header row) is now written from
 * inside searchParking itself (see src/lib/reslab/__tests__/search-events.test.ts
 * for that contract, exercised against the real searchParking code path).
 * This route no longer inserts anything — it just has to pass the right
 * parameters through: whether dates were defaulted, the parsed attribution
 * (on the "search" surface, never "checkout"), and the featured-parking
 * surface override. Those params, plus the pre-existing Cache-Control
 * contract, are what this file tests; searchParking itself is mocked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import type { Attribution } from "@/lib/attribution/schema";

const searchParkingMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/reslab/search", () => ({
  searchParking: searchParkingMock,
  isLocationBackoffError: () => false,
}));

vi.mock("@/lib/sentry", () => ({ captureAPIError: vi.fn() }));

const readAttributionMock = vi.hoisted(() => vi.fn<() => Attribution | null>(() => null));
vi.mock("@/lib/attribution/read-request", () => ({
  readAttributionFromRequest: readAttributionMock,
}));

import { GET } from "../route";

const okResult = {
  airport: { code: "JFK" },
  checkin: "2026-10-10",
  checkout: "2026-10-14",
  checkinTime: "10:00 AM",
  checkoutTime: "2:00 PM",
  results: [],
  total: 2,
  degraded: false,
  stale: false,
};

function req(query: Record<string, string> = {}) {
  const params = new URLSearchParams({
    airport: "JFK",
    checkin: "2026-10-10",
    checkout: "2026-10-14",
    ...query,
  });
  return new NextRequest(`https://triplypro.com/api/search?${params.toString()}`);
}

beforeEach(() => {
  searchParkingMock.mockReset();
  searchParkingMock.mockResolvedValue(okResult);
  readAttributionMock.mockReset();
  readAttributionMock.mockReturnValue(null);
});

describe("GET /api/search", () => {
  it("parses attribution on the 'search' surface, never 'checkout'", async () => {
    await GET(req());

    expect(readAttributionMock).toHaveBeenCalledWith(expect.anything(), {}, "search");
  });

  it("passes datesDefaulted=false and the caller's dates through when both are supplied", async () => {
    await GET(req({ checkin: "2026-11-01", checkout: "2026-11-05" }));

    expect(searchParkingMock).toHaveBeenCalledWith(
      expect.objectContaining({
        checkin: "2026-11-01",
        checkout: "2026-11-05",
        datesDefaulted: false,
        searchEventSource: undefined,
      })
    );
  });

  it("marks datesDefaulted=true when checkin/checkout are omitted (the tomorrow/+7 pricing fallback)", async () => {
    const params = new URLSearchParams({ airport: "JFK" });
    await GET(new NextRequest(`https://triplypro.com/api/search?${params.toString()}`));

    expect(searchParkingMock).toHaveBeenCalledWith(
      expect.objectContaining({ datesDefaulted: true })
    );
  });

  it("marks datesDefaulted=true when only one of checkin/checkout is supplied", async () => {
    const params = new URLSearchParams({ airport: "JFK", checkin: "2026-11-01" });
    await GET(new NextRequest(`https://triplypro.com/api/search?${params.toString()}`));

    expect(searchParkingMock).toHaveBeenCalledWith(
      expect.objectContaining({ datesDefaulted: true })
    );
  });

  it("tags the featured-parking widget's requests searchEventSource='homepage-featured'", async () => {
    await GET(req({ surface: "featured" }));

    expect(searchParkingMock).toHaveBeenCalledWith(
      expect.objectContaining({ searchEventSource: "homepage-featured" })
    );
  });

  it("ignores an unknown ?surface value instead of 400ing the whole search", async () => {
    // A telemetry tag must never be able to fail a search. Before
    // `.catch(undefined)` this returned 400 "Invalid search parameters" and
    // the customer saw no parking at all for a stale or mistyped link.
    const res = await GET(req({ surface: "not-a-surface" }));

    expect(res.status).toBe(200);
    expect(searchParkingMock).toHaveBeenCalledWith(
      expect.objectContaining({ searchEventSource: undefined })
    );
  });

  it("still 400s on a genuinely malformed parameter — the relaxation is scoped to `surface`", async () => {
    const res = await GET(req({ checkin: "10/10/2026" }));

    expect(res.status).toBe(400);
    expect(searchParkingMock).not.toHaveBeenCalled();
  });

  it("passes the parsed attribution fields through to searchParking", async () => {
    readAttributionMock.mockReturnValue({
      v: 1,
      first: { src: "google", med: "cpc", cmp: "brand", at: 1700000000 },
      ga_client_id: "1234567890.1700000000",
    });

    await GET(req());

    expect(searchParkingMock).toHaveBeenCalledWith(
      expect.objectContaining({
        attribution: {
          utmSource: "google",
          utmMedium: "cpc",
          utmCampaign: "brand",
          gaClientId: "1234567890.1700000000",
        },
      })
    );
  });

  it("passes all-null attribution when the cookie is absent", async () => {
    readAttributionMock.mockReturnValue(null);

    await GET(req());

    expect(searchParkingMock).toHaveBeenCalledWith(
      expect.objectContaining({
        attribution: { utmSource: null, utmMedium: null, utmCampaign: null, gaClientId: null },
      })
    );
  });

  it("caches a clean non-degraded result", async () => {
    searchParkingMock.mockResolvedValue({ ...okResult, total: 2, degraded: false, stale: false });

    const res = await GET(req());

    expect(res.headers.get("Cache-Control")).toBe(
      "public, s-maxage=300, stale-while-revalidate=600"
    );
  });

  it("shortens the TTL for a stale (complete but past-TTL) result", async () => {
    searchParkingMock.mockResolvedValue({ ...okResult, total: 2, degraded: false, stale: true });

    const res = await GET(req());

    expect(res.headers.get("Cache-Control")).toBe(
      "public, s-maxage=60, stale-while-revalidate=300"
    );
  });

  it("never caches a degraded or empty result", async () => {
    searchParkingMock.mockResolvedValue({ ...okResult, total: 0, degraded: false, stale: false });
    let res = await GET(req());
    expect(res.headers.get("Cache-Control")).toBe("no-store");

    searchParkingMock.mockResolvedValue({ ...okResult, total: 2, degraded: true, stale: false });
    res = await GET(req());
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});
