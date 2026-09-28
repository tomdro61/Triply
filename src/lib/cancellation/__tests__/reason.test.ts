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
      cancellation_note: null,
      cancelled_by: null,
      ...over,
    },
  ];
}

beforeEach(() => {
  db.tables.bookings = [];
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
      cancellation_note: null,
    });
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
        note: "n",
        endpoint: "/t",
      }),
    ).resolves.toBe(false);
    expect(sentry.captureAPIError).toHaveBeenCalledTimes(1);
    expect(String(sentry.captureAPIError.mock.calls[0][0].message)).toMatch(
      /cancellation reason not recorded for RTL1/,
    );
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
