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

describe("GET /api/admin/bookings — search by name, email, confirmation # or lot", () => {
  beforeEach(() => {
    db.tables.customers = [
      { id: "c1", email: "virginia.white@example.com", first_name: "Virginia", last_name: "White", phone: null },
      { id: "c2", email: "dan@example.com", first_name: "Dan", last_name: "Donovan", phone: null },
    ];
    db.tables.bookings = [
      { id: "b1", customer_id: "c1", status: "confirmed", created_at: "2026-10-01T00:00:00Z", reslab_reservation_number: "RTL856901", location_name: "Carvia Parking (LGA)" },
      { id: "b2", customer_id: "c2", status: "confirmed", created_at: "2026-10-02T00:00:00Z", reslab_reservation_number: "RTL852337", location_name: "Embassy Suites EWR" },
    ];
    db.tables.booking_cancellation_notes = [];
  });

  const ids = async (qs: string) => {
    const res = await GET(req(qs));
    expect(res.status).toBe(200);
    const body = await res.json();
    return { ids: body.bookings.map((b: { id: string }) => b.id).sort(), warnings: body.warnings ?? [] };
  };

  it("by email (partial, case-insensitive)", async () => {
    expect((await ids("?search=VIRGINIA.white%40")).ids).toEqual(["b1"]);
  });

  it("by last name", async () => {
    expect((await ids("?search=donovan")).ids).toEqual(["b2"]);
  });

  it("by full name 'First Last'", async () => {
    expect((await ids("?search=Virginia%20White")).ids).toEqual(["b1"]);
  });

  it("by confirmation number and by lot name still work", async () => {
    expect((await ids("?search=RTL8523")).ids).toEqual(["b2"]);
    expect((await ids("?search=carvia")).ids).toEqual(["b1"]);
  });

  it("no match → empty, not everything", async () => {
    expect((await ids("?search=nobody")).ids).toEqual([]);
  });

  it("a term that sanitises to nothing (all symbols) → empty, never the whole table", async () => {
    expect((await ids("?search=%25%25%2C%28")).ids).toEqual([]);
  });

  it("a failed customer lookup still returns booking-level matches, with a warning", async () => {
    db.failOnce("customers", "select", "boom");
    const r = await ids("?search=RTL856901");
    expect(r.ids).toEqual(["b1"]);
    expect(r.warnings).toEqual(["customer_search_unavailable"]);
    expect(sentry.captureAPIError).toHaveBeenCalledTimes(1);
  });

  it("no search → no warnings field noise", async () => {
    expect((await ids("")).warnings).toEqual([]);
  });
});

describe("GET /api/admin/bookings — search edge cases", () => {
  it("a term matching more customers than the cap → results still return, with the truncation notice", async () => {
    db.tables.customers = Array.from({ length: 201 }, (_, i) => ({
      id: `c${i}`, email: `person${i}@gmail.com`, first_name: `P${i}`, last_name: "Gmailer", phone: null,
    }));
    db.tables.bookings = [
      { id: "b1", customer_id: "c0", status: "confirmed", created_at: "2026-10-01T00:00:00Z", reslab_reservation_number: "RTL1", location_name: "Lot" },
    ];
    db.tables.booking_cancellation_notes = [];
    const res = await GET(req("?search=gmail"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.warnings).toEqual(["customer_search_truncated"]);
    expect(body.bookings.map((b: { id: string }) => b.id)).toEqual(["b1"]);
    // Normal admin use: a broad term is a notice on the page, never a Sentry event.
    expect(sentry.captureAPIError).not.toHaveBeenCalled();
  });

  it("the full-name (second) lookup failing degrades to a warning (a two-word name has no other leg to match)", async () => {
    db.tables.customers = [{ id: "c1", email: "v@example.com", first_name: "Virginia", last_name: "White", phone: null }];
    db.tables.bookings = [
      { id: "b1", customer_id: "c1", status: "confirmed", created_at: "2026-10-01T00:00:00Z", reslab_reservation_number: "RTL1", location_name: "Lot" },
    ];
    db.tables.booking_cancellation_notes = [];
    // First customers select succeeds (consumes nothing); make the SECOND fail.
    let calls = 0;
    db.failWhen("customers", "select", () => ++calls === 2, "boom");
    const res = await GET(req("?search=Virginia%20White"));
    const body = await res.json();
    expect(res.status).toBe(200);
    // "Virginia White" matches no single column, so with the full-name leg down
    // there is honestly nothing to show — and the page SAYS so via the warning.
    expect(body.bookings).toEqual([]);
    expect(body.warnings).toEqual(["customer_search_unavailable"]);
    // The Sentry message never carries the typed name/email.
    expect(String(sentry.captureAPIError.mock.calls[0][0].message)).not.toMatch(/virginia/i);
  });
});
