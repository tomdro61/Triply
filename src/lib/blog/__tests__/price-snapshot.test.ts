import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const dataMock = vi.hoisted(() => ({ fetchAirportPageData: vi.fn() }));
vi.mock("@/lib/airport-page/data", () => dataMock);

const afterMock = vi.hoisted(() => ({ after: vi.fn() }));
vi.mock("next/server", () => afterMock);

const sentryMock = vi.hoisted(() => ({ captureAPIError: vi.fn() }));
vi.mock("@/lib/sentry", () => sentryMock);

// unstable_cache as Next 16 behaves for this caller: a resolved value is kept
// under its key; a throw is not stored, so the next call runs the function again.
const store = vi.hoisted(() => new Map<string, unknown>());
vi.mock("next/cache", () => ({
  unstable_cache:
    (fn: () => Promise<unknown>, key: string[]) =>
    async () => {
      const k = key.join("|");
      if (store.has(k)) return store.get(k);
      const v = await fn();
      store.set(k, v);
      return v;
    },
}));

import type { AirportPageData } from "@/lib/airport-page/data";
import type { UnifiedLot } from "@/types/lot";
import {
  buildSnapshot,
  getBlogPriceSnapshot,
  priceCacheWindow,
  SNAPSHOT_TIMEOUT_MS,
  __resetBlogPriceInFlightForTests,
} from "../price-snapshot";

function lot(slug: string, price: number | undefined, extra: Partial<UnifiedLot> = {}): UnifiedLot {
  return {
    id: `reslab-${slug}`,
    source: "reslab",
    sourceId: "1",
    name: slug.toUpperCase(),
    slug,
    address: "",
    city: "",
    state: "",
    latitude: 0,
    longitude: 0,
    amenities: [],
    photos: [],
    pricing: price === undefined ? undefined : { minPrice: price, currency: "USD", parkingTypes: [] },
    availability: "available",
    ...extra,
  };
}

function pageData(lots: UnifiedLot[]): AirportPageData {
  return {
    lots,
    topLots: lots.slice(0, 6),
    cheapestLot: null,
    // Deliberately wrong: buildSnapshot must take the "from" price from its own lots, not this field.
    cheapestPrice: 999,
    closestLot: null,
    totalLots: lots.length,
    priceRange: null,
    hasShuttle: false,
    commonAmenities: [],
    distanceRange: null,
    locationsConsidered: lots.length,
  };
}

const shuttle = { shuttleInfo: { summary: "every 10 min" } } as Partial<UnifiedLot>;

describe("buildSnapshot", () => {
  it("keeps the 3 cheapest priced lots, cheapest first, and skips unpriced, zero and NaN prices", () => {
    const s = buildSnapshot("JFK", "new-york-jfk", pageData([
        lot("d", 30),
        lot("u", undefined),
        lot("a", 12.5, { ...shuttle, distanceFromAirport: 1.2 }),
        lot("zero", 0),
        lot("nan", Number.NaN),
        lot("c", 20),
        lot("b", 15, { distanceFromAirport: 0 }),
      ]), 1);
    expect(s).not.toBeNull();
    expect(s!.fromPrice).toBe(12.5);
    expect(s!.lots.map((l) => l.slug)).toEqual(["a", "b", "c"]);
    expect(s!.lots[0]).toMatchObject({ shuttle: true, distance: 1.2, usdLabel: false });
    expect(s!.lots[1]).toMatchObject({ shuttle: false, distance: 0 });
    expect(s!.lots[2].distance).toBeNull();
    expect(s!.totalLots).toBe(7);
  });

  it("only says Shuttle when the lot has a shuttle summary (same as the airport page)", () => {
    const s = buildSnapshot("JFK", "new-york-jfk", pageData([lot("e", 9, { shuttleInfo: { summary: "" } } as Partial<UnifiedLot>)]), 1);
    expect(s!.lots[0].shuttle).toBe(false);
  });

  it("labels US$ from the cheapest lot itself", () => {
    const s = buildSnapshot("YYZ", "toronto-yyz", pageData([lot("cad", 18, { fxRateId: "fx1" }), lot("usd", 40)]), 1);
    expect(s!.fromUsdLabel).toBe(true);
    expect(s!.lots.map((l) => l.usdLabel)).toEqual([true, false]);
  });

  it("shows a lone priced lot when the rest failed to price", () => {
    const s = buildSnapshot("JFK", "new-york-jfk", pageData([lot("x", undefined), lot("y", undefined), lot("only", 11)]), 1);
    expect(s!.lots.map((l) => l.slug)).toEqual(["only"]);
    expect(s!.fromPrice).toBe(11);
  });

  it("returns null when nothing is priced", () => {
    expect(buildSnapshot("JFK", "new-york-jfk", pageData([lot("u", undefined)]), 1)).toBeNull();
    expect(buildSnapshot("JFK", "new-york-jfk", pageData([]), 1)).toBeNull();
  });
});

