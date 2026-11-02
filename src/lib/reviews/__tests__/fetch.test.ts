import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { UnifiedLot } from "@/types/lot";

const captureAPIError = vi.fn();
vi.mock("@/lib/sentry", () => ({ captureAPIError: (...a: unknown[]) => captureAPIError(...a) }));

// A chainable PostgREST fake (the booking-popularity test's): every builder
// method records itself and returns the builder; the terminal abortSignal()
// answers from a per-table queue.
type Answer = { data: unknown; error: { code?: string; message: string; details?: string; hint?: string } | null };
let queues: Record<string, Answer[]> = {};
let calls: Array<{ table: string; ops: string[]; range?: [number, number] }> = [];
function builder(table: string) {
  const call: (typeof calls)[number] = { table, ops: [] };
  calls.push(call);
  const b: Record<string, unknown> = {};
  for (const m of ["select", "eq", "not", "order", "in", "or"]) {
    b[m] = (...args: unknown[]) => {
      call.ops.push(`${m}:${args.map((a) => String(a)).join(",")}`);
      return b;
    };
  }
  b.range = (from: number, to: number) => {
    call.range = [from, to];
    return b;
  };
  b.abortSignal = () => Promise.resolve(queues[table]?.shift() ?? { data: [], error: null });
  return b;
}
const createAdminClient = vi.fn(async () => ({ from: (t: string) => builder(t) }));
vi.mock("@/lib/supabase/server", () => ({ createAdminClient: () => createAdminClient() }));

import { fetchLotReviewSummaries, __resetLotReviewSummariesForTests, __expireLotReviewCacheForTests } from "../summary";

/** Drops the cached result but keeps the report windows, so the next call reloads inside the same throttle window. */
const __resetCacheOnlyForThisTest = () => __expireLotReviewCacheForTests();

function lot(o: Partial<UnifiedLot> = {}): UnifiedLot {
  return {
    id: "reslab-10",
    source: "reslab",
    sourceId: "10",
    reslabLocationId: 10,
    name: "Jet Parking JFK",
    slug: "jet-parking-jfk",
    address: "1 Main St",
    city: "Jamaica",
    state: "NY",
    latitude: 40.6,
    longitude: -73.8,
    amenities: [],
    photos: [],
    availability: "available",
    ...o,
  };
}
let ids = 0;
const row = (o: Record<string, unknown> = {}) => ({
  id: `id-${++ids}`,
  reslab_location_id: 10,
  direct_lot_id: null,
  rating: 4,
  comment: "fine",
  publish_consent: true,
  display_name: "Ana",
  shuttle_wait: null,
  extra_charges: null,
  created_at: "2026-10-20T00:00:00+00:00",
  bookings: { livemode: false },
  ...o,
});
const pages = (...data: unknown[][]) => {
  queues.booking_reviews = data.map((d) => ({ data: d, error: null }));
};
const lots = [lot(), lot({ id: "reslab-11", sourceId: "11", reslabLocationId: 11 }), lot({ id: "direct-42", source: "direct", sourceId: "42", reslabLocationId: undefined })];

const savedKey = process.env.STRIPE_SECRET_KEY;
beforeEach(() => {
  __resetLotReviewSummariesForTests();
  captureAPIError.mockClear();
  createAdminClient.mockClear();
  queues = {};
  calls = [];
  process.env.LOT_REVIEWS_DISPLAY_ENABLED = "true";
  process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
});
afterEach(() => {
  process.env.LOT_REVIEWS_DISPLAY_ENABLED = "false";
  process.env.STRIPE_SECRET_KEY = savedKey;
  vi.useRealTimers();
});

