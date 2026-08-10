import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// vi.hoisted so the mock reference exists before the (hoisted) vi.mock factory.
const reslabMock = vi.hoisted(() => ({ getAllLocations: vi.fn() }));
vi.mock("@/lib/reslab/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/reslab/client")>(
    "@/lib/reslab/client",
  );
  return { ...actual, reslab: reslabMock };
});

// We assert capture happens on the degraded paths — an incomplete or stale list
// going unreported is how the 2026-08-10 incident stayed invisible behind 1,311
// Sentry events for ~4 weeks.
const captureMock = vi.hoisted(() => ({ captureAPIError: vi.fn() }));
vi.mock("@/lib/sentry", async () => {
  const actual = await vi.importActual<typeof import("@/lib/sentry")>(
    "@/lib/sentry",
  );
  return { ...actual, ...captureMock };
});

import { ReslabError } from "@/lib/reslab/client";
import {
  getChannelLocationsCached,
  __resetLocationListCacheForTests,
} from "../search";

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

// Deliberately PAGES !== locations: 4 pages × 2 rows = 8 locations. A fixture
// with one location per page lets `toHaveLength(PAGES)` silently pass whether
// the code is counting pages or locations, which is what hid the dedup gap.
const PAGES = 4;
const PER_PAGE = 2;
const TOTAL_ROWS = PAGES * PER_PAGE;

function loc(id: number) {
  return { id, latitude: "42.0", longitude: "-71.0" };
}

/** One page of the paginated /locations response. */
function page(
  n: number,
  opts: { lastPage?: number; total?: number; rows?: number[] } = {},
) {
  const base = (n - 1) * PER_PAGE + 1;
  return {
    data: (opts.rows ?? [base, base + 1]).map(loc),
    last_page: opts.lastPage ?? PAGES,
    current_page: n,
    per_page: PER_PAGE,
    total: opts.total ?? TOTAL_ROWS,
  };
}

/** All pages succeed. */
function healthy() {
  reslabMock.getAllLocations.mockImplementation(async (p: number) => page(p));
}

/** Page 1 succeeds, page `failAt` rejects — the partial-build case. */
function partialAt(failAt: number) {
  reslabMock.getAllLocations.mockImplementation(async (p: number) => {
    if (p === failAt) throw new ReslabError(429, "Too Many Requests");
    return page(p);
  });
}

/** Every page rejects, including page 1 — the total-failure case. */
function allFail() {
  reslabMock.getAllLocations.mockImplementation(async () => {
    throw new ReslabError(429, "Too Many Requests");
  });
}

beforeEach(() => {
  // Only fake Date — faking timers wholesale would stall the async batching.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-08-10T12:00:00Z"));
  reslabMock.getAllLocations.mockReset();
  captureMock.captureAPIError.mockReset();
  delete process.env.NEXT_PHASE;
  __resetLocationListCacheForTests();
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.NEXT_PHASE;
});

