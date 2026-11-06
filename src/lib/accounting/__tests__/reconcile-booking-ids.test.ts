/**
 * reconcileRevenue's `bookingIds` option: the read is restricted to those ids,
 * chunked into `.in()` lists and paged with `.range()`, so PostgREST's
 * 1,000-row cap (modelled by FakeSupabase.maxRows) can't truncate it. Without
 * the option the read is the single range query the accounting page has always
 * made.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ReconcileOptions } from "../types";

const { db } = await vi.hoisted(async () => {
  const { FakeSupabase } = await import("@/lib/booking/__tests__/supabase-fake");
  return { db: new FakeSupabase() };
});

vi.mock("@/lib/supabase/server", () => ({ createAdminClient: async () => db }));
vi.mock("@/lib/stripe/client", () => ({ stripe: { paymentIntents: { retrieve: vi.fn() } } }));

import { BOOKING_ID_CHUNK, reconcileRevenue } from "../reconcile";

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

  it("returns every row when the id list is far past the 1,000-row cap", async () => {
    // A single `.in()` over 2,500 ids would come back capped at 1,000.
    db.seed("bookings", Array.from({ length: 2500 }, (_, i) => booking(i)));
    const ids = Array.from({ length: 2500 }, (_, i) => `bk-${String(i).padStart(5, "0")}`);
    const result = await reconcileRevenue({ ...OPTS, bookingIds: ids });
    expect(result.bookings).toHaveLength(2500);
    expect(new Set(result.bookings.map((b) => b.id)).size).toBe(2500);
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
