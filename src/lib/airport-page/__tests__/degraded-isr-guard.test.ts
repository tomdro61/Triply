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
import {
  fetchAirportPageData,
  AIRPORT_PAGE_FAILURE_MEMO_MS,
  __resetAirportPageFailureMemoForTests,
} from "../data";

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
    locationsConsidered: 0,
    ...over,
  };
}

beforeEach(() => {
  searchMock.searchParking.mockReset();
  captureMock.captureAPIError.mockReset();
  __resetAirportPageFailureMemoForTests();
  delete process.env.NEXT_PHASE;
});

afterEach(() => {
  delete process.env.NEXT_PHASE;
  vi.useRealTimers();
});

describe("airport page — degraded results must not be baked into ISR", () => {
  it("during `next build`, a thin list is KEPT rather than rendered empty", async () => {
    // The regression this pins: the guard throws, and the catch deliberately
    // swallows during the build phase. If the throw runs BEFORE the lots are
    // assigned, `lots` stays [] and — if these pages are ever prerendered again
    // (they aren't since 2026-10-07) — we'd ship empty, indexable airport pages,
    // strictly worse than the thin page we actually have.
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

  it("a ResLab outage answered with direct lots only (reslabUnavailable) throws at runtime, without a second root-less capture", async () => {
    // searchParking already captured the root ResLab error when it chose to
    // serve direct lots; baking a one-lot page for an hour is the thing to stop.
    searchMock.searchParking.mockResolvedValue(
      result({ results: [lot(1)], total: 1, degraded: true, listIncomplete: false, reslabUnavailable: true }),
    );

    await expect(fetchAirportPageData(AIRPORT)).rejects.toThrow(/ResLab unavailable/);
    await expect(fetchAirportPageData(AIRPORT)).rejects.toThrow(/ResLab unavailable/);
    // Throttled like the breaker error, and the second call is answered by the
    // failure memo: at most one capture, never one per call.
    expect(captureMock.captureAPIError.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it("during `next build`, a reslabUnavailable result keeps its direct lots rather than rendering empty", async () => {
    process.env.NEXT_PHASE = "phase-production-build";
    searchMock.searchParking.mockResolvedValue(
      result({ results: [lot(1)], total: 1, degraded: true, reslabUnavailable: true }),
    );

    const data = await fetchAirportPageData(AIRPORT);

    expect(data.totalLots).toBe(1);
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

describe("airport page — failure memo (pages render on first request)", () => {
  const LGA = { ...AIRPORT, code: "LGA", slug: "new-york-lga" } as unknown as Airport;

  it("after a runtime failure, the same airport rethrows for 5 minutes without calling ResLab", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-07T12:00:00Z"));
    searchMock.searchParking.mockRejectedValue(new Error("ResLab pricing unavailable for all 3 JFK location(s)"));

    await expect(fetchAirportPageData(AIRPORT)).rejects.toThrow(/pricing unavailable/);
    await expect(fetchAirportPageData(AIRPORT)).rejects.toThrow(/pricing unavailable/);
    expect(searchMock.searchParking).toHaveBeenCalledTimes(1);
    expect(captureMock.captureAPIError).toHaveBeenCalledTimes(1);

    // Window over: the next request asks ResLab again and can succeed.
    vi.setSystemTime(Date.now() + AIRPORT_PAGE_FAILURE_MEMO_MS);
    searchMock.searchParking.mockResolvedValue(result({ results: [lot(1)], total: 1, locationsConsidered: 1 }));
    const data = await fetchAirportPageData(AIRPORT);
    expect(data.totalLots).toBe(1);
    expect(searchMock.searchParking).toHaveBeenCalledTimes(2);
  });

  it("is per airport: a failed JFK does not stop LGA from rendering, and JFK stays memoised", async () => {
    searchMock.searchParking.mockRejectedValueOnce(new Error("boom"));
    await expect(fetchAirportPageData(AIRPORT)).rejects.toThrow("boom");

    searchMock.searchParking.mockResolvedValue(result({ results: [lot(1)], total: 1, locationsConsidered: 1 }));
    const data = await fetchAirportPageData(LGA);
    expect(data.totalLots).toBe(1);

    await expect(fetchAirportPageData(AIRPORT)).rejects.toThrow("boom");
    expect(searchMock.searchParking).toHaveBeenCalledTimes(2); // JFK once, LGA once
  });

  it("still memoised one millisecond before expiry", async () => {
    vi.useFakeTimers();
    const t0 = new Date("2026-10-07T12:00:00Z").getTime();
    vi.setSystemTime(t0);
    searchMock.searchParking.mockRejectedValue(new Error("boom"));
    await expect(fetchAirportPageData(AIRPORT)).rejects.toThrow("boom");
    vi.setSystemTime(t0 + AIRPORT_PAGE_FAILURE_MEMO_MS - 1);
    await expect(fetchAirportPageData(AIRPORT)).rejects.toThrow("boom");
    expect(searchMock.searchParking).toHaveBeenCalledTimes(1);
  });

  it("a thin-list refusal is memoised too", async () => {
    searchMock.searchParking.mockResolvedValue(
      result({ results: [lot(1)], total: 1, listIncomplete: true, degraded: true, locationsConsidered: 1 }),
    );
    await expect(fetchAirportPageData(AIRPORT)).rejects.toThrow(/thin/i);
    await expect(fetchAirportPageData(AIRPORT)).rejects.toThrow(/thin/i);
    expect(searchMock.searchParking).toHaveBeenCalledTimes(1);
  });

  it("reports how many requests the expired entry answered on the next capture", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-07T12:00:00Z"));
    searchMock.searchParking.mockRejectedValue(new Error("boom"));
    await expect(fetchAirportPageData(AIRPORT)).rejects.toThrow("boom");
    for (let i = 0; i < 3; i++) await expect(fetchAirportPageData(AIRPORT)).rejects.toThrow("boom");

    vi.setSystemTime(Date.now() + AIRPORT_PAGE_FAILURE_MEMO_MS);
    await expect(fetchAirportPageData(AIRPORT)).rejects.toThrow("boom");
    expect(captureMock.captureAPIError).toHaveBeenCalledTimes(2);
    expect(captureMock.captureAPIError.mock.calls[1][1]).toMatchObject({
      extra: { memoSuppressedRequests: 3 },
    });
  });

  it("an all-sold-out answer is not a failure and is not memoised", async () => {
    searchMock.searchParking.mockResolvedValue(result({ locationsConsidered: 4 }));
    await fetchAirportPageData(AIRPORT);
    await fetchAirportPageData(AIRPORT);
    expect(searchMock.searchParking).toHaveBeenCalledTimes(2);
  });

  it("is not consulted during `next build`", async () => {
    process.env.NEXT_PHASE = "phase-production-build";
    searchMock.searchParking.mockRejectedValue(new Error("boom"));
    await fetchAirportPageData(AIRPORT);
    await fetchAirportPageData(AIRPORT);
    expect(searchMock.searchParking).toHaveBeenCalledTimes(2);
  });
});

describe("airport page — locationsConsidered (empty-state copy key)", () => {
  it("passes searchParking's count through when nothing was bookable", async () => {
    searchMock.searchParking.mockResolvedValue(result({ locationsConsidered: 3 }));
    const data = await fetchAirportPageData(AIRPORT);
    expect(data.totalLots).toBe(0);
    expect(data.locationsConsidered).toBe(3);
  });

  it("is 0 when we list no lots near the airport", async () => {
    searchMock.searchParking.mockResolvedValue(result({ locationsConsidered: 0 }));
    const data = await fetchAirportPageData(AIRPORT);
    expect(data.locationsConsidered).toBe(0);
  });

  it("a failed direct-lot read refuses to cache, without its own capture (the store reported it)", async () => {
    searchMock.searchParking.mockResolvedValue(
      result({ locationsConsidered: 0, directUnavailable: true, directCount: 0 }),
    );
    await expect(fetchAirportPageData(AIRPORT)).rejects.toThrow(/Direct lots unavailable/);
    // Throttled as self-reporting: the first one in the window is captured,
    // never one per request.
    expect(captureMock.captureAPIError.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it("a failed direct-lot read with ResLab lots present renders and caches (as /api/search does)", async () => {
    searchMock.searchParking.mockResolvedValue(
      result({ results: [lot(1), lot(2)], total: 2, locationsConsidered: 2, directUnavailable: true, directCount: 0 }),
    );
    const data = await fetchAirportPageData(AIRPORT);
    expect(data.totalLots).toBe(2);
  });

  it("a throttled re-failure keeps the suppressed count for the next real capture", async () => {
    vi.useFakeTimers();
    const t0 = new Date("2026-10-07T12:00:00Z").getTime();
    vi.setSystemTime(t0);
    const directDown = () => result({ locationsConsidered: 0, directUnavailable: true, directCount: 0 });
    searchMock.searchParking.mockResolvedValue(directDown());
    await expect(fetchAirportPageData(AIRPORT)).rejects.toThrow(/Direct lots unavailable/); // captured
    await expect(fetchAirportPageData(AIRPORT)).rejects.toThrow(); // memo: suppressed 1
    vi.setSystemTime(t0 + AIRPORT_PAGE_FAILURE_MEMO_MS); // memo expired, 10-min report throttle not
    await expect(fetchAirportPageData(AIRPORT)).rejects.toThrow(); // throttled: no capture
    await expect(fetchAirportPageData(AIRPORT)).rejects.toThrow(); // memo: suppressed 2
    expect(captureMock.captureAPIError).toHaveBeenCalledTimes(1);

    vi.setSystemTime(t0 + 2 * AIRPORT_PAGE_FAILURE_MEMO_MS); // throttle window over
    await expect(fetchAirportPageData(AIRPORT)).rejects.toThrow();
    expect(captureMock.captureAPIError).toHaveBeenCalledTimes(2);
    expect(captureMock.captureAPIError.mock.calls[1][1]).toMatchObject({
      extra: { memoSuppressedRequests: 2 },
    });
  });

  it("during `next build`, a thin list's count becomes null — never a confident 0", async () => {
    process.env.NEXT_PHASE = "phase-production-build";
    searchMock.searchParking.mockResolvedValue(
      result({ results: [], total: 0, listIncomplete: true, degraded: true, locationsConsidered: 0 }),
    );
    const data = await fetchAirportPageData(AIRPORT);
    expect(data.totalLots).toBe(0);
    expect(data.locationsConsidered).toBeNull();
  });

  it("is null (unknown) when the search failed during `next build`", async () => {
    process.env.NEXT_PHASE = "phase-production-build";
    searchMock.searchParking.mockRejectedValue(new Error("boom"));
    const data = await fetchAirportPageData(AIRPORT);
    expect(data.totalLots).toBe(0);
    expect(data.locationsConsidered).toBeNull();
  });
});