describe("location list cache — happy path", () => {
  it("cold build sweeps every page and reports fresh + complete", async () => {
    healthy();
    const r = await getChannelLocationsCached();

    expect(r.incomplete).toBe(false);
    expect(r.stale).toBe(false);
    expect(r.data).toHaveLength(TOTAL_ROWS);
    expect(reslabMock.getAllLocations).toHaveBeenCalledTimes(PAGES);
  });

  it("sweeps every page exactly once across MULTIPLE batches", async () => {
    // BATCH is 8; with 20 pages the batching loop runs 3 times. Every other
    // test uses 4 pages, where the loop body executes exactly once — so an
    // indexing regression that drops pages would report zero failures, look
    // complete, and cache a short list for 24h.
    const LAST = 20;
    reslabMock.getAllLocations.mockImplementation(async (p: number) =>
      page(p, { lastPage: LAST, total: LAST * PER_PAGE }),
    );

    const r = await getChannelLocationsCached();
    const pages = reslabMock.getAllLocations.mock.calls
      .map((c) => c[0] as number)
      .sort((a, b) => a - b);

    // Exact list also guards the "page 1, 597 times" pattern ResLab complained
    // about — it fails if any page is fetched twice.
    expect(pages).toEqual(Array.from({ length: LAST }, (_, i) => i + 1));
    expect(r.incomplete).toBe(false);
    expect(r.data).toHaveLength(LAST * PER_PAGE);
  });

  it("dedupes locations that ResLab repeats across pages", async () => {
    // Real ResLab behavior — the same id appears on several pages. Without
    // dedup, search renders duplicate lot cards and overstates the total.
    const rowsByPage: Record<number, number[]> = {
      1: [1, 2],
      2: [2, 3],
      3: [3, 4],
      4: [4, 5],
    };
    reslabMock.getAllLocations.mockImplementation(async (p: number) =>
      page(p, { rows: rowsByPage[p], total: 8 }),
    );

    const r = await getChannelLocationsCached();

    expect(r.data.map((l) => l.id)).toEqual([1, 2, 3, 4, 5]); // 8 rows → 5 lots
    expect(r.incomplete).toBe(false); // unique < total is NORMAL, not suspect
  });

  it("second call inside the TTL makes ZERO ResLab calls", async () => {
    healthy();
    await getChannelLocationsCached();
    reslabMock.getAllLocations.mockClear();

    vi.setSystemTime(Date.now() + 11 * HOUR);
    const r = await getChannelLocationsCached();

    expect(r.incomplete).toBe(false);
    expect(reslabMock.getAllLocations).not.toHaveBeenCalled();
  });

  it("TTL is 24h, not 1h — an hour later must NOT re-sweep", async () => {
    // The 1h TTL directly contributed to the 18,044 calls/day ResLab flagged.
    healthy();
    await getChannelLocationsCached();
    reslabMock.getAllLocations.mockClear();

    vi.setSystemTime(Date.now() + 2 * HOUR);
    await getChannelLocationsCached();

    expect(reslabMock.getAllLocations).not.toHaveBeenCalled();
  });

  it("re-sweeps once the TTL has genuinely elapsed", async () => {
    healthy();
    await getChannelLocationsCached();
    reslabMock.getAllLocations.mockClear();

    vi.setSystemTime(Date.now() + 25 * HOUR);
    const r = await getChannelLocationsCached();

    expect(r.incomplete).toBe(false);
    expect(reslabMock.getAllLocations).toHaveBeenCalledTimes(PAGES);
  });
});

describe("location list cache — the amplification loop (the outage)", () => {
  it("cold instance that just failed does NOT sweep again — it fails fast", async () => {
    // THE critical regression test. Previously every request during a rate
    // limit kicked off another 54-page sweep, which kept the limit engaged.
    allFail();
    await expect(getChannelLocationsCached()).rejects.toThrow(/Too Many/);
    const callsAfterFirst = reslabMock.getAllLocations.mock.calls.length;

    vi.setSystemTime(Date.now() + MINUTE);
    await expect(getChannelLocationsCached()).rejects.toThrow(/backing off/i);

    expect(reslabMock.getAllLocations).toHaveBeenCalledTimes(callsAfterFirst);
  });

  it("abandons a sweep once a whole batch is refused", async () => {
    // Finishing all 54 pages to prove we're rate-limited just deepens the
    // limit. Page 1 succeeds, then everything else is refused.
    reslabMock.getAllLocations.mockImplementation(async (p: number) => {
      if (p === 1) return page(1, { lastPage: 40, total: 80 });
      throw new ReslabError(429, "Too Many Requests");
    });

    const r = await getChannelLocationsCached();

    expect(r.incomplete).toBe(true);
    // 1 (page 1) + 8 (first dead batch) — then it gives up rather than
    // issuing the remaining ~31 requests.
    expect(reslabMock.getAllLocations).toHaveBeenCalledTimes(9);
  });

  it("retries again once the backoff window expires", async () => {
    allFail();
    await expect(getChannelLocationsCached()).rejects.toThrow();
    reslabMock.getAllLocations.mockClear();

    vi.setSystemTime(Date.now() + 11 * MINUTE);
    healthy();
    const r = await getChannelLocationsCached();

    expect(r.incomplete).toBe(false);
    expect(reslabMock.getAllLocations).toHaveBeenCalled();
  });

  it("reports the open breaker to Sentry once per window, not per request", async () => {
    allFail();
    await expect(getChannelLocationsCached()).rejects.toThrow();
    captureMock.captureAPIError.mockClear();

    vi.setSystemTime(Date.now() + MINUTE);
    for (let i = 0; i < 5; i++) {
      await expect(getChannelLocationsCached()).rejects.toThrow(/backing off/i);
    }

    // One diagnostic event for the window, not five.
    expect(captureMock.captureAPIError).toHaveBeenCalledTimes(1);
  });

  it("keeps sweeping during `next build` so a blip can't ship empty airport pages", async () => {
    // The backoff is module state shared across every prerendered airport page.
    // Honouring it during the build would fast-fail the rest of the pages, and
    // airport-page/data.ts swallows build-phase failures — shipping ~85 empty
    // indexable SEO pages.
    allFail();
    await expect(getChannelLocationsCached()).rejects.toThrow();
    reslabMock.getAllLocations.mockClear();

    process.env.NEXT_PHASE = "phase-production-build";
    vi.setSystemTime(Date.now() + MINUTE); // still inside the backoff window
    healthy();
    const r = await getChannelLocationsCached();

    expect(r.incomplete).toBe(false);
    expect(reslabMock.getAllLocations).toHaveBeenCalled();
  });
});

