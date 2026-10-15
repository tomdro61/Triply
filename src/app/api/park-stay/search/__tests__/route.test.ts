import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { UnifiedLot } from "@/types/lot";

const searchParking = vi.fn();
const priceHotelsNear = vi.fn();
const captureAPIError = vi.fn();

vi.mock("@/lib/hotels/flags", () => ({ isParkStayEnabledFor: () => true }));
vi.mock("@/lib/attribution/limiter", () => ({ checkParkStaySearchRateLimit: () => true }));
vi.mock("@/lib/sentry", () => ({ captureAPIError: (...a: unknown[]) => captureAPIError(...a) }));
vi.mock("@/lib/reslab/search", () => ({
  searchParking: (...a: unknown[]) => searchParking(...a),
  isLocationBackoffError: () => false,
}));
vi.mock("@/lib/hotels/liteapi/rates", () => ({ priceHotelsNear: (...a: unknown[]) => priceHotelsNear(...a) }));

import { GET, __resetParkStaySearchCacheForTests } from "@/app/api/park-stay/search/route";
import { LiteApiBudgetError } from "@/lib/hotels/liteapi/budget";
import { airportsByCode } from "@/config/airports";

const JFK = airportsByCode.JFK;

function isoInDays(days: number): string {
  const d = new Date(Date.now() + days * 86_400_000);
  return d.toISOString().slice(0, 10);
}

function request(): NextRequest {
  const q = new URLSearchParams({
    airport: "JFK",
    checkin: isoInDays(10),
    checkout: isoInDays(13),
    checkinTime: "8:00 AM",
    checkoutTime: "6:00 PM",
    adults: "2",
    night: "after",
  });
  return new NextRequest(`http://localhost/api/park-stay/search?${q}`);
}

function jfkLot(overrides: Partial<UnifiedLot> = {}): UnifiedLot {
  return {
    id: "reslab-1",
    source: "reslab",
    sourceId: "1",
    reslabLocationId: 1,
    name: "JFK Lot",
    slug: "jfk-lot",
    address: "1 Test Rd",
    city: "Jamaica",
    state: "NY",
    latitude: JFK.latitude + 0.005,
    longitude: JFK.longitude + 0.005,
    amenities: [],
    photos: [],
    pricing: { minPrice: 10, currency: "$", parkingTypes: [], grandTotal: 60, subtotal: 55 },
    availability: "available",
    cancellationPolicies: [{ numberOfDays: 1, percentage: 100 }],
    ...overrides,
  };
}

const directLot = jfkLot({ id: "direct-1", source: "direct", sourceId: "1", reslabLocationId: undefined });

beforeEach(() => {
  __resetParkStaySearchCacheForTests();
  searchParking.mockReset();
  priceHotelsNear.mockReset();
  captureAPIError.mockReset();
});

describe("GET /api/park-stay/search — failure answers", () => {
  it("answers 503 no-store, not no_parking, when ResLab was down and only a direct lot came back", async () => {
    searchParking.mockResolvedValue({ results: [directLot], degraded: true, reslabUnavailable: true });
    const res = await GET(request());
    expect(res.status).toBe(503);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(priceHotelsNear).not.toHaveBeenCalled();
  });

  it("answers 503 when own lots failed to price behind the radius fallback", async () => {
    const lgaLot = jfkLot({ latitude: airportsByCode.LGA.latitude, longitude: airportsByCode.LGA.longitude });
    searchParking.mockResolvedValue({ results: [lgaLot], degraded: true, ownAirportFallback: true });
    const res = await GET(request());
    expect(res.status).toBe(503);
  });

  it("keeps the honest no_parking 200 when the result was complete", async () => {
    searchParking.mockResolvedValue({ results: [jfkLot({ dueAtLocation: true })] });
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect((await res.json()).status).toBe("no_parking");
  });

  it("answers a refused LiteAPI budget with 503 no-store and no second Sentry report", async () => {
    searchParking.mockResolvedValue({ results: [jfkLot()] });
    priceHotelsNear.mockRejectedValue(new LiteApiBudgetError("exhausted", "spent"));
    const res = await GET(request());
    expect(res.status).toBe(503);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(captureAPIError).not.toHaveBeenCalled();
  });
});
