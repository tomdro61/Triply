/**
 * Admin bookings list: the staff cancellation note (migration 032) lives in its
 * own service-role-only table and is attached to each row as `cancellation_note`
 * by a SEPARATE best-effort lookup. A failure of that lookup must only lose the
 * notes — never the bookings list itself.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

const { db, sentry } = await vi.hoisted(async () => {
  const { FakeSupabase } = await import("@/lib/booking/__tests__/supabase-fake");
  return { db: new FakeSupabase(), sentry: { captureAPIError: vi.fn() } };
});

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { email: "admin@example.com" } } }) },
  }),
  createAdminClient: async () => db,
}));
vi.mock("@/config/admin", () => ({ isAdminEmail: () => true }));
vi.mock("@/lib/sentry", () => sentry);

import { GET } from "../route";

const req = (qs = "") => new NextRequest(`https://x.test/api/admin/bookings${qs}`);

beforeEach(() => {
  db.clearFailures();
  db.log = [];
  sentry.captureAPIError.mockReset();
  db.tables.customers = [{ id: "c1", email: "a@b.c", first_name: "A", last_name: "B", phone: null }];
  db.tables.bookings = [
    { id: "b1", customer_id: "c1", status: "refunded", created_at: "2026-09-01T00:00:00Z", cancelled_by: "admin" },
    { id: "b2", customer_id: "c1", status: "confirmed", created_at: "2026-09-02T00:00:00Z", cancelled_by: null },
  ];
  db.tables.booking_cancellation_notes = [{ booking_id: "b1", note: "gate closed at 3am" }];
});

describe("GET /api/admin/bookings — cancellation notes", () => {
  it("attaches the note to its booking and null to the rest; other columns untouched", async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    const { bookings } = await res.json();
    const byId = Object.fromEntries(bookings.map((b: { id: string }) => [b.id, b]));
    expect(byId.b1).toMatchObject({ status: "refunded", cancelled_by: "admin", cancellation_note: "gate closed at 3am" });
    expect(byId.b2).toMatchObject({ status: "confirmed", cancellation_note: null });
  });

  it("a failed notes lookup (e.g. 032 not applied) still returns every booking, notes null, one Sentry event", async () => {
    db.failOnce("booking_cancellation_notes", "select", 'relation "booking_cancellation_notes" does not exist', "42P01");
    const res = await GET(req());
    expect(res.status).toBe(200);
    const { bookings } = await res.json();
    expect(bookings).toHaveLength(2);
    for (const b of bookings) expect(b.cancellation_note).toBeNull();
    expect(sentry.captureAPIError).toHaveBeenCalledTimes(1);
    expect(String(sentry.captureAPIError.mock.calls[0][0].message)).toMatch(/cancellation notes fetch failed/);
  });

  it("an empty page never queries the notes table", async () => {
    db.tables.bookings = [];
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect((await res.json()).bookings).toEqual([]);
    expect(db.log.filter((l) => l.table === "booking_cancellation_notes")).toEqual([]);
  });

  it("a bookings query failure is still a 500 (unchanged) and the notes table is never consulted", async () => {
    db.failOnce("bookings", "select", "boom");
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect(db.log.filter((l) => l.table === "booking_cancellation_notes")).toEqual([]);
  });
});