describe("location list cache — serving something beats serving nothing", () => {
  it("serves a stale COMPLETE list as stale (cacheable), not degraded", async () => {
    // The distinction that keeps CDN caching alive during an outage. Marking
    // this degraded would push every search to origin and fan out into one
    // min-price call per lot — amplification on a different endpoint.
    healthy();
    await getChannelLocationsCached();

    vi.setSystemTime(Date.now() + 25 * HOUR);
    allFail();
    const r = await getChannelLocationsCached();

    expect(r.stale).toBe(true);
    expect(r.incomplete).toBe(false); // full list → still CDN-cacheable
    expect(r.data).toHaveLength(TOTAL_ROWS);
    expect(captureMock.captureAPIError).toHaveBeenCalled();
  });

  it("retains a THIN list so the backoff window serves lots, not 503s", async () => {
    // A cold instance whose first sweep loses one page used to return the thin
    // list once and discard it — every request for the next 10 minutes then
    // hard-503'd. Worse than the blip it was reacting to.
    partialAt(3);
    const first = await getChannelLocationsCached();
    expect(first.incomplete).toBe(true);
    reslabMock.getAllLocations.mockClear();

    vi.setSystemTime(Date.now() + MINUTE);
    const during = await getChannelLocationsCached();

    expect(during.incomplete).toBe(true); // → no-store, never CDN-cached
    expect(during.data.length).toBeGreaterThan(0); // but customers see lots
    expect(reslabMock.getAllLocations).not.toHaveBeenCalled();
  });

  it("a retained thin list never counts as fresh — it keeps retrying", async () => {
    partialAt(3);
    await getChannelLocationsCached();
    reslabMock.getAllLocations.mockClear();

    vi.setSystemTime(Date.now() + 11 * MINUTE); // past backoff, inside 24h TTL
    healthy();
    const r = await getChannelLocationsCached();

    expect(reslabMock.getAllLocations).toHaveBeenCalled(); // did NOT sit on it
    expect(r.incomplete).toBe(false);
    expect(r.data).toHaveLength(TOTAL_ROWS);
  });

  it("prefers a previously-complete list over a freshly-thin one", async () => {
    healthy();
    await getChannelLocationsCached();

    vi.setSystemTime(Date.now() + 25 * HOUR);
    reslabMock.getAllLocations.mockImplementation(async (p: number) => {
      if (p !== 1) throw new ReslabError(429, "Too Many Requests");
      return page(1);
    });
    const r = await getChannelLocationsCached();

    expect(r.data).toHaveLength(TOTAL_ROWS); // the good list, not the thin one
    expect(r.stale).toBe(true);
    expect(r.incomplete).toBe(false);
  });

  it("does not launder a stale list into a fresh one", async () => {
    // If the stale-preference path re-stamped builtAt, the old list would read
    // as fresh for another 24h and get CDN-cached at full TTL.
    healthy();
    await getChannelLocationsCached();

    vi.setSystemTime(Date.now() + 25 * HOUR);
    partialAt(3);
    await getChannelLocationsCached();
    reslabMock.getAllLocations.mockClear();

    vi.setSystemTime(Date.now() + 11 * MINUTE);
    healthy();
    const next = await getChannelLocationsCached();

    expect(reslabMock.getAllLocations).toHaveBeenCalled();
    expect(next.stale).toBe(false);
  });

  it("refuses to serve a list past the 72h max age", async () => {
    healthy();
    await getChannelLocationsCached();

    vi.setSystemTime(Date.now() + 80 * HOUR);
    allFail();

    // Must reject with the UPSTREAM error, proving it tried and then refused
    // the too-old list — not the fast-fail, and not a TypeError.
    await expect(getChannelLocationsCached()).rejects.toThrow(/Too Many/);
    expect(reslabMock.getAllLocations).toHaveBeenCalled();
  });

  it("a successful rebuild clears the degraded state", async () => {
    healthy();
    await getChannelLocationsCached();

    vi.setSystemTime(Date.now() + 25 * HOUR);
    allFail();
    expect((await getChannelLocationsCached()).stale).toBe(true);

    vi.setSystemTime(Date.now() + 11 * MINUTE);
    healthy();
    const recovered = await getChannelLocationsCached();

    expect(recovered.stale).toBe(false);
    expect(recovered.incomplete).toBe(false);
  });
});

