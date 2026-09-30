/**
 * Cancellation-reason plumbing (migration 032). The invariant: a reason is
 * reporting data — writing it can never throw into, block, or fail a cancel,
 * and a customer can never store anything outside the fixed dropdown set.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { FakeSupabase } from "@/lib/booking/__tests__/supabase-fake";

const db = new FakeSupabase();
const sentry = { captureAPIError: vi.fn() };

vi.mock("@/lib/supabase/server", () => ({ createAdminClient: async () => db }));
vi.mock("@/lib/sentry", () => sentry);

const {
  parseCustomerReason,
  recordCancellationReason,
  recordCancellationNote,
  clearCancellationReason,
  adminReasonSchema,
  cancellationNoteSchema,
  CUSTOMER_CANCELLATION_REASONS,
  CANCELLATION_REASONS,
} = await import("../reason");

const OWNED = "2030-01-01T00:00:00.000Z";

function seed(over: Record<string, unknown> = {}) {
  db.tables.bookings = [
    {
      id: "b1",
      reslab_reservation_number: "RTL1",
      status: "confirmed",
      cancel_claimed_at: OWNED,
      cancellation_reason: null,
      cancelled_by: null,
      ...over,
    },
  ];
}

beforeEach(() => {
  db.tables.bookings = [];
  db.tables.booking_cancellation_notes = [];
  db.log = [];
  db.clearFailures();
  sentry.captureAPIError.mockReset();
});

describe("parseCustomerReason — the optional customer dropdown", () => {
  it("accepts every customer reason", () => {
    for (const r of CUSTOMER_CANCELLATION_REASONS) {
      expect(parseCustomerReason({ reason: r })).toBe(r);
    }
  });

  it("collapses absent / empty / malformed / unknown values to null (never rejects)", () => {
    for (const body of [
      null,
      undefined,
      "plans_changed",
      {},
      { reason: "" },
      { reason: null },
      { reason: 42 },
      { reason: "free text the customer typed" },
      [],
    ]) {
      expect(parseCustomerReason(body)).toBeNull();
    }
  });

  it("does NOT let a customer pick a lot-side, payment or unknown reason", () => {
    for (const r of ["lot_turned_away", "lot_sold_out", "payment_issue", "unknown"]) {
      expect(parseCustomerReason({ reason: r })).toBeNull();
    }
  });
});

describe("admin schemas", () => {
  it("admin reason is required and excludes 'unknown'", () => {
    expect(adminReasonSchema.safeParse(undefined).success).toBe(false);
    expect(adminReasonSchema.safeParse("unknown").success).toBe(false);
    expect(adminReasonSchema.safeParse("lot_turned_away").success).toBe(true);
  });

  it("note is trimmed, empty → null, capped at 500", () => {
    expect(cancellationNoteSchema.parse("  lot full  ")).toBe("lot full");
    expect(cancellationNoteSchema.parse("   ")).toBeNull();
    expect(cancellationNoteSchema.safeParse("x".repeat(501)).success).toBe(false);
  });

  it("the TS reason set matches migration 032's CHECK list", () => {
    expect([...CANCELLATION_REASONS].sort()).toEqual(
      [
        "duplicate_booking",
        "found_cheaper",
        "lot_sold_out",
        "lot_turned_away",
        "other",
        "payment_issue",
        "plans_changed",
        "unknown",
      ].sort(),
    );
  });
});

describe("recordCancellationReason", () => {
  it("writes reason + cancelled_by, pinned to the claim", async () => {
    seed();
    const ok = await recordCancellationReason({
      reservationNumber: "RTL1",
      cancelledBy: "customer",
      reason: "found_cheaper",
      ownedAt: OWNED,
      endpoint: "/t",
    });
    expect(ok).toBe(true);
    expect(db.tables.bookings[0]).toMatchObject({
      cancellation_reason: "found_cheaper",
      cancelled_by: "customer",
    });
    // The reason write never touches the notes table.
    expect(db.log.filter((l) => l.table === "booking_cancellation_notes")).toEqual([]);
  });

  it("a stale owner (claim re-stolen) writes nothing", async () => {
    seed({ cancel_claimed_at: "2030-01-01T00:05:00.000Z" });
    await recordCancellationReason({
      reservationNumber: "RTL1",
      cancelledBy: "customer",
      reason: "plans_changed",
      ownedAt: OWNED,
      endpoint: "/t",
    });
    expect(db.tables.bookings[0].cancellation_reason).toBeNull();
    expect(db.tables.bookings[0].cancelled_by).toBeNull();
  });

  it("onlyIfUnset never overwrites an existing attribution", async () => {
    seed({ status: "refunded", cancelled_by: "admin", cancellation_reason: "lot_turned_away" });
    await recordCancellationReason({
      bookingId: "b1",
      cancelledBy: "system",
      reason: "unknown",
      onlyIfUnset: true,
      endpoint: "/t",
    });
    expect(db.tables.bookings[0]).toMatchObject({
      cancelled_by: "admin",
      cancellation_reason: "lot_turned_away",
    });
  });

  it("onlyIfUnset fills an unattributed row", async () => {
    seed({ status: "refunded" });
    await recordCancellationReason({
      bookingId: "b1",
      cancelledBy: "system",
      reason: "unknown",
      onlyIfUnset: true,
      endpoint: "/t",
    });
    expect(db.tables.bookings[0]).toMatchObject({ cancelled_by: "system", cancellation_reason: "unknown" });
  });

  it("a DB error (e.g. 032 not applied) is logged and returns false — never throws", async () => {
    seed();
    db.failOnce("bookings", "update", 'column "cancellation_reason" does not exist', "42703");
    await expect(
      recordCancellationReason({
        reservationNumber: "RTL1",
        cancelledBy: "admin",
        reason: "other",
        endpoint: "/t",
      }),
    ).resolves.toBe(false);
    expect(sentry.captureAPIError).toHaveBeenCalledTimes(1);
    expect(String(sentry.captureAPIError.mock.calls[0][0].message)).toMatch(
      /cancellation reason not recorded for RTL1/,
    );
  });
});

describe("recordCancellationNote — staff-only, in its own table", () => {
  it("writes the note to booking_cancellation_notes, never onto bookings", async () => {
    seed();
    const ok = await recordCancellationNote("b1", "gate closed at 3am", "/t");
    expect(ok).toBe(true);
    expect(db.tables.booking_cancellation_notes).toEqual([
      expect.objectContaining({ booking_id: "b1", note: "gate closed at 3am" }),
    ]);
    // Nothing note-shaped lands on the customer-readable bookings row.
    expect(Object.keys(db.tables.bookings[0])).not.toContain("cancellation_note");
    expect(db.log.filter((l) => l.table === "bookings")).toEqual([]);
  });

  it("a second note for the same booking replaces the first (one row per booking)", async () => {
    seed();
    await recordCancellationNote("b1", "first", "/t");
    await recordCancellationNote("b1", "second", "/t");
    expect(db.tables.booking_cancellation_notes).toHaveLength(1);
    expect(db.tables.booking_cancellation_notes[0].note).toBe("second");
  });

  it("a DB error (e.g. 032 not applied) returns false, logs WITHOUT the note text, never throws", async () => {
    seed();
    db.failOnce("booking_cancellation_notes", "insert", 'relation "booking_cancellation_notes" does not exist', "42P01");
    await expect(recordCancellationNote("b1", "suspected chargeback abuse", "/t")).resolves.toBe(false);
    expect(sentry.captureAPIError).toHaveBeenCalledTimes(1);
    const msg = String(sentry.captureAPIError.mock.calls[0][0].message);
    expect(msg).toMatch(/cancellation note not recorded for booking b1/);
    expect(msg).not.toMatch(/chargeback/);
    expect(db.tables.booking_cancellation_notes).toEqual([]);
  });
});

describe("clearCancellationReason", () => {
  it("clears a reason on a still-confirmed row owned by this claim", async () => {
    seed({ cancellation_reason: "plans_changed", cancelled_by: "customer" });
    await clearCancellationReason("RTL1", OWNED, "/t");
    expect(db.tables.bookings[0]).toMatchObject({ cancellation_reason: null, cancelled_by: null });
  });

  it("never clears a row that actually got cancelled", async () => {
    seed({ status: "refunded", cancellation_reason: "plans_changed", cancelled_by: "customer" });
    await clearCancellationReason("RTL1", OWNED, "/t");
    expect(db.tables.bookings[0].cancellation_reason).toBe("plans_changed");
  });

  it("a DB error is logged, not thrown", async () => {
    seed();
    db.failOnce("bookings", "update", "boom");
    await expect(clearCancellationReason("RTL1", OWNED, "/t")).resolves.toBeUndefined();
    expect(sentry.captureAPIError).toHaveBeenCalledTimes(1);
  });
});