describe("fetchLotReviewSummaries", () => {
  it("flag off: no client, empty map", async () => {
    process.env.LOT_REVIEWS_DISPLAY_ENABLED = "false";
    expect((await fetchLotReviewSummaries(lots, "t")).size).toBe(0);
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("test key: reads livemode = false reviews, ordered by created_at then id, under the 1,000-row page; answers only the asked lots", async () => {
    pages([row(), row({ rating: 5 }), row({ rating: 3 }), row({ reslab_location_id: 99 }), row({ reslab_location_id: null, direct_lot_id: "42", comment: null, publish_consent: false, display_name: null })]);
    const m = await fetchLotReviewSummaries(lots, "/api/search");
    expect(calls).toHaveLength(1);
    expect(calls[0].table).toBe("booking_reviews");
    expect(calls[0].ops).toContain("eq:bookings.livemode,false");
    expect(calls[0].ops.join(" ")).toContain("order:created_at order:id");
    expect(calls[0].range).toEqual([0, 999]);
    expect([...m.keys()].sort()).toEqual(["d:42", "r:10"]);
    expect(m.get("r:10")).toMatchObject({ average: 4, count: 3 });
    expect(m.get("d:42")).toMatchObject({ average: null, count: 1, published: [] });
  });

  it("live key: livemode true OR NULL (the digest's `not … is false`)", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_live_dummy";
    pages([row({ bookings: { livemode: null } })]);
    await fetchLotReviewSummaries(lots, "lot-page");
    expect(calls[0].ops).toContain("not:bookings.livemode,is,false");
    expect(calls[0].ops.some((o) => o.startsWith("eq:bookings.livemode"))).toBe(false);
  });

  it("one read per instance: a second call within the TTL creates no client; the mode is part of the cache key", async () => {
    pages([row()]);
    await fetchLotReviewSummaries(lots, "a");
    await fetchLotReviewSummaries([lot()], "b");
    expect(createAdminClient).toHaveBeenCalledTimes(1);
    process.env.STRIPE_SECRET_KEY = "sk_live_dummy";
    pages([row()]);
    await fetchLotReviewSummaries(lots, "c");
    expect(createAdminClient).toHaveBeenCalledTimes(2);
  });

  it("single-flight: concurrent callers share one read", async () => {
    pages([row()]);
    const [a, b] = await Promise.all([fetchLotReviewSummaries(lots, "a"), fetchLotReviewSummaries([lot()], "b")]);
    expect(createAdminClient).toHaveBeenCalledTimes(1);
    expect(a.get("r:10")).toEqual(b.get("r:10"));
  });

  it("pages until a short page and merges the pages", async () => {
    pages(Array.from({ length: 1000 }, (_, i) => row({ reslab_location_id: 10 + (i % 2) })), [row({ rating: 2 })]);
    const m = await fetchLotReviewSummaries(lots, "t");
    expect(calls.map((c) => c.range)).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
    expect(m.get("r:10")!.count).toBe(501);
    expect(m.get("r:11")!.count).toBe(500);
  });

  it("a row repeated across a page boundary (written between the reads) counts once", async () => {
    const boundary = row({ rating: 5 });
    pages([...Array.from({ length: 999 }, () => row({ reslab_location_id: 11 })), boundary], [boundary, row({ rating: 5 })]);
    const m = await fetchLotReviewSummaries(lots, "t");
    expect(m.get("r:10")).toMatchObject({ count: 2, average: null });
    expect(m.get("r:11")!.count).toBe(999);
  });

  it("more rows than the cap: every rating withheld and reported, nothing partial", async () => {
    pages(...Array.from({ length: 6 }, () => Array.from({ length: 1000 }, () => row())));
    const m = await fetchLotReviewSummaries(lots, "t");
    expect(m.size).toBe(0);
    expect(captureAPIError).toHaveBeenCalledTimes(1);
    expect(captureAPIError.mock.calls[0][0].message).toMatch(/more than 5000 rows/);
  });

  it("a database error: empty map, one report carrying code/details/hint, and the failure is cached", async () => {
    queues.booking_reviews = [{ data: null, error: { code: "57014", message: "canceling statement", details: "timeout", hint: "h" } }];
    expect((await fetchLotReviewSummaries(lots, "/api/search")).size).toBe(0);
    expect(captureAPIError).toHaveBeenCalledTimes(1);
    expect(captureAPIError.mock.calls[0][1]).toMatchObject({ endpoint: "/api/search", stage: "lot-reviews-read", code: "57014", extra: { details: "timeout", hint: "h", mode: "test" } });
    pages([row()]);
    expect((await fetchLotReviewSummaries(lots, "lot-page")).size).toBe(0);
    expect(createAdminClient).toHaveBeenCalledTimes(1);
  });

  it("failures are reported at most once per ten minutes, with the suppressed count", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-02T12:00:00Z"));
    const fail = () => {
      queues.booking_reviews = [{ data: null, error: { message: "boom" } }];
    };
    fail();
    await fetchLotReviewSummaries(lots, "t");
    vi.setSystemTime(new Date("2026-11-02T12:06:00Z")); // failure cache expired, report window not
    fail();
    await fetchLotReviewSummaries(lots, "t");
    expect(createAdminClient).toHaveBeenCalledTimes(2);
    expect(captureAPIError).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date("2026-11-02T12:12:00Z"));
    fail();
    await fetchLotReviewSummaries(lots, "t");
    expect(captureAPIError).toHaveBeenCalledTimes(2);
    expect(captureAPIError.mock.calls[1][1].extra.suppressedSinceLastReport).toBe(1);
  });

  it("the throttle is per stage: a parse failure right after a read failure is still reported", async () => {
    queues.booking_reviews = [{ data: null, error: { message: "boom" } }];
    await fetchLotReviewSummaries(lots, "t");
    __resetCacheOnlyForThisTest();
    pages([row({ rating: 9 })]);
    await fetchLotReviewSummaries(lots, "t");
    expect(captureAPIError.mock.calls.map((c) => c[1].stage)).toEqual(["lot-reviews-read", "lot-reviews-parse"]);
  });

  it("a row with no id fails validation (the dedupe depends on it) and withholds its lot", async () => {
    pages([row({ id: undefined }), row({ reslab_location_id: 11 }), row({ reslab_location_id: 11 }), row({ reslab_location_id: 11 })]);
    const m = await fetchLotReviewSummaries(lots, "t");
    expect(m.has("r:10")).toBe(false);
    expect(m.get("r:11")!.count).toBe(3);
    expect(captureAPIError.mock.calls[0][1]).toMatchObject({ stage: "lot-reviews-parse", extra: { withheldLots: ["r:10"] } });
  });

  it("a row that fails validation withholds ITS lot only, and is reported", async () => {
    pages([row(), row({ rating: 5 }), row({ rating: 5, shuttle_wait: "teleport" }), row({ reslab_location_id: 11 }), row({ reslab_location_id: 11 }), row({ reslab_location_id: 11 })]);
    const m = await fetchLotReviewSummaries(lots, "t");
    expect(m.has("r:10")).toBe(false);
    expect(m.get("r:11")).toMatchObject({ average: 4, count: 3 });
    expect(captureAPIError).toHaveBeenCalledTimes(1);
    expect(captureAPIError.mock.calls[0][1]).toMatchObject({ stage: "lot-reviews-parse", extra: { invalid: 1, withheldLots: ["r:10"] } });
  });

  it("no usable Stripe key: empty map and a config report, no client", async () => {
    process.env.STRIPE_SECRET_KEY = "nonsense";
    expect((await fetchLotReviewSummaries(lots, "t")).size).toBe(0);
    expect(createAdminClient).not.toHaveBeenCalled();
    expect(captureAPIError.mock.calls[0][1]).toMatchObject({ stage: "lot-reviews-config" });
  });
});
