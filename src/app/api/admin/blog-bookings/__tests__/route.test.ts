/**
 * /api/admin/blog-bookings — admin-only; the net take section (computed for
 * blog bookings only, bounded in time, refused past MAX_NET_RANGE_DAYS,
 * cached per id + status set unless partial, recomputed on net=fresh, an
 * error when most blog bookings came back without a figure); and the Search
 * Console / CMS sections (each with its own time budget, Search Console's
 * lag a note rather than an error). A section failure never fails the page.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

const { db, h } = await vi.hoisted(async () => {
  const { FakeSupabase } = await import("@/lib/booking/__tests__/supabase-fake");
  return {
    db: new FakeSupabase(),
    h: {
      captureAPIError: vi.fn(),
      reconcileRevenue: vi.fn(),
      signedIn: true,
      isAdmin: true,
      /** unstable_cache's store (see the next/cache mock). */
      cache: new Map<string, unknown>(),
    },
  };
});

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: h.signedIn ? { email: "admin@example.com" } : null } }) },
  }),
  createAdminClient: async () => db,
}));
vi.mock("@/config/admin", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/config/admin")>();
  return { ...real, isAdminEmail: () => h.isAdmin };
});
vi.mock("@/lib/sentry", () => ({ captureAPIError: h.captureAPIError }));
// A real store keyed like unstable_cache: a returned value is kept (as JSON,
// as Next keeps it), a throw is not.
vi.mock("next/cache", () => ({
  unstable_cache:
    (fn: () => Promise<unknown>, keyParts: readonly string[]) =>
    async () => {
      const key = keyParts.join("|");
      if (h.cache.has(key)) return h.cache.get(key);
      const value = await fn();
      const stored: unknown = JSON.parse(JSON.stringify(value));
      h.cache.set(key, stored);
      return value;
    },
}));
vi.mock("@/lib/google/client", () => ({
  GoogleConfigError: class GoogleConfigError extends Error {},
  gscQuery: vi.fn(async (q: { dimensions: string[] }) =>
    q.dimensions[0] === "date"
      ? [{ keys: ["2026-11-02"], clicks: 0, impressions: 0 }]
      : [
          { keys: ["https://www.triplypro.com/blog/a"], clicks: 40, impressions: 900 },
          // Merged into "a" (see the redirect map mock below).
          { keys: ["https://www.triplypro.com/blog/old-a"], clicks: 10, impressions: 100 },
        ]
  ),
}));
vi.mock("@/lib/cms", () => ({
  fetchFromCms: vi.fn(async () => ({ docs: [{ slug: "a", title: "A", airportCode: "JFK" }], totalPages: 1 })),
}));
vi.mock("@/config/blog-redirects.json", () => ({ default: { "old-a": "a" } }));
vi.mock("@/lib/accounting/reconcile", () => ({
  reconcileRevenue: h.reconcileRevenue,
  RESLAB_SKIPPED_TIME_BUDGET: "skipped: time budget",
}));

import { gscQuery } from "@/lib/google/client";
import { fetchFromCms } from "@/lib/cms";
import { GET } from "../route";

const req = (qs: string) => new NextRequest(`https://x.test/api/admin/blog-bookings?${qs}`);
const OCT = "from=2026-10-01&to=2026-10-31";

function booking(id: string, first: string) {
  return {
    id,
    status: "confirmed",
    created_at: "2026-10-15T15:00:00Z",
    airport_code: "JFK",
    attribution: { v: 1, first: { land: first, at: 1_790_000_000 } },
    reslab_location_id: 42,
    livemode: true,
  };
}

function detail(id: string, triplyTotal: number | null) {
  return { id, status: "confirmed", triply_total: triplyTotal, reslab_channel_fee: 0, reslab_cancelled: false };
}

function reconciled(bookings: ReturnType<typeof detail>[], fetchErrors: Array<{ resNum: string; err: string }> = []) {
  return { bookings, reslab: { fetchErrors } };
}
const failed = (n: number) => Array.from({ length: n }, (_, i) => ({ resNum: `RTL${i}`, err: "ResLab 503" }));

const stageCalls = (stage: string) => h.captureAPIError.mock.calls.filter(([, ctx]) => ctx?.stage === stage);

beforeEach(() => {
  db.tables = { pending_bookings: [], bookings: [], cart_claims: [], customers: [] };
  db.log = [];
  db.clearFailures();
  h.captureAPIError.mockReset();
  h.reconcileRevenue.mockReset();
  h.signedIn = true;
  h.isAdmin = true;
  h.cache.clear();
  db.seed("bookings", [
    booking("b1", "/blog/a"),
    booking("b2", "/blog/a"),
    booking("b3", "/blog/a"),
    booking("home", "/"),
  ]);
});

describe("GET /api/admin/blog-bookings auth", () => {
  it("is 401 without a signed-in user, before any read", async () => {
    h.signedIn = false;
    const res = await GET(req(OCT));
    expect(res.status).toBe(401);
    expect(db.log).toHaveLength(0);
  });

  it("is 403 for a signed-in user who isn't an admin, before any read", async () => {
    h.isAdmin = false;
    const res = await GET(req(OCT));
    expect(res.status).toBe(403);
    expect(db.log).toHaveLength(0);
  });
});