describe("location list cache — ResLab succeeding badly (HTTP 200, bad data)", () => {
  // Cases a rejection-counting build cannot see. Caching one as authoritative
  // would blank or thin search for a full 24h and CDN-cache it.

  it("an empty 200 with a collapsed paginator is refused outright", async () => {
    reslabMock.getAllLocations.mockResolvedValue({
      data: [],
      last_page: 1,
      current_page: 1,
      per_page: PER_PAGE,
      total: 0,
    });

    await expect(getChannelLocationsCached()).rejects.toThrow(/paginator/i);
  });

  it("an empty sweep with a VALID paginator is rejected by plausibility", async () => {
    // Paginator is internally consistent (4 pages × 2 = 8 rows) but every page
    // comes back empty. Nothing rejects, so only the plausibility check can
    // catch it — caching [] would blank search on this instance for 24h.
    reslabMock.getAllLocations.mockImplementation(async (p: number) =>
      page(p, { rows: [] }),
    );

    const r = await getChannelLocationsCached();

    expect(r.incomplete).toBe(true); // → no-store, never CDN-cached
    expect(captureMock.captureAPIError).toHaveBeenCalled();
  });

  it("an empty 200 does not blank search for the whole TTL", async () => {
    reslabMock.getAllLocations.mockImplementation(async (p: number) =>
      page(p, { rows: [] }),
    );
    await getChannelLocationsCached();

    vi.setSystemTime(Date.now() + 11 * MINUTE);
    healthy();
    const recovered = await getChannelLocationsCached();

    expect(recovered.incomplete).toBe(false);
    expect(recovered.data).toHaveLength(TOTAL_ROWS);
  });

  it("an empty 200 does not overwrite a good cached list", async () => {
    healthy();
    await getChannelLocationsCached();

    vi.setSystemTime(Date.now() + 25 * HOUR);
    reslabMock.getAllLocations.mockResolvedValue({
      data: [],
      last_page: 1,
      current_page: 1,
      per_page: PER_PAGE,
      total: 0,
    });
    const r = await getChannelLocationsCached();

    expect(r.data).toHaveLength(TOTAL_ROWS); // still the good list
    expect(r.stale).toBe(true);
  });

  it("a truncated paginator (last_page:1 but total needs 4 pages) is refused", async () => {
    // Individually well-formed, internally inconsistent: last_page can't cover
    // ceil(total / per_page). Without the cross-check we'd sweep one page,
    // count zero failures, and cache 2 of 8 locations as authoritative.
    reslabMock.getAllLocations.mockResolvedValue(
      page(1, { lastPage: 1, total: TOTAL_ROWS }),
    );

    await expect(getChannelLocationsCached()).rejects.toThrow(/paginator/i);
  });

  it("a missing `total` is refused (it gates the plausibility check)", async () => {
    // `expectedRows > 0 &&` silently disables the row-count check when total is
    // absent — so a 2-of-533 list would be cached COMPLETE for 24h and
    // CDN-cached, with no Sentry event.
    reslabMock.getAllLocations.mockResolvedValue({
      data: [loc(1), loc(2)],
      last_page: 1,
      current_page: 1,
      per_page: PER_PAGE,
    });

    await expect(getChannelLocationsCached()).rejects.toThrow(/paginator/i);
  });

  it("a zero `total` alongside real data is refused", async () => {
    reslabMock.getAllLocations.mockResolvedValue({
      data: [loc(1), loc(2)],
      last_page: 1,
      current_page: 1,
      per_page: PER_PAGE,
      total: 0,
    });

    await expect(getChannelLocationsCached()).rejects.toThrow(/paginator/i);
  });

  it("a missing last_page is refused rather than swept as one page", async () => {
    // `2 <= undefined` is false, so the sweep would silently stop at page 1,
    // count zero failures, and cache ~10 of ~533 locations as authoritative.
    reslabMock.getAllLocations.mockResolvedValue({
      data: [loc(1), loc(2)],
      current_page: 1,
      per_page: PER_PAGE,
      total: 533,
    });

    await expect(getChannelLocationsCached()).rejects.toThrow(/paginator/i);
  });

  it("a rejected implausible build does NOT clear the failure state", async () => {
    reslabMock.getAllLocations.mockImplementation(async (p: number) =>
      page(p, { rows: [] }),
    );
    await getChannelLocationsCached();
    reslabMock.getAllLocations.mockClear();

    vi.setSystemTime(Date.now() + MINUTE);
    await expect(getChannelLocationsCached()).rejects.toThrow(/backing off/i);
    expect(reslabMock.getAllLocations).not.toHaveBeenCalled();
  });

  it("a refused paginator also arms the backoff", async () => {
    reslabMock.getAllLocations.mockResolvedValue({
      data: [loc(1)],
      last_page: 1,
      current_page: 1,
      per_page: PER_PAGE,
    });
    await expect(getChannelLocationsCached()).rejects.toThrow(/paginator/i);
    reslabMock.getAllLocations.mockClear();

    vi.setSystemTime(Date.now() + MINUTE);
    await expect(getChannelLocationsCached()).rejects.toThrow(/backing off/i);
    expect(reslabMock.getAllLocations).not.toHaveBeenCalled();
  });
});

