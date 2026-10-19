/**
 * Partner portal bookings list (6b plan D7): live bookings only. Staging and
 * production share one database, so a staging test booking at a partner's
 * lot is a real row here — a lot operator must never see it as a car to expect.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

const { db } = await vi.hoisted(async () => {
  const { FakeSupabase } = await import("@/lib/booking/__tests__/supabase-fake");
  return { db: new FakeSupabase() };
});

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u1", email: "lot@example.com" } } }) },
  }),
  createAdminClient: async () => db,
}));
vi.mock("@/config/partner", () => ({
  getPartnerByUserId: async () => ({ id: "p1", user_id: "u1", reslab_location_id: 42 }),
}));
vi.mock("@/lib/sentry", () => ({ captureAPIError: vi.fn() }));

import { GET } from "../route";

const req = (qs = "") => new NextRequest(`https://x.test/api/partner/bookings${qs}`);

beforeEach(() => {
  db.clearFailures();
  db.tables.bookings = [
    { id: "live", reslab_location_id: 42, livemode: true, status: "confirmed", created_at: "2026-10-01T00:00:00Z", reslab_reservation_number: "RTL1", location_name: "Lot" },
    { id: "pre015", reslab_location_id: 42, livemode: null, status: "confirmed", created_at: "2026-10-02T00:00:00Z", reslab_reservation_number: "RTL2", location_name: "Lot" },
    { id: "staging", reslab_location_id: 42, livemode: false, status: "confirmed", created_at: "2026-10-03T00:00:00Z", reslab_reservation_number: "RTL3", location_name: "Lot" },
    { id: "other-lot", reslab_location_id: 7, livemode: true, status: "confirmed", created_at: "2026-10-04T00:00:00Z", reslab_reservation_number: "RTL4", location_name: "Other" },
  ];
});

const ids = async (qs = "") => {
  const res = await GET(req(qs));
  expect(res.status).toBe(200);
  const body = await res.json();
  return { ids: body.bookings.map((b: { id: string }) => b.id).sort(), total: body.pagination.total };
};

describe("GET /api/partner/bookings — live bookings only", () => {
  it("drops test-mode (staging) rows; keeps live and pre-015 NULL rows; still scoped to the partner's lot", async () => {
    const r = await ids();
    expect(r.ids).toEqual(["live", "pre015"]);
    // The count is over the same filter — the pager never counts a hidden test row.
    expect(r.total).toBe(2);
  });

  it("the filter survives a search (which uses the query's own .or())", async () => {
    expect((await ids("?search=RTL")).ids).toEqual(["live", "pre015"]);
    expect((await ids("?search=RTL3")).ids).toEqual([]);
  });
});
