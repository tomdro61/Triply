import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Same idiom as location-list-cache.test.ts for ResLab + Sentry; the snapshot
// STORE is mocked as a module (the lot-slug-lookup.test.ts idiom), so this
// suite never touches supabase-js.
const reslabMock = vi.hoisted(() => ({ getAllLocations: vi.fn() }));
vi.mock("@/lib/reslab/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/reslab/client")>("@/lib/reslab/client");
  return { ...actual, reslab: { ...actual.reslab, getAllLocations: reslabMock.getAllLocations } };
});
const captureMock = vi.hoisted(() => ({ captureAPIError: vi.fn() }));
vi.mock("@/lib/sentry", async () => {
  const actual = await vi.importActual<typeof import("@/lib/sentry")>("@/lib/sentry");
  return { ...actual, captureAPIError: captureMock.captureAPIError };
});
const storeMock = vi.hoisted(() => ({ readSnapshot: vi.fn() }));
vi.mock("@/lib/reslab/location-snapshot", async () => {
  const actual = await vi.importActual<typeof import("@/lib/reslab/location-snapshot")>("@/lib/reslab/location-snapshot");
  return { ...actual, readSnapshot: storeMock.readSnapshot };
});

import { ReslabError } from "@/lib/reslab/client";
import {
  getChannelLocationsCached,
  getChannelLocationsNoSweep,
  sweepChannelLocations,
  __resetLocationListCacheForTests,
} from "../search";
import { SNAPSHOT_FRESH_MS, SNAPSHOT_MAX_AGE_MS } from "../location-snapshot";

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const PAGES = 4;
const PER_PAGE = 2;
const T0 = Date.parse("2026-09-27T12:00:00Z");

function loc(id: number) {
  return { id, name: `Lot ${id}`, latitude: "42.0", longitude: "-71.0" };
}
function page(n: number) {
  const base = (n - 1) * PER_PAGE + 1;
  return { data: [base, base + 1].map(loc), last_page: PAGES, current_page: n, per_page: PER_PAGE, total: PAGES * PER_PAGE };
}
function healthy() {
  reslabMock.getAllLocations.mockImplementation(async (p: number) => page(p));
}
function refusing() {
  reslabMock.getAllLocations.mockImplementation(async () => {
    throw new ReslabError(502, "Bad Gateway");
  });
}
function hit(n: number, ageMs: number) {
  const locations = Array.from({ length: n }, (_, i) => loc(1000 + i));
  storeMock.readSnapshot.mockResolvedValue({ kind: "hit", locations, builtAtMs: Date.now() - ageMs, ageMs, row: {} });
  return locations;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(T0));
  reslabMock.getAllLocations.mockReset();
  captureMock.captureAPIError.mockReset();
  storeMock.readSnapshot.mockReset();
  storeMock.readSnapshot.mockResolvedValue({ kind: "miss", reason: "no snapshot row", reportable: false });
  delete process.env.NEXT_PHASE;
  process.env.ENABLE_RESLAB_LOCATION_SNAPSHOT = "true";
  __resetLocationListCacheForTests();
});
afterEach(() => {
  vi.useRealTimers();
  delete process.env.ENABLE_RESLAB_LOCATION_SNAPSHOT;
});

describe("flag off ⇒ byte-for-byte today's behaviour", () => {
  it("makes ZERO store calls and sweeps as before", async () => {
    delete process.env.ENABLE_RESLAB_LOCATION_SNAPSHOT;
    healthy();
    const r = await getChannelLocationsCached();
    expect(r).toMatchObject({ incomplete: false, stale: false });
    expect(r.data).toHaveLength(PAGES * PER_PAGE);
    expect(storeMock.readSnapshot).not.toHaveBeenCalled();
    expect(reslabMock.getAllLocations).toHaveBeenCalledTimes(PAGES);
  });
});

