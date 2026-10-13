/**
 * Admin bookings list: the staff cancellation note (migration 032) lives in its
 * own service-role-only table and is attached to each row as `cancellation_note`
 * by a SEPARATE best-effort lookup. A failure of that lookup must only lose the
 * notes — never the bookings list itself.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

const { db, sentry, key } = await vi.hoisted(async () => {
  const { FakeSupabase } = await import("@/lib/booking/__tests__/supabase-fake");
  return { db: new FakeSupabase(), sentry: { captureAPIError: vi.fn() }, key: { mode: "live" as "live" | "test" | null } };
});

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { email: "admin@example.com" } } }) },
  }),
  createAdminClient: async () => db,
}));
vi.mock("@/config/admin", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/config/admin")>()),
  isAdminEmail: () => true,
}));
vi.mock("@/lib/cancellation/source-guard", () => ({ stripeKeyMode: () => key.mode }));
vi.mock("@/lib/sentry", () => sentry);

import { GET } from "../route";

const req = (qs = "") => new NextRequest(`https://x.test/api/admin/bookings${qs}`);

beforeEach(() => {
  key.mode = "live";
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
    // Reported, not just logged: the page would otherwise show only an error with nothing in Sentry.
    expect(String(sentry.captureAPIError.mock.calls[0][0].message)).toMatch(/Admin bookings query failed \(mode live\): boom/);
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

describe("GET /api/admin/bookings — ?inventory= (6b §7)", () => {
  beforeEach(() => {
    db.tables.customers = [];
    db.tables.booking_cancellation_notes = [];
    db.tables.bookings = [
      { id: "r1", customer_id: null, status: "confirmed", created_at: "2026-10-01T00:00:00Z", inventory_source: "reslab", reslab_reservation_number: "RTL1", location_name: "Lot A" },
      { id: "d1", customer_id: null, status: "confirmed", created_at: "2026-10-02T00:00:00Z", inventory_source: "direct", reslab_reservation_number: "TRP-ABC123", location_name: "The Parking Point" },
    ];
  });

  const list = async (qs: string) => {
    const res = await GET(req(qs));
    return { status: res.status, body: await res.json() };
  };

  it("absent or 'all' → every booking", async () => {
    for (const qs of ["", "?inventory=all"]) {
      const r = await list(qs);
      expect(r.status).toBe(200);
      expect(r.body.bookings.map((b: { id: string }) => b.id).sort()).toEqual(["d1", "r1"]);
    }
  });

  it("'reslab' and 'direct' each filter to their own rows (and combine with search)", async () => {
    expect((await list("?inventory=reslab")).body.bookings.map((b: { id: string }) => b.id)).toEqual(["r1"]);
    expect((await list("?inventory=direct")).body.bookings.map((b: { id: string }) => b.id)).toEqual(["d1"]);
    expect((await list("?inventory=direct&search=RTL1")).body.bookings).toEqual([]);
  });

  it("an invalid value is a 400 — never the unfiltered list", async () => {
    for (const qs of ["?inventory=Direct", "?inventory=", "?inventory=reslab,direct"]) {
      const r = await list(qs);
      expect(r.status).toBe(400);
      expect(r.body.bookings).toBeUndefined();
    }
    expect(db.log.filter((l) => l.table === "bookings")).toEqual([]);
  });
});

describe("GET /api/admin/bookings — ?mode= live / test (shared database)", () => {
  beforeEach(() => {
    db.tables.customers = [];
    db.tables.booking_cancellation_notes = [];
    db.tables.bookings = [
      // live: pre-015 NULL livemode, explicit true, and a live direct booking
      { id: "old", customer_id: null, status: "confirmed", created_at: "2026-05-01T00:00:00Z", livemode: null, reslab_location_id: 412 },
      { id: "live", customer_id: null, status: "confirmed", created_at: "2026-10-01T00:00:00Z", livemode: true, reslab_location_id: 412 },
      { id: "liveDirect", customer_id: null, status: "confirmed", created_at: "2026-10-02T00:00:00Z", livemode: true, reslab_location_id: null, inventory_source: "direct" },
      // test: staging (test-mode) rows, and a live-mode booking at a test ResLab lot
      { id: "stagingDirect", customer_id: null, status: "confirmed", created_at: "2026-10-03T00:00:00Z", livemode: false, reslab_location_id: null, inventory_source: "direct", reslab_reservation_number: "TRP-D0K1KGXC" },
      { id: "stagingReslab", customer_id: null, status: "confirmed", created_at: "2026-10-04T00:00:00Z", livemode: false, reslab_location_id: 412 },
      { id: "testLot", customer_id: null, status: "confirmed", created_at: "2026-10-05T00:00:00Z", livemode: true, reslab_location_id: 194 },
      // NULL edges: no lot id + NULL livemode is live; a test lot with NULL livemode is test.
      { id: "nullBoth", customer_id: null, status: "confirmed", created_at: "2026-04-01T00:00:00Z", livemode: null, reslab_location_id: null },
      { id: "testLotNull", customer_id: null, status: "confirmed", created_at: "2026-04-02T00:00:00Z", livemode: null, reslab_location_id: 195 },
    ];
  });

  const ids = async (qs: string) => {
    const res = await GET(req(qs));
    const body = await res.json();
    return { status: res.status, mode: body.mode, ids: (body.bookings ?? []).map((b: { id: string }) => b.id).sort() };
  };
  const LIVE = ["live", "liveDirect", "nullBoth", "old"];
  const TEST = ["stagingDirect", "stagingReslab", "testLot", "testLotNull"];

  it("production (live key) defaults to live bookings only — no staging test rows", async () => {
    expect(await ids("")).toEqual({ status: 200, mode: "live", ids: LIVE });
  });

  it("staging (test key) defaults to test bookings only", async () => {
    key.mode = "test";
    expect(await ids("")).toEqual({ status: 200, mode: "test", ids: TEST });
  });

  it("an unrecognised Stripe key shows live + test with a warning and a Sentry event — never a silent guess", async () => {
    key.mode = null;
    const res = await GET(req(""));
    const body = await res.json();
    expect(body.mode).toBe("all");
    expect(body.warnings).toContain("mode_default_unknown");
    expect(body.bookings.map((b: { id: string }) => b.id).sort()).toEqual([...LIVE, ...TEST].sort());
    expect(sentry.captureAPIError).toHaveBeenCalledTimes(1);
  });

  it("explicit live / test / all, whichever key; live and test partition every row", async () => {
    for (const k of ["live", "test"] as const) {
      key.mode = k;
      expect((await ids("?mode=live")).ids).toEqual(LIVE);
      expect((await ids("?mode=test")).ids).toEqual(TEST);
      expect((await ids("?mode=all")).ids).toEqual([...LIVE, ...TEST].sort());
    }
  });

  it("combines with inventory and search", async () => {
    expect((await ids("?inventory=direct")).ids).toEqual(["liveDirect"]);
    expect((await ids("?mode=test&inventory=direct")).ids).toEqual(["stagingDirect"]);
    expect((await ids("?search=TRP-D0K1")).ids).toEqual([]);
    expect((await ids("?mode=test&search=TRP-D0K1")).ids).toEqual(["stagingDirect"]);
  });

  it("an invalid mode is a 400 — never an unfiltered list", async () => {
    for (const qs of ["?mode=Live", "?mode=", "?mode=both"]) {
      const r = await ids(qs);
      expect(r.status).toBe(400);
    }
    expect(db.log.filter((l) => l.table === "bookings")).toEqual([]);
  });
});
