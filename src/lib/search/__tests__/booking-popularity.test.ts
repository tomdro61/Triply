import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const captureAPIError = vi.fn();
vi.mock("@/lib/sentry", () => ({ captureAPIError: (...a: unknown[]) => captureAPIError(...a) }));

// A chainable PostgREST fake. Every builder method records itself and returns
// the builder; the terminal abortSignal() answers from a per-table queue — or,
// when `hang` is set, only settles (as postgrest-js does, with an error) once
// the signal aborts.
type Answer = { data: unknown; error: { code?: string; message: string } | null };
let queues: Record<string, Answer[]> = {};
let calls: Array<{ table: string; ops: string[]; range?: [number, number]; signal?: AbortSignal }> = [];
let hang = false;
function builder(table: string) {
  const call: (typeof calls)[number] = { table, ops: [] };
  calls.push(call);
  const b: Record<string, unknown> = {};
  for (const m of ["select", "eq", "not", "gte", "order", "in"]) {
    b[m] = (...args: unknown[]) => {
      call.ops.push(`${m}:${args.map((a) => (Array.isArray(a) ? a.join("|") : String(a))).join(",")}`);
      return b;
    };
  }
  b.range = (from: number, to: number) => {
    call.range = [from, to];
    return b;
  };
  b.abortSignal = (signal: AbortSignal) => {
    call.signal = signal;
    if (hang) {
      return new Promise<Answer>((resolve) =>
        signal.addEventListener("abort", () => resolve({ data: null, error: { message: "AbortError: aborted" } }))
      );
    }
    return Promise.resolve(queues[table]?.shift() ?? { data: [], error: null });
  };
  return b;
}
const createAdminClient = vi.fn(async () => ({ from: (t: string) => builder(t) }));
vi.mock("@/lib/supabase/server", () => ({ createAdminClient: () => createAdminClient() }));

import {
  getLotBookingCounts,
  isRecommendedRankingEnabled,
  __resetLotBookingCountsForTests,
} from "../booking-popularity";

const env = (e: Record<string, string> = {}): NodeJS.ProcessEnv => ({ NODE_ENV: "test", ...e });
const row = (reslab_location_id: number | null, livemode: boolean | null = true, pi: string | null = null) => ({
  reslab_location_id,
  livemode,
  stripe_payment_intent_id: pi,
});
const bookings = (...pages: Array<ReturnType<typeof row>[]>) => {
  queues.bookings = pages.map((data) => ({ data, error: null }));
};

beforeEach(() => {
  __resetLotBookingCountsForTests();
  captureAPIError.mockClear();
  createAdminClient.mockClear();
  queues = {};
  calls = [];
  hang = false;
});
afterEach(() => {
  vi.useRealTimers();
});