describe("getBlogPriceSnapshot", () => {
  const phase = process.env.NEXT_PHASE;
  beforeEach(() => {
    dataMock.fetchAirportPageData.mockReset();
    sentryMock.captureAPIError.mockReset();
    afterMock.after.mockReset();
    store.clear();
    __resetBlogPriceInFlightForTests();
    delete process.env.NEXT_PHASE;
  });
  afterEach(() => {
    vi.useRealTimers();
    if (phase === undefined) delete process.env.NEXT_PHASE;
    else process.env.NEXT_PHASE = phase;
  });

  it("loads nothing for a post without an airport we sell", async () => {
    expect(await getBlogPriceSnapshot(null)).toBeNull();
    expect(await getBlogPriceSnapshot("ZZZ")).toBeNull();
    expect(dataMock.fetchAirportPageData).not.toHaveBeenCalled();
  });

  it("shares one load per airport: two JFK posts search once, an LGA post searches again", async () => {
    dataMock.fetchAirportPageData.mockResolvedValue(pageData([lot("a", 10)]));
    expect((await getBlogPriceSnapshot("jfk"))?.airportCode).toBe("JFK");
    expect((await getBlogPriceSnapshot("JFK"))?.airportCode).toBe("JFK");
    expect(dataMock.fetchAirportPageData).toHaveBeenCalledTimes(1);
    await getBlogPriceSnapshot("LGA");
    expect(dataMock.fetchAirportPageData).toHaveBeenCalledTimes(2);
  });

  it("merges simultaneous misses into one search", async () => {
    let release!: (v: AirportPageData) => void;
    dataMock.fetchAirportPageData.mockReturnValue(new Promise<AirportPageData>((r) => (release = r)));
    const a = getBlogPriceSnapshot("JFK");
    const b = getBlogPriceSnapshot("JFK");
    release(pageData([lot("a", 10)]));
    expect((await a)?.fromPrice).toBe(10);
    expect((await b)?.fromPrice).toBe(10);
    expect(dataMock.fetchAirportPageData).toHaveBeenCalledTimes(1);
  });

  it("does not cache a failure: the next request searches again", async () => {
    dataMock.fetchAirportPageData.mockRejectedValueOnce(new Error("reslab down"));
    expect(await getBlogPriceSnapshot("JFK")).toBeNull();
    expect(sentryMock.captureAPIError).toHaveBeenCalledTimes(1);
    dataMock.fetchAirportPageData.mockResolvedValueOnce(pageData([lot("a", 10)]));
    expect((await getBlogPriceSnapshot("JFK"))?.fromPrice).toBe(10);
    expect(dataMock.fetchAirportPageData).toHaveBeenCalledTimes(2);
  });

  it("renders without prices when the search is slow, and the late result fills the cache", async () => {
    vi.useFakeTimers();
    let release!: (v: AirportPageData) => void;
    dataMock.fetchAirportPageData.mockReturnValue(new Promise<AirportPageData>((r) => (release = r)));
    const first = getBlogPriceSnapshot("JFK");
    await vi.advanceTimersByTimeAsync(SNAPSHOT_TIMEOUT_MS + 1);
    expect(await first).toBeNull();
    expect(afterMock.after).toHaveBeenCalledTimes(1);
    expect(sentryMock.captureAPIError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ stage: "blog-price-snapshot-timeout", level: "warning" })
    );
    release(pageData([lot("a", 10)]));
    await vi.advanceTimersByTimeAsync(0);
    expect((await getBlogPriceSnapshot("JFK"))?.fromPrice).toBe(10);
    expect(dataMock.fetchAirportPageData).toHaveBeenCalledTimes(1);
  });

  it("on a timeout, serves this instance's last good prices for the airport, and reports once", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 10, 18, 15));
    dataMock.fetchAirportPageData.mockResolvedValueOnce(pageData([lot("a", 10)]));
    expect((await getBlogPriceSnapshot("JFK"))?.fromPrice).toBe(10);
    vi.setSystemTime(Date.UTC(2026, 10, 18, 16, 30)); // next window: a miss
    dataMock.fetchAirportPageData.mockReturnValue(new Promise<AirportPageData>(() => {}));
    const a = getBlogPriceSnapshot("JFK");
    const b = getBlogPriceSnapshot("JFK");
    await vi.advanceTimersByTimeAsync(SNAPSHOT_TIMEOUT_MS + 1);
    expect((await a)?.fromPrice).toBe(10);
    expect((await b)?.fromPrice).toBe(10);
    expect(sentryMock.captureAPIError).toHaveBeenCalledTimes(1);
    // The captured after() callback waits on the slow load itself.
    const cb = afterMock.after.mock.calls[0][0] as () => unknown;
    expect(cb()).toBeInstanceOf(Promise);
  });

  it("never falls back to an old price after a load found nothing priced", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 10, 18, 15));
    dataMock.fetchAirportPageData.mockResolvedValueOnce(pageData([lot("a", 10)]));
    await getBlogPriceSnapshot("JFK");
    vi.setSystemTime(Date.UTC(2026, 10, 18, 16, 10));
    dataMock.fetchAirportPageData.mockResolvedValueOnce(pageData([lot("u", undefined)]));
    expect(await getBlogPriceSnapshot("JFK")).toBeNull();
    vi.setSystemTime(Date.UTC(2026, 10, 18, 17, 20));
    dataMock.fetchAirportPageData.mockReturnValue(new Promise<AirportPageData>(() => {}));
    const p = getBlogPriceSnapshot("JFK");
    await vi.advanceTimersByTimeAsync(SNAPSHOT_TIMEOUT_MS + 1);
    expect(await p).toBeNull();
  });

  it("drops last good prices older than 2 hours", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 10, 18, 12));
    dataMock.fetchAirportPageData.mockResolvedValueOnce(pageData([lot("a", 10)]));
    await getBlogPriceSnapshot("JFK");
    vi.setSystemTime(Date.UTC(2026, 10, 18, 14, 30));
    dataMock.fetchAirportPageData.mockReturnValue(new Promise<AirportPageData>(() => {}));
    const p = getBlogPriceSnapshot("JFK");
    await vi.advanceTimersByTimeAsync(SNAPSHOT_TIMEOUT_MS + 1);
    expect(await p).toBeNull();
  });

  it("still answers when after() is unavailable (outside a request)", async () => {
    vi.useFakeTimers();
    afterMock.after.mockImplementation(() => {
      throw new Error("after() outside a request scope");
    });
    dataMock.fetchAirportPageData.mockReturnValue(new Promise<AirportPageData>(() => {}));
    const p = getBlogPriceSnapshot("LGA");
    await vi.advanceTimersByTimeAsync(SNAPSHOT_TIMEOUT_MS + 1);
    expect(await p).toBeNull();
  });

  it("never prices during next build", async () => {
    process.env.NEXT_PHASE = "phase-production-build";
    expect(await getBlogPriceSnapshot("JFK")).toBeNull();
    expect(dataMock.fetchAirportPageData).not.toHaveBeenCalled();
  });
});

describe("priceCacheWindow", () => {
  it("lasts an hour per airport", () => {
    const t = Date.UTC(2026, 10, 18, 15);
    const w = priceCacheWindow(t, "JFK");
    let changes = 0;
    for (let m = 1; m <= 60; m++) if (priceCacheWindow(t + m * 60_000, "JFK") !== w) changes++;
    expect(changes).toBeGreaterThan(0);
    expect(priceCacheWindow(t + 60 * 60_000, "JFK")).not.toBe(w);
    expect(priceCacheWindow(t + 2 * 60 * 60_000, "JFK")).not.toBe(priceCacheWindow(t + 60 * 60_000, "JFK"));
  });

  it("staggers airports so they don't all expire on the hour", () => {
    const codes = ["JFK", "LGA", "EWR", "ATL", "LAX", "ORD", "DFW", "MCO"];
    const t = Date.UTC(2026, 10, 18, 15);
    const flips = codes.map((c) => {
      const w = priceCacheWindow(t, c);
      let m = 1;
      while (priceCacheWindow(t + m * 60_000, c) === w) m++;
      return m;
    });
    expect(new Set(flips).size).toBeGreaterThan(1);
  });
});
