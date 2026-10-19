/**
 * Admin dashboard stats: which bookings count as real revenue, and what a
 * failed query looks like.
 *
 * The exclusion is the REAL excludeTestBookings (only isAdminEmail is stubbed)
 * run through the fake's PostgREST `.or()` parser, so the null-safety that
 * keeps direct-lot rows (NULL lot id) and pre-015 rows (NULL livemode) in the
 * totals is exercised end to end, not asserted on a mock.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

const { db, sentry } = await vi.hoisted(async () => {
  const { FakeSupabase } = await import("@/lib/booking/__tests__/supabase-fake");
  return {
    db: new FakeSupabase(),
    sentry: { captureAPIError: vi.fn(), captureBookingError: vi.fn() },
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
vi.mock("@/lib/reslab/location-snapshot", () => ({
  isSnapshotEnabled: () => false,
  readSnapshotMeta: vi.fn(),
  SNAPSHOT_MAX_AGE_MS: 1,
  SNAPSHOT_WARN_MS: 1,
}));
vi.mock("@/lib/sentry", () => sentry);

import { GET } from "../route";

const req = () => new NextRequest("https://x.test/api/admin/stats");

function confirmed(id: string, over: Record<string, unknown>) {
  return {
    id,
    status: "confirmed",
    created_at: new Date().toISOString(),
    grand_total: "50.00",
    triply_service_fee: "5.95",
    protection_plan: null,
    protection_plan_price: null,
    protection_plan_wholesale: null,
    channel: null,
    attribution: null,
    airport_code: "JFK",
    promo_code: null,
    discount_amount: "0",
    location_name: "Lot",
    cancellation_reason: null,
    cancelled_by: null,
    ...over,
  };
}

beforeEach(() => {
  db.tables = { pending_bookings: [], bookings: [], cart_claims: [], customers: [], promo_codes: [] };
  db.log = [];
  db.selects = [];
  db.clearFailures();
  sentry.captureAPIError.mockReset();
  sentry.captureBookingError.mockReset();
  db.seed("bookings", [
    // counted
    confirmed("live_reslab", { reslab_location_id: 42, livemode: true, grand_total: "100.00", triply_service_fee: "6.00" }),
    confirmed("direct", { reslab_location_id: null, livemode: true, grand_total: "80.00", triply_service_fee: "5.95", protection_plan: "Plan A", protection_plan_price: "12.99", protection_plan_wholesale: "6.00" }),
    confirmed("pre015", { reslab_location_id: 42, livemode: null, grand_total: "40.00", triply_service_fee: null }),
    // excluded
    confirmed("test_lot", { reslab_location_id: 195, livemode: true, grand_total: "999.00" }),
    confirmed("staging", { reslab_location_id: 42, livemode: false, grand_total: "777.00" }),
  ]);
});

describe("GET /api/admin/stats — test bookings out, direct and pre-015 rows in", () => {
  it("counts the live ResLab, live direct and NULL-livemode rows; drops the test lot and the staging row", async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.bookings).toMatchObject({ total: 3, confirmed: 3, today: 3 });
    // (100 + 6) + (80 + 5.95 + 12.99) + (40 + 0)
    expect(body.revenue.gross.total).toBeCloseTo(244.94, 2);
    expect(body.revenue.triply.total).toBeCloseTo(11.95, 2);
    expect(body.parkGuard.count.total).toBe(1);
    expect(sentry.captureAPIError).not.toHaveBeenCalled();
  });

  it("a failed bookings query is a 503 with an error body — one Sentry event, never a zeroed dashboard", async () => {
    db.failOnce("bookings", "select", "timeout");
    const res = await GET(req());
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toEqual({ error: expect.stringMatching(/database query failed/) });
    expect(body).not.toHaveProperty("revenue");
    expect(body).not.toHaveProperty("bookings");
    expect(sentry.captureAPIError).toHaveBeenCalledTimes(1);
    expect(String(sentry.captureAPIError.mock.calls[0][0].message)).toMatch(/queries failed .*timeout/);
  });
});