describe("getLotBookingCounts", () => {
  it("counts kept, live, non-test bookings per lot from `bookings` with the right filters", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-08T12:00:00Z"));
    bookings([row(275), row(275), row(561), row(195), row(null)]);
    const r = await getLotBookingCounts(env());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect([...r.counts.entries()].sort()).toEqual([[275, 2], [561, 1]]); // 195 = test lot
    expect(calls[0].table).toBe("bookings");
    expect(calls[0].ops).toEqual(
      expect.arrayContaining([
        "eq:status,confirmed",
        "not:reslab_location_id,is,null",
        "gte:created_at,2026-07-10T12:00:00.000Z", // exactly 90 days back
        "order:id",
      ])
    );
  });

  it("a staging booking is excluded whether bookings.livemode says so or only its staged payment does", async () => {
    // Since migration 034 fulfilment leaves bookings.livemode NULL; the staged
    // pending_bookings row is authoritative. NULL with no staged row = pre-015 = live.
    bookings([
      row(275, false), // staging, marked on the booking
      row(275, null, "pi_staging"), // staging, only the staged payment knows
      row(275, null, "pi_live"),
      row(275, null, "pi_pre015"), // no staged row → live
      row(561, true),
    ]);
    queues.pending_bookings = [
      { data: [{ stripe_payment_intent_id: "pi_staging", livemode: false }, { stripe_payment_intent_id: "pi_live", livemode: true }], error: null },
    ];
    const r = await getLotBookingCounts(env());
    expect(r.ok && [...r.counts.entries()].sort()).toEqual([[275, 2], [561, 1]]);
    const pending = calls.find((c) => c.table === "pending_bookings");
    expect(pending?.ops).toContain("in:stripe_payment_intent_id,pi_staging|pi_live|pi_pre015");
  });

  it("pages past PostgREST's 1,000-row cap, sharing one deadline signal across pages", async () => {
    bookings(Array(1000).fill(row(275)), [row(561), row(561)]);
    const r = await getLotBookingCounts(env());
    const pages = calls.filter((c) => c.table === "bookings");
    expect(pages.map((c) => c.range)).toEqual([[0, 999], [1000, 1999]]);
    expect(pages[0].signal).toBe(pages[1].signal);
    expect(r.ok && r.counts.get(275)).toBe(1000);
    expect(r.ok && r.counts.get(561)).toBe(2);
  });

  it("more rows than the cap → ok:false, never silently truncated counts", async () => {
    bookings(...Array.from({ length: 21 }, () => Array(1000).fill(row(275))));
    await expect(getLotBookingCounts(env())).resolves.toEqual({ ok: false });
    expect(captureAPIError).toHaveBeenCalledTimes(1);
  });

  it("a hung query is cut off by the 3 s deadline → ok:false", async () => {
    vi.useFakeTimers();
    hang = true;
    const p = getLotBookingCounts(env());
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(p).resolves.toEqual({ ok: false });
  });

  it("zero kept bookings in production is treated as a failed read, not a fact", async () => {
    bookings([]);
    await expect(getLotBookingCounts(env({ VERCEL_ENV: "production" }))).resolves.toEqual({ ok: false });
    expect(captureAPIError).toHaveBeenCalledTimes(1);
  });

  it("caches a success for an hour, then reads again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-08T12:00:00Z"));
    bookings([row(275)], [row(275)]);
    await getLotBookingCounts(env());
    await getLotBookingCounts(env());
    expect(createAdminClient).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date("2026-10-08T13:00:01Z"));
    await getLotBookingCounts(env());
    expect(createAdminClient).toHaveBeenCalledTimes(2);
  });

  it("a failure resolves ok:false, never rejects, is cached ~5 min and reported at most every 10 min", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const fail = { data: null, error: { code: "57014", message: "timeout" } };
    vi.setSystemTime(new Date("2026-10-08T12:00:00Z"));
    queues.bookings = [fail, fail, fail];
    await expect(getLotBookingCounts(env())).resolves.toEqual({ ok: false });
    await expect(getLotBookingCounts(env())).resolves.toEqual({ ok: false }); // cached
    expect(createAdminClient).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date("2026-10-08T12:05:01Z")); // cache expired, report throttled
    await getLotBookingCounts(env());
    expect(createAdminClient).toHaveBeenCalledTimes(2);
    expect(captureAPIError).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date("2026-10-08T12:10:01Z")); // throttle window over
    await getLotBookingCounts(env());
    expect(captureAPIError).toHaveBeenCalledTimes(2);
  });

  it("a thrown client error also resolves ok:false", async () => {
    createAdminClient.mockImplementationOnce(async () => {
      throw new Error("boom");
    });
    await expect(getLotBookingCounts(env())).resolves.toEqual({ ok: false });
  });

  it("concurrent callers share one query", async () => {
    bookings([row(275)]);
    await Promise.all([getLotBookingCounts(env()), getLotBookingCounts(env())]);
    expect(createAdminClient).toHaveBeenCalledTimes(1);
  });
});

describe("isRecommendedRankingEnabled", () => {
  it("on unless switched off; off/false/0/no all count as off", () => {
    expect(isRecommendedRankingEnabled(env())).toBe(true);
    for (const v of ["off", "FALSE", "0", " no "]) {
      expect(isRecommendedRankingEnabled(env({ SEARCH_RECOMMENDED_RANKING: v }))).toBe(false);
    }
  });
});