describe("location list cache — never downgrade what customers see", () => {
  /** Cache a thin list of `size` locations via a rejected build. */
  async function seedThinList(size: number) {
    const lastPage = 40;
    reslabMock.getAllLocations.mockImplementation(async (p: number) => {
      if (p === 1) {
        return {
          data: Array.from({ length: size }, (_, i) => loc(i + 1)),
          last_page: lastPage,
          current_page: 1,
          per_page: PER_PAGE,
          total: lastPage * PER_PAGE,
        };
      }
      throw new ReslabError(429, "Too Many Requests");
    });
    const r = await getChannelLocationsCached();
    expect(r.incomplete).toBe(true);
    expect(r.data).toHaveLength(size);
  }

  it("never answers 'no parking' while holding a usable thin list", async () => {
    // The severe one: fallback is thin, the rebuild yields nothing without
    // throwing (ResLab 200 + empty data). Returning [] would render the
    // customer-facing "No parking locations found near this airport" while
    // hundreds of usable lots sat in cache one branch away.
    await seedThinList(20);

    vi.setSystemTime(Date.now() + 11 * MINUTE); // past backoff
    reslabMock.getAllLocations.mockResolvedValue({
      data: [],
      last_page: 1,
      current_page: 1,
      per_page: PER_PAGE,
      total: 0,
    });
    const r = await getChannelLocationsCached();

    expect(r.data).toHaveLength(20); // served the thin list, not []
    expect(r.incomplete).toBe(true);
  });

  it("does not ratchet inventory down across successive rejected rebuilds", async () => {
    // 20 lots cached, then a worse sweep assembles 3. Overwriting would walk
    // customers down 20 → 3 → 0 over an outage with no path back.
    await seedThinList(20);

    vi.setSystemTime(Date.now() + 11 * MINUTE);
    await seedThinList(3).catch(() => {});
    const r = await getChannelLocationsCached();

    expect(r.data).toHaveLength(20); // kept the better list
  });

  it("does keep a BETTER thin list when the rebuild improves", async () => {
    await seedThinList(3);

    vi.setSystemTime(Date.now() + 11 * MINUTE);
    await seedThinList(20);
    const r = await getChannelLocationsCached();

    expect(r.data).toHaveLength(20); // upgraded
  });

  it("a thin list still ages out at the 72h ceiling", async () => {
    await seedThinList(20);

    vi.setSystemTime(Date.now() + 80 * HOUR);
    allFail();

    await expect(getChannelLocationsCached()).rejects.toThrow(/Too Many/);
  });

  it("thin→thin replacement inherits the ORIGINAL age (no laundering)", async () => {
    // Without builtAt preservation, each rejected rebuild resets the clock and
    // the 72h ceiling becomes unreachable for the least trustworthy list we
    // hold. Deleting the preservation must fail THIS test.
    await seedThinList(20); // t = 0

    vi.setSystemTime(Date.now() + 40 * HOUR);
    await seedThinList(30); // t = 40h, but must inherit builtAt = 0

    vi.setSystemTime(Date.now() + 33 * HOUR); // t = 73h from the ORIGINAL
    allFail();

    // Inherited age ⇒ past the ceiling ⇒ refuse. If builtAt had been
    // re-stamped at 40h the list would read as 33h old and still be served.
    await expect(getChannelLocationsCached()).rejects.toThrow(/Too Many/);
  });

  it("inheritance is bounded — a fresh build past the ceiling is not stamped dead", async () => {
    // The opposite failure: inheriting an already-expired timestamp forever
    // means brand-new rows are served once and then 503 on every later request.
    await seedThinList(20); // t = 0
    vi.setSystemTime(Date.now() + 80 * HOUR); // ancestor now past the ceiling

    await seedThinList(25); // fresh rows — must NOT inherit the dead stamp
    reslabMock.getAllLocations.mockClear();

    vi.setSystemTime(Date.now() + MINUTE);
    const r = await getChannelLocationsCached();

    expect(r.data).toHaveLength(25); // still served, not refused
    expect(reslabMock.getAllLocations).not.toHaveBeenCalled();
  });

  it("a COMPLETE fallback wins even when the thin rebuild is larger", async () => {
    // Pins the `usable.complete ||` short-circuit specifically. With only the
    // size comparison, a bigger-but-thin list would beat a complete one.
    healthy(); // complete list of TOTAL_ROWS (8)
    await getChannelLocationsCached();

    vi.setSystemTime(Date.now() + 25 * HOUR);
    await seedThinList(50).catch(() => {}); // thin, but much larger
    const r = await getChannelLocationsCached();

    expect(r.data).toHaveLength(TOTAL_ROWS); // complete wins on completeness
    expect(r.stale).toBe(true);
    expect(r.incomplete).toBe(false);
  });
});