describe("snapshot adoption", () => {
  it("a fresh snapshot is served with ZERO ResLab calls, fresh under 10 h", async () => {
    refusing();
    const locations = hit(150, 1 * HOUR);
    const r = await getChannelLocationsCached();
    expect(r).toEqual({ data: locations, incomplete: false, stale: false });
    expect(reslabMock.getAllLocations).not.toHaveBeenCalled();
  });

  it("10–24 h old is served complete but `stale` (60 s CDN TTL) — still no sweep", async () => {
    refusing();
    hit(150, 12 * HOUR);
    const r = await getChannelLocationsCached();
    expect(r).toMatchObject({ incomplete: false, stale: true });
    expect(reslabMock.getAllLocations).not.toHaveBeenCalled();
  });

  it("the store rejects > 24 h itself; if one were adopted it would fall through to today's sweep as a fallback", async () => {
    healthy();
    // Simulate the store returning a hit at 23 h, then time passing past 24 h in memory.
    // 10 lots (not 150): the healthy 8-lot sweep must not trip the ≥ 50 % anti-ratchet
    // against the snapshot — that guard has its own test below.
    hit(10, 23 * HOUR);
    await getChannelLocationsCached();
    vi.setSystemTime(new Date(T0 + 2 * HOUR)); // now 25 h old in memory
    storeMock.readSnapshot.mockResolvedValue({ kind: "miss", reason: "too old (25 h)", reportable: true });
    const r = await getChannelLocationsCached();
    // Swept fresh (healthy ResLab), the snapshot was only the fallback.
    expect(r).toMatchObject({ incomplete: false, stale: false });
    expect(r.data).toHaveLength(PAGES * PER_PAGE);
    expect(reslabMock.getAllLocations).toHaveBeenCalledTimes(PAGES);
  });

  it("with the snapshot > 24 h in memory AND ResLab refusing, the snapshot is the 'never downgrade' fallback (no 503)", async () => {
    hit(150, 23 * HOUR);
    healthy();
    await getChannelLocationsCached();
    vi.setSystemTime(new Date(T0 + 2 * HOUR));
    storeMock.readSnapshot.mockResolvedValue({ kind: "miss", reason: "too old", reportable: true });
    refusing();
    const r = await getChannelLocationsCached();
    expect(r.data).toHaveLength(150);
    expect(r).toMatchObject({ incomplete: false, stale: true });
  });
});

describe("the 24 h boundary is pinned (SNAPSHOT_MAX_AGE_MS ≤ LOCATION_LIST_TTL_MS)", () => {
  it("a snapshot one minute past 24 h is never served as stale:false — it becomes the sweep's fallback", async () => {
    hit(150, 23 * HOUR + 59 * MINUTE);
    healthy();
    let r = await getChannelLocationsCached();
    expect(r).toMatchObject({ incomplete: false, stale: true }); // served, stale
    vi.setSystemTime(new Date(T0 + 2 * MINUTE)); // now 24 h 1 min
    storeMock.readSnapshot.mockResolvedValue({ kind: "miss", reason: "no newer snapshot", reportable: false });
    reslabMock.getAllLocations.mockClear(); // so the assertion below is about THIS call
    refusing(); // ResLab down: the only thing that can answer is the fallback
    r = await getChannelLocationsCached();
    expect(reslabMock.getAllLocations).toHaveBeenCalled(); // it LEFT the snapshot branch and tried to sweep
    expect(r.data).toHaveLength(150); // …and the snapshot was the fallback
    expect(r.stale).toBe(true); // NEVER stale:false past the ceiling
  });
});

describe("anti-ratchet and laundering guards", () => {
  it("a smaller snapshot never replaces a bigger complete swept list", async () => {
    healthy();
    await getChannelLocationsCached(); // swept 8 lots, complete, fresh
    vi.setSystemTime(new Date(T0 + 25 * HOUR)); // memory past its TTL → a read is allowed
    hit(4, 1 * HOUR); // fewer lots than memory holds... (4 < 8)
    healthy();
    const r = await getChannelLocationsCached();
    expect(r.data).toHaveLength(PAGES * PER_PAGE); // re-swept, the snapshot was not adopted
    expect(captureMock.captureAPIError.mock.calls.some((c) => /smaller than the in-memory/.test(String(c[0])))).toBe(true);
  });

  it("an older snapshot never replaces a newer swept complete list", async () => {
    healthy();
    await getChannelLocationsCached();
    vi.setSystemTime(new Date(T0 + 25 * HOUR));
    hit(150, 30 * HOUR); // older than the swept list, though bigger
    const r = await getChannelLocationsCached();
    expect(r.data).toHaveLength(PAGES * PER_PAGE);
  });

  it("a rejected sweep AFTER adoption keeps the snapshot in memory (the v2 insertion-point bug)", async () => {
    hit(150, 23 * HOUR);
    healthy();
    await getChannelLocationsCached();
    vi.setSystemTime(new Date(T0 + 2 * HOUR)); // snapshot now 25 h: fresh path off, sweep path on
    storeMock.readSnapshot.mockResolvedValue({ kind: "miss", reason: "too old", reportable: true });
    // Partial sweep: page 3 refused → rejected build assembling fewer lots than the snapshot.
    reslabMock.getAllLocations.mockImplementation(async (p: number) => {
      if (p === 3) throw new ReslabError(502, "Bad Gateway");
      return page(p);
    });
    const r = await getChannelLocationsCached();
    expect(r.data).toHaveLength(150); // the snapshot won the "never downgrade" comparison
    expect(r).toMatchObject({ incomplete: false, stale: true });
  });
});

