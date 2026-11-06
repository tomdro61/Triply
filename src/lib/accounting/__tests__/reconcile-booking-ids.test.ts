/**
 * reconcileRevenue's `bookingIds` option: the read is restricted to those ids,
 * chunked into `.in()` lists and paged with `.range()`, so PostgREST's
 * 1,000-row cap (modelled by FakeSupabase.maxRows) can't truncate it. Without
 * the option the read is the single range query the accounting page has always
 * made.
 *
 * And the opt-in time bounds (`fetchTimeoutMs`, `deadline`) /admin/blog-bookings
 * passes: without them — the accounting page's call — no request carries a
 * signal and no read is ever skipped.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ReconcileOptions } from "../types";

const { db } = await vi.hoisted(async () => {
  const { FakeSupabase } = await import("@/lib/booking/__tests__/supabase-fake");
  return { db: new FakeSupabase() };
});

vi.mock("@/lib/supabase/server", () => ({ createAdminClient: async () => db }));
vi.mock("@/lib/stripe/client", () => ({ stripe: { paymentIntents: { retrieve: vi.fn() } } }));

import { BOOKING_ID_CHUNK, RESLAB_SKIPPED_TIME_BUDGET, reconcileRevenue } from "../reconcile";

const OPTS: ReconcileOptions = {
  from: "2026-10-01",
  to: "2026-10-31",
  by: "created",
  invoiceAmount: 0,
  includeReslab: false,
  includeStripe: false,
};

function booking(i: number, over: Record<string, unknown> = {}) {
  const day = String((i % 28) + 1).padStart(2, "0");
  return {
    id: `bk-${String(i).padStart(5, "0")}`,
    reslab_reservation_number: `RTL${i}`,
    status: "confirmed",
    created_at: `2026-10-${day}T12:00:00Z`,
    check_in: "2026-11-01 10:00:00",
    check_out: "2026-11-05 10:00:00",
    grand_total: 100,
    subtotal: 80,
    due_at_location: 0,
    triply_service_fee: 6,
    service_fee_refunded: false,
    protection_plan: null,
    protection_plan_price: 0,
    protection_plan_wholesale: null,
    pg_identifier: null,
    stripe_payment_intent_id: null,
    reslab_location_id: 42,
    location_name: "Lot",
    airport_code: "JFK",
    inventory_source: "reslab",
    direct_lot_id: null,
    livemode: true,
    discount_amount: 0,
    customers: { email: "a@b.com" },
    ...over,
  };
}

const bookingSelects = () => db.log.filter((l) => l.table === "bookings" && l.op === "select").length;

beforeEach(() => {
  db.maxRows = 1000;
  db.log = [];
  db.selects = [];
  db.clearFailures();
  db.tables = { pending_bookings: [], bookings: [], cart_claims: [], customers: [] };
});

describe("reconcileRevenue bookingIds", () => {
  it("reads only the given ids, across several chunks", async () => {
    db.seed("bookings", Array.from({ length: 900 }, (_, i) => booking(i)));
    const ids = Array.from({ length: 450 }, (_, i) => `bk-${String(i * 2).padStart(5, "0")}`);
    const result = await reconcileRevenue({ ...OPTS, bookingIds: ids });
    expect(result.bookings.map((b) => b.id).sort()).toEqual([...ids].sort());
    expect(bookingSelects()).toBe(Math.ceil(ids.length / BOOKING_ID_CHUNK));
  });

  it("pages a chunk whose matches pass the 1,000-row cap", async () => {
    // Real ids are unique, so a 200-id chunk can't fill a page and no
    // unique-id test can tell a paged read from an unpaged one. The fake has
    // no primary key: six rows per id give ONE chunk 1,200 matches, which
    // comes back whole only if the read pages past the cap.
    const ids = Array.from({ length: BOOKING_ID_CHUNK }, (_, i) => `bk-${String(i).padStart(5, "0")}`);
    db.seed(
      "bookings",
      ids.flatMap((_, i) => Array.from({ length: 6 }, () => booking(i)))
    );
    const result = await reconcileRevenue({ ...OPTS, bookingIds: ids });
    expect(result.bookings).toHaveLength(1200);
    expect(bookingSelects()).toBe(2); // one chunk, two pages
  });

  it("keeps the date filter, de-duplicates ids, and returns rows in date order", async () => {
    db.seed("bookings", [
      booking(1, { created_at: "2026-10-20T12:00:00Z" }),
      booking(2, { created_at: "2026-10-05T12:00:00Z" }),
      booking(3, { created_at: "2026-09-15T12:00:00Z" }), // outside from/to
    ]);
    const result = await reconcileRevenue({ ...OPTS, bookingIds: ["bk-00001", "bk-00002", "bk-00003", "bk-00001"] });
    expect(result.bookings.map((b) => b.id)).toEqual(["bk-00002", "bk-00001"]);
  });

  it("an empty id list reads nothing", async () => {
    db.seed("bookings", [booking(1)]);
    const result = await reconcileRevenue({ ...OPTS, bookingIds: [] });
    expect(result.bookings).toHaveLength(0);
    expect(bookingSelects()).toBe(0);
  });

  it("without bookingIds, reads the whole range in one query (accounting page unchanged)", async () => {
    db.maxRows = null;
    db.seed("bookings", Array.from({ length: 30 }, (_, i) => booking(i)));
    const result = await reconcileRevenue(OPTS);
    expect(result.bookings).toHaveLength(30);
    expect(bookingSelects()).toBe(1);
  });
});

describe("reconcileRevenue time bounds (fetchTimeoutMs / deadline, opt-in)", () => {
  const HOUR = 3_600_000;
  // A clock the ResLab stub moves forward one hour per reservation read, so a
  // read that starts after another has finished sees a later Date.now().
  const clock = { now: Date.UTC(2026, 10, 6, 12) };

  /** ResLab answers every request; returns what each request carried. */
  function stubReslab() {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        if (url.endsWith("/authenticate")) return new Response(JSON.stringify({ token: "t" }));
        clock.now += HOUR;
        return new Response(
          JSON.stringify({ cancelled: 0, history: [{ location_total: 80, channel_total: 12, grand_total: 100, subtotal: 80 }] })
        );
      })
    );
    return calls;
  }
  const reservationReads = (calls: ReturnType<typeof stubReslab>) => calls.filter((c) => c.url.includes("/reservations/"));

  /** How many `.abortSignal()` calls the bookings queries made (the fake ignores the signal itself). */
  function countAbortSignals(): () => number {
    let n = 0;
    const from = db.from.bind(db);
    vi.spyOn(db, "from").mockImplementation((table: string) => {
      const q = from(table);
      const abortSignal = q.abortSignal.bind(q);
      q.abortSignal = (signal: AbortSignal) => {
        n++;
        return abortSignal(signal);
      };
      return q;
    });
    return () => n;
  }

  beforeEach(() => {
    clock.now = Date.UTC(2026, 10, 6, 12);
    vi.spyOn(Date, "now").mockImplementation(() => clock.now);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("the accounting-shaped call sends no abort signal and has no deadline", async () => {
    db.maxRows = null;
    db.seed("bookings", Array.from({ length: 8 }, (_, i) => booking(i)));
    const calls = stubReslab();
    const aborts = countAbortSignals();
    // Exactly what /api/admin/accounting passes: no bookingIds, no bounds.
    const result = await reconcileRevenue({ ...OPTS, includeReslab: true });
    // Reads 6–8 start hours after the run began (the clock moves an hour per
    // read): any default deadline would have skipped them.
    expect(reservationReads(calls)).toHaveLength(8);
    expect(result.reslab.fetchErrors).toEqual([]);
    expect(calls.every((c) => c.init !== undefined && !("signal" in c.init))).toBe(true);
    expect(aborts()).toBe(0);
  });

  it("fetchTimeoutMs puts a timeout signal on every ResLab request and every by-id page", async () => {
    db.seed("bookings", Array.from({ length: 3 }, (_, i) => booking(i)));
    const calls = stubReslab();
    const aborts = countAbortSignals();
    await reconcileRevenue({ ...OPTS, includeReslab: true, bookingIds: ["bk-00000", "bk-00001", "bk-00002"], fetchTimeoutMs: 8_000 });
    expect(calls).toHaveLength(4); // auth + 3 reads
    expect(calls.every((c) => c.init?.signal instanceof AbortSignal)).toBe(true);
    expect(aborts()).toBe(1); // one chunk, one page
  });

  it("past the deadline, no request is made (not even the login) and every row is a fetch error", async () => {
    db.seed("bookings", Array.from({ length: 3 }, (_, i) => booking(i)));
    const calls = stubReslab();
    const result = await reconcileRevenue({
      ...OPTS,
      includeReslab: true,
      bookingIds: ["bk-00000", "bk-00001", "bk-00002"],
      deadline: clock.now - 1,
    });
    expect(calls).toHaveLength(0);
    expect(result.reslab.fetchErrors.map((e) => e.err)).toEqual([
      RESLAB_SKIPPED_TIME_BUDGET,
      RESLAB_SKIPPED_TIME_BUDGET,
      RESLAB_SKIPPED_TIME_BUDGET,
    ]);
    expect(result.bookings.map((b) => b.triply_total)).toEqual([null, null, null]);
    expect(result.reslab.dataIncomplete).toBe(true);
  });

  it("a deadline mid-run skips only the reads that hadn't started", async () => {
    db.seed("bookings", Array.from({ length: 3 }, (_, i) => booking(i)));
    const calls = stubReslab();
    const result = await reconcileRevenue({
      ...OPTS,
      includeReslab: true,
      bookingIds: ["bk-00000", "bk-00001", "bk-00002"],
      reslabConcurrency: 1,
      // Reads start at +0 h and +1 h; the third would start at +2 h.
      deadline: clock.now + 1.5 * HOUR,
    });
    expect(reservationReads(calls)).toHaveLength(2);
    expect(result.reslab.fetchErrors).toEqual([{ resNum: "RTL2", err: RESLAB_SKIPPED_TIME_BUDGET }]);
  });
});
