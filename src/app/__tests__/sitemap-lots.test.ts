/**
 * Sitemap lot segments (/sitemap/100..104.xml) list ResLab lot pages from the
 * cached channel location list / shared snapshot — never from ResLab directly.
 * The old per-airport geo-search had been broken since June, leaving every
 * production lot segment empty (2026-10-07).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const reslabClient = vi.hoisted(() => ({ searchLocations: vi.fn(), getMinPrice: vi.fn(), getAllLocations: vi.fn() }));
vi.mock("@/lib/reslab/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/reslab/client")>("@/lib/reslab/client");
  return { ...actual, reslab: reslabClient };
});

const channel = vi.hoisted(() => ({ getChannelLocationsNoSweep: vi.fn() }));
vi.mock("@/lib/reslab/search", async () => {
  const actual = await vi.importActual<typeof import("@/lib/reslab/search")>("@/lib/reslab/search");
  return { ...actual, ...channel };
});

const snapshotFlag = vi.hoisted(() => ({ on: true }));
vi.mock("@/lib/reslab/location-snapshot", async () => {
  const actual = await vi.importActual<typeof import("@/lib/reslab/location-snapshot")>(
    "@/lib/reslab/location-snapshot",
  );
  return { ...actual, isSnapshotEnabled: () => snapshotFlag.on };
});

vi.mock("@/lib/cms", () => ({
  getPublishedPosts: vi.fn(),
  CmsAuthError: class extends Error {},
  getDistinctAirportCodes: vi.fn(),
  getCategories: vi.fn(),
  getContentUpdatedAt: vi.fn(),
  getPublishedPostCount: vi.fn(async () => 0),
}));

const directFlag = vi.hoisted(() => ({ on: false }));
vi.mock("@/lib/direct/flag", async () => {
  const actual = await vi.importActual<typeof import("@/lib/direct/flag")>("@/lib/direct/flag");
  return { ...actual, isDirectLotsEnabled: () => directFlag.on };
});

const directStore = vi.hoisted(() => ({ fetchDirectLots: vi.fn() }));
vi.mock("@/lib/direct/store", async () => {
  const actual = await vi.importActual<typeof import("@/lib/direct/store")>("@/lib/direct/store");
  return { ...actual, fetchDirectLots: directStore.fetchDirectLots, isListable: () => true };
});

const sentry = vi.hoisted(() => ({ captureAPIError: vi.fn() }));
vi.mock("@/lib/sentry", async () => {
  const actual = await vi.importActual<typeof import("@/lib/sentry")>("@/lib/sentry");
  return { ...actual, captureAPIError: sentry.captureAPIError };
});

import sitemap from "../sitemap";
import { productionAirports } from "@/config/airports";
import { LOTS_ID_START, AIRPORTS_PER_LOT_SEGMENT } from "@/lib/sitemap-config";

function directLot(over: Record<string, unknown>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { airportCode: "JFK", slug: "direct-jfk", reslabLocationId: null, updatedAt: "2026-10-01T00:00:00Z", ...over } as any;
}

function loc(id: number, name: string, lat: string, lng: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { id, name, latitude: lat, longitude: lng } as any;
}

const jfkIndex = productionAirports.findIndex((a) => a.code === "JFK");
const JFK_SEGMENT = LOTS_ID_START + Math.floor(jfkIndex / AIRPORTS_PER_LOT_SEGMENT);
const segment = (id: number) => sitemap({ id: Promise.resolve(id) });

beforeEach(() => {
  channel.getChannelLocationsNoSweep.mockReset();
  reslabClient.searchLocations.mockReset();
  reslabClient.getAllLocations.mockReset();
  snapshotFlag.on = true;
  directFlag.on = false;
  directStore.fetchDirectLots.mockReset();
  sentry.captureAPIError.mockReset();
  delete process.env.NEXT_PHASE;
  process.env.NEXT_PUBLIC_APP_ENV = "production";
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  delete process.env.NEXT_PHASE;
  delete process.env.NEXT_PUBLIC_APP_ENV;
});

describe("sitemap lot segments", () => {
  it("lists lots within the airport's radius from the cached list, minus blocked lots", async () => {
    expect(jfkIndex).toBeGreaterThanOrEqual(0);
    channel.getChannelLocationsNoSweep.mockResolvedValue([
      loc(1, "JFK Long Term Lot", "40.6600", "-73.7900"), // ~2 km from JFK
      loc(416, "Parking 4 Airport", "40.6600", "-73.7900"), // blocked
      loc(2, "Far Away Lot", "34.0500", "-118.2400"), // Los Angeles
    ]);

    const urls = (await segment(JFK_SEGMENT)).map((u) => u.url);

    expect(urls.some((u) => u.endsWith("/new-york-jfk/airport-parking/jfk-long-term-lot"))).toBe(true);
    expect(urls.some((u) => u.includes("parking-4-airport"))).toBe(false);
    expect(urls.some((u) => u.includes("far-away-lot") && u.includes("/new-york-jfk/"))).toBe(false);
    // Never calls ResLab: the old geo-search and the page sweep are both out.
    // The old per-airport geo-search is gone. (That the list reader never
    // sweeps is pinned in location-snapshot-read.test.ts.)
    expect(reslabClient.searchLocations).not.toHaveBeenCalled();
    // One list read per segment, not per airport.
    expect(channel.getChannelLocationsNoSweep).toHaveBeenCalledTimes(1);
  });

  it("lists each lot under its own airport only (JFK/LGA overlap); the kill switch restores both", async () => {
    const lgaIndex = productionAirports.findIndex((a) => a.code === "LGA");
    const LGA_SEGMENT = LOTS_ID_START + Math.floor(lgaIndex / AIRPORTS_PER_LOT_SEGMENT);
    const lots = [
      loc(275, "PARK AC JFK Airport Parking", "40.6637560", "-73.8152580"),
      loc(159, "Hyatt Place Flushing", "40.7589732", "-73.8323536"),
    ];
    channel.getChannelLocationsNoSweep.mockResolvedValue(lots);
    const both = async () =>
      (await Promise.all([...new Set([JFK_SEGMENT, LGA_SEGMENT])].map(segment))).flat().map((u) => u.url);

    let urls = await both();
    expect(urls.some((u) => u.endsWith("/new-york-jfk/airport-parking/park-ac-jfk-airport-parking"))).toBe(true);
    expect(urls.some((u) => u.endsWith("/new-york-jfk/airport-parking/hyatt-place-flushing"))).toBe(false);
    expect(urls.some((u) => u.endsWith("/new-york-lga/airport-parking/hyatt-place-flushing"))).toBe(true);
    expect(urls.some((u) => u.endsWith("/new-york-lga/airport-parking/park-ac-jfk-airport-parking"))).toBe(false);

    process.env.SEARCH_OWN_AIRPORT_FILTER = "off";
    try {
      urls = await both();
      expect(urls.some((u) => u.endsWith("/new-york-jfk/airport-parking/hyatt-place-flushing"))).toBe(true);
      expect(urls.some((u) => u.endsWith("/new-york-lga/airport-parking/park-ac-jfk-airport-parking"))).toBe(true);
    } finally {
      delete process.env.SEARCH_OWN_AIRPORT_FILTER;
    }
  });

  it("lists one URL when two lots share a name", async () => {
    channel.getChannelLocationsNoSweep.mockResolvedValue([
      loc(1, "Same Name", "40.6600", "-73.7900"),
      loc(3, "Same Name", "40.6500", "-73.7800"),
    ]);
    const urls = (await segment(JFK_SEGMENT)).map((u) => u.url);
    expect(urls.filter((u) => u.endsWith("/new-york-jfk/airport-parking/same-name"))).toHaveLength(1);
  });

  it("in production at runtime with no usable list, fails so Next keeps the previous segment", async () => {
    channel.getChannelLocationsNoSweep.mockResolvedValue(null);
    await expect(segment(JFK_SEGMENT)).rejects.toThrow(/keeping the previous segment/);
  });

  it("during `next build` with no usable list, returns no ResLab lots instead of failing the deploy", async () => {
    process.env.NEXT_PHASE = "phase-production-build";
    channel.getChannelLocationsNoSweep.mockResolvedValue(null);
    await expect(segment(JFK_SEGMENT)).resolves.toEqual([]);
    expect(console.warn).toHaveBeenCalled();
  });

  it("in production with the snapshot flag OFF (the rollback) and a cold instance, still keeps the previous segment", async () => {
    snapshotFlag.on = false;
    channel.getChannelLocationsNoSweep.mockResolvedValue(null);
    await expect(segment(JFK_SEGMENT)).rejects.toThrow(/keeping the previous segment/);
  });

  it("outside production (staging/preview), lists no ResLab lots and does not throw", async () => {
    process.env.NEXT_PUBLIC_APP_ENV = "staging";
    snapshotFlag.on = false;
    channel.getChannelLocationsNoSweep.mockResolvedValue(null);
    await expect(segment(JFK_SEGMENT)).resolves.toEqual([]);
  });
});

describe("sitemap lot segments — direct lots (ENABLE_DIRECT_LOTS)", () => {
  beforeEach(() => {
    directFlag.on = true;
  });

  it("lists a direct lot's slug and not its ResLab twin", async () => {
    channel.getChannelLocationsNoSweep.mockResolvedValue([loc(1, "JFK Long Term Lot", "40.6600", "-73.7900")]);
    directStore.fetchDirectLots.mockResolvedValue({ ok: true, lots: [directLot({ reslabLocationId: 1 })] });
    const urls = (await segment(JFK_SEGMENT)).map((u) => u.url);
    expect(urls.some((u) => u.endsWith("/new-york-jfk/airport-parking/direct-jfk"))).toBe(true);
    expect(urls.some((u) => u.endsWith("/jfk-long-term-lot"))).toBe(false);
  });

  it("a throwing direct read is reported and the ResLab URLs are kept", async () => {
    channel.getChannelLocationsNoSweep.mockResolvedValue([loc(1, "JFK Long Term Lot", "40.6600", "-73.7900")]);
    directStore.fetchDirectLots.mockRejectedValue(new Error("isListable bug"));
    const urls = (await segment(JFK_SEGMENT)).map((u) => u.url);
    expect(urls.some((u) => u.endsWith("/jfk-long-term-lot"))).toBe(true);
    expect(sentry.captureAPIError).toHaveBeenCalledTimes(1);
  });

  it("a failed direct read (ok: false) keeps the ResLab URLs", async () => {
    channel.getChannelLocationsNoSweep.mockResolvedValue([loc(1, "JFK Long Term Lot", "40.6600", "-73.7900")]);
    directStore.fetchDirectLots.mockResolvedValue({ ok: false, kind: "timeout" });
    const urls = (await segment(JFK_SEGMENT)).map((u) => u.url);
    expect(urls.some((u) => u.endsWith("/jfk-long-term-lot"))).toBe(true);
  });

  it("during `next build` with no list, lists the direct lots alone", async () => {
    process.env.NEXT_PHASE = "phase-production-build";
    channel.getChannelLocationsNoSweep.mockResolvedValue(null);
    directStore.fetchDirectLots.mockResolvedValue({ ok: true, lots: [directLot({})] });
    const urls = (await segment(JFK_SEGMENT)).map((u) => u.url);
    expect(urls).toHaveLength(1);
    expect(urls[0].endsWith("/new-york-jfk/airport-parking/direct-jfk")).toBe(true);
  });
});