describe("debounce + single-flight (the per-request-read guard)", () => {
  it("at most one store read per 15 min per instance, regardless of outcome", async () => {
    healthy();
    storeMock.readSnapshot.mockResolvedValue({ kind: "miss", reason: "read failed (PGRST205)", reportable: true });
    await getChannelLocationsCached(); // read 1 (miss) → sweep → memory fresh+complete
    vi.setSystemTime(new Date(T0 + 5 * MINUTE));
    await getChannelLocationsCached(); // memory fresh: no read even attempted
    expect(storeMock.readSnapshot).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date(T0 + 25 * HOUR)); // memory past TTL
    refusing(); // and ResLab down, so memory STAYS stale (a healthy sweep would make it fresh again)
    await getChannelLocationsCached();
    await getChannelLocationsCached();
    await getChannelLocationsCached();
    expect(storeMock.readSnapshot).toHaveBeenCalledTimes(2); // one more, not three
    vi.setSystemTime(new Date(T0 + 25 * HOUR + 16 * MINUTE));
    await getChannelLocationsCached();
    expect(storeMock.readSnapshot).toHaveBeenCalledTimes(3);
  });

  it("concurrent cold starts share ONE store read", async () => {
    refusing();
    let resolve!: (v: unknown) => void;
    storeMock.readSnapshot.mockImplementation(() => new Promise((r) => (resolve = r)));
    const a = getChannelLocationsCached();
    const b = getChannelLocationsCached();
    const c = getChannelLocationsCached();
    expect(storeMock.readSnapshot).toHaveBeenCalledTimes(1);
    const locations = Array.from({ length: 150 }, (_, i) => loc(i + 1));
    resolve({ kind: "hit", locations, builtAtMs: Date.now() - HOUR, ageMs: HOUR, row: {} });
    const rs = await Promise.all([a, b, c]);
    for (const r of rs) expect(r.data).toHaveLength(150);
  });

  it("reportable misses are reported at most once per 6 h per instance", async () => {
    healthy();
    storeMock.readSnapshot.mockResolvedValue({ kind: "miss", reason: "read failed (PGRST205)", reportable: true });
    await getChannelLocationsCached();
    vi.setSystemTime(new Date(T0 + 25 * HOUR));
    await getChannelLocationsCached();
    vi.setSystemTime(new Date(T0 + 25 * HOUR + 20 * MINUTE));
    await getChannelLocationsCached();
    const reports = captureMock.captureAPIError.mock.calls.filter((c) => /snapshot not usable/.test(String(c[0])));
    // T0 and T0+25h are more than 6 h apart (two reports); the +20 min call adds none.
    expect(reports).toHaveLength(2);
  });
});