describe("location list cache — slow ResLab is not refusing ResLab", () => {
  it("a healthy-but-slow sweep backs off briefly, not for the full window", async () => {
    // At ~3.6s per batch a perfectly healthy 54-page sweep trips the wall-clock
    // budget. Treating that like a refusal would keep search degraded
    // indefinitely, since every retry is equally slow.
    const LAST = 40;
    reslabMock.getAllLocations.mockImplementation(async (p: number) => {
      vi.setSystemTime(Date.now() + 6 * 1000); // 6s per call — slow, never fails
      return page(p, { lastPage: LAST, total: LAST * PER_PAGE });
    });

    const first = await getChannelLocationsCached();
    expect(first.incomplete).toBe(true); // budget tripped

    // The SHORT (60s) window applies, not the 10-minute one.
    vi.setSystemTime(Date.now() + 90 * 1000);
    reslabMock.getAllLocations.mockClear();
    healthy();
    const recovered = await getChannelLocationsCached();

    expect(reslabMock.getAllLocations).toHaveBeenCalled();
    expect(recovered.incomplete).toBe(false);
  });

  it("escalates to the full window once slowness is a REGIME, not a blip", async () => {
    // The short window is only safe for a transient blip. A slow-only build is
    // never `complete`, so it can never satisfy the fresh path — at 60s forever
    // the retry loop is permanent (~41k calls/day/instance, six times the
    // volume that got us rate-limited). After MAX_FAST_TIMEOUT_RETRIES it must
    // fall back to the 10-minute window.
    const LAST = 40;
    const slow = () =>
      reslabMock.getAllLocations.mockImplementation(async (p: number) => {
        vi.setSystemTime(Date.now() + 6 * 1000);
        return page(p, { lastPage: LAST, total: LAST * PER_PAGE });
      });

    slow();
    await getChannelLocationsCached(); // slow failure 1
    vi.setSystemTime(Date.now() + 90 * 1000);
    slow();
    await getChannelLocationsCached(); // 2
    vi.setSystemTime(Date.now() + 90 * 1000);
    slow();
    await getChannelLocationsCached(); // 3 — past the fast-retry allowance

    reslabMock.getAllLocations.mockClear();
    // 90s later the SHORT window would have expired; the full one must not have.
    vi.setSystemTime(Date.now() + 90 * 1000);
    const r = await getChannelLocationsCached();

    expect(reslabMock.getAllLocations).not.toHaveBeenCalled(); // still backing off
    expect(r.incomplete).toBe(true); // served the thin list, no new sweep
  });
});

