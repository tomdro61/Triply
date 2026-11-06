/**
 * /api/admin/blog-bookings — the net take section. It is computed for blog
 * bookings only, refuses ranges past MAX_NET_RANGE_DAYS, surfaces ResLab fetch
 * errors (and reports them to Sentry), and becomes an error when most blog
 * bookings came back without a figure. A net failure never fails the page.
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
    },
  };
});

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { email: "admin@example.com" } } }) },
  }),
  createAdminClient: async () => db,
}));
vi.mock("@/config/admin", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/config/admin")>();
  return { ...real, isAdminEmail: () => true };
});
vi.mock("@/lib/sentry", () => ({ captureAPIError: h.captureAPIError }));
vi.mock("next/cache", () => ({ unstable_cache: <T,>(fn: () => Promise<T>) => fn }));
vi.mock("@/lib/google/client", () => ({
  GoogleConfigError: class GoogleConfigError extends Error {},
  gscQuery: vi.fn(async (q: { dimensions: string[] }) =>
    q.dimensions[0] === "date"
      ? [{ keys: ["2026-11-02"], clicks: 0, impressions: 0 }]
      : [{ keys: ["https://www.triplypro.com/blog/a"], clicks: 40, impressions: 900 }]
  ),
}));
vi.mock("@/lib/cms", () => ({
  fetchFromCms: vi.fn(async () => ({ docs: [{ slug: "a", title: "A", airportCode: "JFK" }], totalPages: 1 })),
}));
vi.mock("@/lib/accounting/reconcile", () => ({ reconcileRevenue: h.reconcileRevenue }));

import { GET } from "../route";

const req = (qs: string) => new NextRequest(`https://x.test/api/admin/blog-bookings?${qs}`);

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

function reconciled(bookings: ReturnType<typeof detail>[], fetchErrors = 0) {
  return {
    bookings,
    reslab: { fetchErrors: Array.from({ length: fetchErrors }, (_, i) => ({ resNum: `RTL${i}`, err: "ResLab 503" })) },
  };
}

const netStage = () => h.captureAPIError.mock.calls.filter(([, ctx]) => ctx?.stage === "net");

beforeEach(() => {
  db.tables = { pending_bookings: [], bookings: [], cart_claims: [], customers: [] };
  db.log = [];
  db.clearFailures();
  h.captureAPIError.mockReset();
  h.reconcileRevenue.mockReset();
  db.seed("bookings", [
    booking("b1", "/blog/a"),
    booking("b2", "/blog/a"),
    booking("b3", "/blog/a"),
    booking("home", "/"),
  ]);
});

describe("GET /api/admin/blog-bookings net section", () => {
  it("is not computed without net=1", async () => {
    const res = await GET(req("from=2026-10-01&to=2026-10-31"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.net).toBeUndefined();
    expect(h.reconcileRevenue).not.toHaveBeenCalled();
  });

  it("asks the reconciler for blog-touched bookings only", async () => {
    h.reconcileRevenue.mockResolvedValue(reconciled([detail("b1", 10), detail("b2", 12), detail("b3", 8)]));
    const body = await (await GET(req("from=2026-10-01&to=2026-10-31&net=1"))).json();
    expect(h.reconcileRevenue).toHaveBeenCalledTimes(1);
    expect([...h.reconcileRevenue.mock.calls[0][0].bookingIds].sort()).toEqual(["b1", "b2", "b3"]);
    expect(body.net).toEqual({ ok: true, data: { bookings: 3, known: 3, fetchErrors: 0 } });
    expect(body.report.totals.net).toEqual({ blogNet: 30, blogNetKnown: 3, blogNetUnknown: 0 });
    expect(netStage()).toHaveLength(0);
  });

  it("refuses a range past 92 days as a section error, without calling ResLab or Sentry", async () => {
    const res = await GET(req("from=2026-07-01&to=2026-10-31&net=1"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.net.ok).toBe(false);
    expect(body.net.error).toMatch(/92 days/);
    expect(body.report.totals.net).toBeNull();
    expect(h.reconcileRevenue).not.toHaveBeenCalled();
    expect(netStage()).toHaveLength(0);
  });

  it("surfaces ResLab fetch errors and reports them, keeping the figures it has", async () => {
    h.reconcileRevenue.mockResolvedValue(reconciled([detail("b1", 10), detail("b2", 12), detail("b3", null)], 1));
    const body = await (await GET(req("from=2026-10-01&to=2026-10-31&net=1"))).json();
    expect(body.net).toEqual({ ok: true, data: { bookings: 3, known: 2, fetchErrors: 1 } });
    expect(body.report.totals.net).toEqual({ blogNet: 22, blogNetKnown: 2, blogNetUnknown: 1 });
    expect(netStage()).toHaveLength(1);
  });

  it("is an error, not partial figures, when most blog bookings have no figure", async () => {
    h.reconcileRevenue.mockResolvedValue(reconciled([detail("b1", 10), detail("b2", null), detail("b3", null)], 2));
    const res = await GET(req("from=2026-10-01&to=2026-10-31&net=1"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.net.ok).toBe(false);
    expect(body.net.error).toMatch(/1 of 3/);
    expect(body.report.totals.net).toBeNull();
    // One report for the fetch errors, one for the section going to error.
    expect(netStage()).toHaveLength(2);
  });

  it("a reconciler failure is a section error and Sentry, never a failed page", async () => {
    h.reconcileRevenue.mockRejectedValue(new Error("ResLab auth 401"));
    const res = await GET(req("from=2026-10-01&to=2026-10-31&net=1"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.net).toEqual({ ok: false, error: "ResLab auth 401" });
    expect(body.report.totals.anyBlog).toBe(3);
    expect(netStage()).toHaveLength(1);
  });
});
