import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const searchMock = vi.hoisted(() => ({ searchParking: vi.fn() }));
vi.mock("@/lib/reslab/search", async () => {
  const actual = await vi.importActual<typeof import("@/lib/reslab/search")>(
    "@/lib/reslab/search",
  );
  return { ...actual, ...searchMock };
});

const captureMock = vi.hoisted(() => ({ captureAPIError: vi.fn() }));
vi.mock("@/lib/sentry", async () => {
  const actual = await vi.importActual<typeof import("@/lib/sentry")>(
    "@/lib/sentry",
  );
  return { ...actual, ...captureMock };
});

import type { Airport } from "@/config/airports";
import type { UnifiedLot } from "@/types/lot";
import { fetchAirportPageData } from "../data";

const AIRPORT = {
  code: "JFK",
  name: "John F. Kennedy International",
  city: "New York",
  state: "NY",
  slug: "new-york-jfk",
  latitude: 40.64,
  longitude: -73.78,
} as unknown as Airport;

function lot(id: number): UnifiedLot {
  return {
    id: `reslab-${id}`,
    source: "reslab",
    sourceId: String(id),
    name: `Lot ${id}`,
    slug: `lot-${id}`,
    address: "1 Test Way",
    city: "New York",
    state: "NY",
    latitude: 40.6,
    longitude: -73.7,
    photos: [],
    amenities: [],
    distanceFromAirport: 2,
    availability: "available",
    pricing: {
      minPrice: 10,
      currency: "$",
      currencyCode: "USD",
      parkingTypes: [],
      grandTotal: 70,
    },
  } as unknown as UnifiedLot;
}

function result(over: Record<string, unknown>) {
  return {
    airport: AIRPORT,
    checkin: "2026-08-20",
    checkout: "2026-08-27",
    checkinTime: "10:00 AM",
    checkoutTime: "2:00 PM",
    results: [],
    total: 0,
    ...over,
  };
}

beforeEach(() => {
  searchMock.searchParking.mockReset();
  captureMock.captureAPIError.mockReset();
  delete process.env.NEXT_PHASE;
});

afterEach(() => {
  delete process.env.NEXT_PHASE;
});

describe("airport page — degraded results must not be baked into ISR", () => {
  it("during `next build`, a thin list is KEPT rather than rendered empty", async () => {
    // The regression this pins: the guard throws, and the catch deliberately
    // swallows during the build phase. If the throw runs BEFORE the lots are
    // assigned, `lots` stays [] and we ship ~85 empty, indexable airport pages
    // — strictly worse than the thin page we actually have, and the exact
    // outcome the build-phase bypass spends ResLab calls to avoid.
    process.env.NEXT_PHASE = "phase-production-build";
    searchMock.searchParking.mockResolvedValue(
      result({ results: [lot(1), lot(2)], total: 2, listIncomplete: true, degraded: true }),
    );

    const data = await fetchAirportPageData(AIRPORT);

    expect(data.totalLots).toBe(2); // NOT 0
    expect(data.lots).toHaveLength(2);
  });

  it("at runtime, a thin list throws so ISR keeps the last-good page", async () => {
    searchMock.searchParking.mockResolvedValue(
      result({ results: [lot(1)], total: 1, listIncomplete: true, degraded: true }),
    );

    await expect(fetchAirportPageData(AIRPORT)).rejects.toThrow(/thin/i);
  });

  it("a pricing-only degradation is NOT treated as thin", async () => {
    // `degraded` is also set when a single min-price call fails. Refusing a
    // whole page for that would bake empty pages on otherwise healthy deploys,
    // given ResLab's documented "pricing unavailable" degradation.
    searchMock.searchParking.mockResolvedValue(
      result({
        results: [lot(1), lot(2), lot(3)],
        total: 3,
        degraded: true,
        listIncomplete: false,
      }),
    );

    const data = await fetchAirportPageData(AIRPORT);

    expect(data.totalLots).toBe(3);
  });

  it("a clean result renders normally", async () => {
    searchMock.searchParking.mockResolvedValue(
      result({ results: [lot(1), lot(2)], total: 2 }),
    );

    const data = await fetchAirportPageData(AIRPORT);

    expect(data.totalLots).toBe(2);
    expect(captureMock.captureAPIError).not.toHaveBeenCalled();
  });
});