describe("GET /api/admin/blog-bookings net section", () => {
  it("is not computed without net=1", async () => {
    const res = await GET(req(OCT));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.net).toBeUndefined();
    expect(h.reconcileRevenue).not.toHaveBeenCalled();
  });

  it("asks the reconciler for blog-touched bookings only, with a timeout and a deadline", async () => {
    h.reconcileRevenue.mockResolvedValue(reconciled([detail("b1", 10), detail("b2", 12), detail("b3", 8)]));
    const before = Date.now();
    const body = await (await GET(req(`${OCT}&net=1`))).json();
    const after = Date.now();
    expect(h.reconcileRevenue).toHaveBeenCalledTimes(1);
    const opts = h.reconcileRevenue.mock.calls[0][0];
    expect([...opts.bookingIds].sort()).toEqual(["b1", "b2", "b3"]);
    // NET_FETCH_TIMEOUT_MS and NET_DEADLINE_MS (40 s from the request's start).
    expect(opts.fetchTimeoutMs).toBe(8_000);
    expect(opts.deadline).toBeGreaterThanOrEqual(before + 40_000);
    expect(opts.deadline).toBeLessThanOrEqual(after + 40_000);
    expect(body.net).toEqual({
      ok: true,
      data: { bookings: 3, known: 3, fetchErrors: 0, skipped: 0, computedAt: expect.any(String) },
    });
    expect(Number.isNaN(Date.parse(body.net.data.computedAt))).toBe(false);
    expect(body.report.totals.net).toEqual({ blogNet: 30, blogNetKnown: 3, blogNetUnknown: 0 });
    expect(stageCalls("net")).toHaveLength(0);
  });

  it("refuses a range past 92 days as a section error, without calling ResLab or Sentry", async () => {
    const res = await GET(req("from=2026-07-01&to=2026-10-31&net=1"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.net.ok).toBe(false);
    expect(body.net.error).toMatch(/92 days/);
    expect(body.report.totals.net).toBeNull();
    expect(h.reconcileRevenue).not.toHaveBeenCalled();
    expect(stageCalls("net")).toHaveLength(0);
  });

  it("surfaces ResLab fetch errors and reports them with a sample, keeping the figures it has", async () => {
    h.reconcileRevenue.mockResolvedValue(reconciled([detail("b1", 10), detail("b2", 12), detail("b3", null)], failed(1)));
    const body = await (await GET(req(`${OCT}&net=1`))).json();
    expect(body.net).toEqual({
      ok: true,
      data: { bookings: 3, known: 2, fetchErrors: 1, skipped: 0, computedAt: expect.any(String) },
    });
    expect(body.report.totals.net).toEqual({ blogNet: 22, blogNetKnown: 2, blogNetUnknown: 1 });
    const calls = stageCalls("net");
    expect(calls).toHaveLength(1);
    // A fixed message (so events group), the counts and a sample in `extra`.
    expect(calls[0][0].message).toBe("admin blog-bookings: net take had ResLab fetch errors");
    expect(calls[0][1].extra).toEqual({
      bookings: 3,
      known: 2,
      fetchErrors: 1,
      skipped: 0,
      sample: [{ reservation: "RTL0", error: "ResLab 503" }],
    });
  });

  it("sends at most 20 failed reads to Sentry", async () => {
    h.reconcileRevenue.mockResolvedValue(reconciled([detail("b1", 10), detail("b2", 12), detail("b3", 8)], failed(25)));
    await GET(req(`${OCT}&net=1`));
    const extra = stageCalls("net")[0][1].extra;
    expect(extra.fetchErrors).toBe(25);
    expect(extra.sample).toHaveLength(20);
  });

  it("is an error, not partial figures, when most blog bookings have no figure", async () => {
    h.reconcileRevenue.mockResolvedValue(reconciled([detail("b1", 10), detail("b2", null), detail("b3", null)], failed(2)));
    const res = await GET(req(`${OCT}&net=1`));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.net.ok).toBe(false);
    expect(body.net.error).toBe("net take has a figure for only 1 of 3 blog bookings: 2 ResLab reads failed");
    expect(body.report.totals.net).toBeNull();
    // One report for the fetch errors, one for the section going to error.
    expect(stageCalls("net")).toHaveLength(2);
  });

  it("the shortfall error doesn't blame ResLab when no read failed", async () => {
    // Disputed rows: the reconciler has no figure for them by design.
    h.reconcileRevenue.mockResolvedValue(
      reconciled([detail("b1", 10), { ...detail("b2", 5), status: "disputed" }, { ...detail("b3", 5), status: "disputed" }])
    );
    const body = await (await GET(req(`${OCT}&net=1`))).json();
    expect(body.net.ok).toBe(false);
    expect(body.net.error).toMatch(/only 1 of 3/);
    expect(body.net.error).not.toMatch(/ResLab/);
  });

  it("a reconciler failure is a section error and Sentry (the original error), never a failed page", async () => {
    const err = new Error("ResLab auth 401");
    h.reconcileRevenue.mockRejectedValue(err);
    const res = await GET(req(`${OCT}&net=1`));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.net).toEqual({ ok: false, error: "ResLab auth 401" });
    expect(body.report.totals.anyBlog).toBe(3);
    const calls = stageCalls("net");
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe(err);
  });
});