describe("sweepChannelLocations — the extracted, state-free sweep", () => {
  it("returns the parts the cron writes, with rowsFetched pre-dedupe and the sweep's own start", async () => {
    // Page 2 repeats page 1's rows (ResLab duplication): 8 rows fetched, 6 unique.
    reslabMock.getAllLocations.mockImplementation(async (p: number) => (p === 2 ? { ...page(2), data: page(1).data } : page(p)));
    const s = await sweepChannelLocations(null);
    expect(s.rowsFetched).toBe(8);
    expect(s.unique).toHaveLength(6);
    expect(s.paginatorTotal).toBe(8);
    expect(s.lastPage).toBe(4);
    expect(s.refusedPages + s.skippedPages).toBe(0);
    expect(s.implausible).toBe(false); // rows (8) vs total (8), NOT unique (6)
    expect(s.sweepStartedAt).toBe(T0);
  });
  it("applies the ≥ 50 % anti-ratchet against a trusted size the caller passes", async () => {
    healthy();
    expect((await sweepChannelLocations(100)).implausible).toBe(true);
    expect((await sweepChannelLocations(10)).implausible).toBe(false);
  });
  it("refused pages are counted, never thrown, and the sweep never touches the cache or Sentry", async () => {
    reslabMock.getAllLocations.mockImplementation(async (p: number) => {
      if (p === 3) throw new ReslabError(502, "Bad Gateway");
      return page(p);
    });
    const s = await sweepChannelLocations(null);
    expect(s.refusedPages).toBe(1);
    expect(captureMock.captureAPIError).not.toHaveBeenCalled();
  });
});

// The sitemap's reader: it must never spend the rate-limited /locations budget.
describe("getChannelLocationsNoSweep", () => {
  it("flag off, nothing in memory: null, with ZERO store and ResLab calls", async () => {
    delete process.env.ENABLE_RESLAB_LOCATION_SNAPSHOT;
    healthy();
    await expect(getChannelLocationsNoSweep()).resolves.toBeNull();
    expect(storeMock.readSnapshot).not.toHaveBeenCalled();
    expect(reslabMock.getAllLocations).not.toHaveBeenCalled();
  });

  it("flag on, snapshot hit: the snapshot list, no sweep", async () => {
    healthy();
    const locations = hit(150, 1 * HOUR);
    await expect(getChannelLocationsNoSweep()).resolves.toEqual(locations);
    expect(reslabMock.getAllLocations).not.toHaveBeenCalled();
  });

  it("flag on, snapshot miss, ResLab healthy: still null — it never falls through to a sweep", async () => {
    healthy();
    await expect(getChannelLocationsNoSweep()).resolves.toBeNull();
    await expect(getChannelLocationsNoSweep()).resolves.toBeNull();
    expect(reslabMock.getAllLocations).not.toHaveBeenCalled();
    // Inside the 15-minute debounce the store is read once, not per call.
    expect(storeMock.readSnapshot).toHaveBeenCalledTimes(1);
  });

  it("never hands out an incomplete list held in memory", async () => {
    delete process.env.ENABLE_RESLAB_LOCATION_SNAPSHOT;
    reslabMock.getAllLocations.mockImplementation(async (p: number) => {
      if (p === 3) throw new ReslabError(502, "Bad Gateway");
      return page(p);
    });
    await getChannelLocationsCached().catch(() => {});
    reslabMock.getAllLocations.mockClear();
    await expect(getChannelLocationsNoSweep()).resolves.toBeNull();
    expect(reslabMock.getAllLocations).not.toHaveBeenCalled();
  });

  it("flag off, warm instance: returns the list an earlier search swept, without sweeping again", async () => {
    delete process.env.ENABLE_RESLAB_LOCATION_SNAPSHOT;
    healthy();
    await getChannelLocationsCached();
    reslabMock.getAllLocations.mockClear();
    const list = await getChannelLocationsNoSweep();
    expect(list).toHaveLength(PAGES * PER_PAGE);
    expect(reslabMock.getAllLocations).not.toHaveBeenCalled();
  });

  it("refuses a list older than the 72 h ceiling", async () => {
    delete process.env.ENABLE_RESLAB_LOCATION_SNAPSHOT;
    healthy();
    await getChannelLocationsCached();
    vi.setSystemTime(new Date(T0 + 73 * HOUR));
    await expect(getChannelLocationsNoSweep()).resolves.toBeNull();
  });

  it("a throwing store read resolves null instead of throwing (a throw would fail the build)", async () => {
    healthy();
    storeMock.readSnapshot.mockRejectedValue(new Error("boom"));
    await expect(getChannelLocationsNoSweep()).resolves.toBeNull();
    expect(reslabMock.getAllLocations).not.toHaveBeenCalled();
  });
});
