import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * The airport page is ISR-cached for an hour, so it carries a lot's verified
 * rating + count but NEVER review text (a withdrawn consent must not stay
 * public for an hour; src/lib/reviews/summary.ts header). This pins the
 * literal `0` passed to withReviews in src/lib/airport-page/data.ts, and that
 * the read happens only on renders that will be served (after the ISR guards).
 */
const searchMock = vi.hoisted(() => ({ searchParking: vi.fn() }));
vi.mock("@/lib/reslab/search", async () => {
  const actual = await vi.importActual<typeof import("@/lib/reslab/search")>("@/lib/reslab/search");
  return { ...actual, ...searchMock };
});
const reviewsMock = vi.hoisted(() => ({ fetchLotReviewSummaries: vi.fn() }));
vi.mock("@/lib/reviews/summary", async () => {
  const actual = await vi.importActual<typeof import("@/lib/reviews/summary")>("@/lib/reviews/summary");
  return { ...actual, ...reviewsMock };
});
vi.mock("@/lib/sentry", async () => {
  const actual = await vi.importActual<typeof import("@/lib/sentry")>("@/lib/sentry");
  return { ...actual, captureAPIError: vi.fn() };
});

import type { Airport } from "@/config/airports";
import type { UnifiedLot } from "@/types/lot";
import type { LotReviewSummary } from "@/lib/reviews/summary";
import { fetchAirportPageData, __resetAirportPageFailureMemoForTests } from "../data";

const AIRPORT = { code: "JFK", name: "John F. Kennedy International", city: "New York", state: "NY", slug: "new-york-jfk", latitude: 40.64, longitude: -73.78 } as unknown as Airport;

function lot(id: number): UnifiedLot {
  return {
    id: `reslab-${id}`,
    source: "reslab",
    sourceId: String(id),
    reslabLocationId: id,
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
    pricing: { minPrice: 10, currency: "$", currencyCode: "USD", parkingTypes: [], grandTotal: 70 },
  } as unknown as UnifiedLot;
}
const base = { airport: AIRPORT, checkin: "2026-08-20", checkout: "2026-08-27", checkinTime: "10:00 AM", checkoutTime: "2:00 PM", total: 0, locationsConsidered: 0 };
const summary: LotReviewSummary = {
  average: 4.7,
  count: 3,
  published: [{ rating: 5, comment: "Great shuttle", name: "Ana", shuttleWait: "under_5", extraCharges: false, createdAt: "2026-10-20T00:00:00+00:00" }],
};

beforeEach(() => {
  searchMock.searchParking.mockReset();
  reviewsMock.fetchLotReviewSummaries.mockReset();
  __resetAirportPageFailureMemoForTests();
  delete process.env.NEXT_PHASE;
});

describe("airport page — verified ratings on the cards, never review text", () => {
  it("carries the rating and count but strips every published review", async () => {
    searchMock.searchParking.mockResolvedValue({ ...base, results: [lot(1), lot(2)], total: 2, locationsConsidered: 2 });
    reviewsMock.fetchLotReviewSummaries.mockResolvedValue(new Map([["r:1", summary]]));

    const data = await fetchAirportPageData(AIRPORT);

    expect(reviewsMock.fetchLotReviewSummaries).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ reslabLocationId: 1 })]), "airport-page");
    expect(data.lots[0].rating).toBe(4.7);
    expect(data.lots[0].reviewCount).toBe(3);
    expect(data.lots[0].reviews?.published).toEqual([]);
    expect(JSON.stringify(data.lots)).not.toContain("Great shuttle");
    expect(JSON.stringify(data.lots)).not.toContain("Ana");
    expect(data.lots[1].rating).toBeUndefined();
  });

  it("makes no review read on a render the ISR guards refuse", async () => {
    searchMock.searchParking.mockResolvedValue({ ...base, results: [lot(1)], total: 1, locationsConsidered: 1, listIncomplete: true, degraded: true });

    await expect(fetchAirportPageData(AIRPORT)).rejects.toThrow(/thin/i);
    expect(reviewsMock.fetchLotReviewSummaries).not.toHaveBeenCalled();
  });
});