describe("location list cache — build phase is bounded", () => {
  it("bypasses the backoff during `next build` but only a few times", async () => {
    process.env.NEXT_PHASE = "phase-production-build";
    allFail();

    // ~85 airport pages prerender; an unbounded bypass would sweep for each.
    let attempts = 0;
    for (let i = 0; i < 20; i++) {
      await getChannelLocationsCached().catch(() => {});
      attempts = reslabMock.getAllLocations.mock.calls.length;
    }

    // Bounded by BUILD_PHASE_MAX_SWEEPS (3) + the initial build, not 20.
    expect(attempts).toBeLessThanOrEqual(4);
  });
});

describe("location list cache — single-flight", () => {
  it("concurrent cold callers trigger exactly ONE sweep", async () => {
    healthy();
    const [a, b, c] = await Promise.all([
      getChannelLocationsCached(),
      getChannelLocationsCached(),
      getChannelLocationsCached(),
    ]);

    expect(a.incomplete).toBe(false);
    expect(b.data).toBe(a.data); // identity — shared result, not a re-sweep
    expect(c.data).toBe(a.data);
    expect(reslabMock.getAllLocations).toHaveBeenCalledTimes(PAGES);
  });

  it("concurrent callers during a total failure share ONE sweep and all reject", async () => {
    // The severe regression this guards: "fixing" a perceived unhandled
    // rejection by catching per-caller instead of sharing the promise would
    // restore N-way amplification on exactly the failure path this fix exists
    // to prevent.
    allFail();
    const results = await Promise.allSettled([
      getChannelLocationsCached(),
      getChannelLocationsCached(),
      getChannelLocationsCached(),
    ]);

    expect(results.every((r) => r.status === "rejected")).toBe(true);
    expect(reslabMock.getAllLocations).toHaveBeenCalledTimes(1); // page 1, once
  });
});