describe("GET /api/admin/blog-bookings net cache", () => {
  const clean = () => reconciled([detail("b1", 10), detail("b2", 12), detail("b3", 8)]);

  it("caches a complete result, keeping its original computedAt", async () => {
    h.reconcileRevenue.mockResolvedValue(clean());
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-11-06T15:00:00Z"));
      const first = await (await GET(req(`${OCT}&net=1`))).json();
      vi.setSystemTime(new Date("2026-11-06T16:00:00Z"));
      const second = await (await GET(req(`${OCT}&net=1`))).json();
      expect(h.reconcileRevenue).toHaveBeenCalledTimes(1);
      expect(first.net.data.computedAt).toBe("2026-11-06T15:00:00.000Z");
      // An hour later, the cached figure still says when it was computed.
      expect(second.net.data.computedAt).toBe("2026-11-06T15:00:00.000Z");
      expect(second.report.totals.net).toEqual(first.report.totals.net);
    } finally {
      vi.useRealTimers();
    }
  });

  it("recomputes when a blog booking's status changes (the key holds id AND status)", async () => {
    h.reconcileRevenue.mockResolvedValue(clean());
    await GET(req(`${OCT}&net=1`));
    const b1 = db.tables.bookings.find((r) => r.id === "b1");
    if (!b1) throw new Error("seed missing b1");
    b1.status = "disputed";
    await GET(req(`${OCT}&net=1`));
    expect(h.reconcileRevenue).toHaveBeenCalledTimes(2);
  });

  it("net=fresh recomputes instead of reading the cache", async () => {
    h.reconcileRevenue.mockResolvedValue(clean());
    await GET(req(`${OCT}&net=1`));
    const body = await (await GET(req(`${OCT}&net=fresh`))).json();
    expect(h.reconcileRevenue).toHaveBeenCalledTimes(2);
    expect(body.net.ok).toBe(true);
  });

  it("never caches a result with reads skipped for time, and says how many were skipped", async () => {
    h.reconcileRevenue.mockResolvedValue(
      reconciled([detail("b1", 10), detail("b2", 12), detail("b3", null)], [{ resNum: "RTL3", err: "skipped: time budget" }])
    );
    const body = await (await GET(req(`${OCT}&net=1`))).json();
    expect(body.net.data).toMatchObject({ known: 2, fetchErrors: 1, skipped: 1 });
    await GET(req(`${OCT}&net=1`));
    expect(h.reconcileRevenue).toHaveBeenCalledTimes(2);
  });
});

describe("GET /api/admin/blog-bookings Search Console and CMS sections", () => {
  it("counts a merged post's old URL under its survivor", async () => {
    const body = await (await GET(req(OCT))).json();
    expect(body.report.articles.find((a: { slug: string }) => a.slug === "a")?.gscClicks).toBe(50);
    expect(body.report.articles.find((a: { slug: string }) => a.slug === "old-a")).toBeUndefined();
    expect(body.report.airports.find((r: { airport: string }) => r.airport === "JFK")?.gscClicks).toBe(50);
  });

  it("a range newer than Search Console's last day is a note, not an error, and not reported", async () => {
    // The gscQuery mock's last day is Nov 2.
    const res = await GET(req("from=2026-11-03&to=2026-11-04"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.gsc).toEqual({ ok: false, note: true, error: expect.stringMatching(/no data for this range yet/) });
    expect(stageCalls("gsc")).toHaveLength(0);
  });

  it("a Search Console failure reports the original error object", async () => {
    const err = new Error("Search Console 500");
    vi.mocked(gscQuery).mockRejectedValueOnce(err);
    const body = await (await GET(req(OCT))).json();
    expect(body.gsc).toEqual({ ok: false, error: "Search Console 500" });
    expect(stageCalls("gsc")[0][0]).toBe(err);
  });

  it("a CMS that doesn't answer in its budget fails its own section, not the page", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      vi.mocked(fetchFromCms).mockImplementationOnce(() => new Promise(() => {}));
      const pending = GET(req(OCT));
      await vi.advanceTimersByTimeAsync(30_000); // past CMS_BUDGET_MS (25 s)
      const res = await pending;
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.cms).toEqual({ ok: false, error: "CMS took longer than 25 s" });
      expect(body.gsc.ok).toBe(true);
      expect(body.report.totals.anyBlog).toBe(3);
      // No CMS airport tags: airport clicks are unavailable, not 0.
      expect(body.report.airports.find((r: { airport: string }) => r.airport === "JFK")?.gscClicks).toBeNull();
      const calls = stageCalls("cms");
      expect(calls).toHaveLength(1);
      expect(calls[0][0].message).toBe("CMS took longer than 25 s");
    } finally {
      vi.useRealTimers();
    }
  });
});
