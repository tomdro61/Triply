/**
 * Admin cancel: a reason is REQUIRED (400 before any side effect when missing),
 * it is recorded as cancelled_by=admin BEFORE the refund — so the
 * charge.refunded webhook that the refund triggers can't relabel it "system" —
 * and the reason feature changes NOTHING about the money: refund amount,
 * idempotency key, Park Guard withholding and PG sync are pinned here, with and
 * without the reason write failing. The staff note lives in its own
 * service-role-only table, never on the customer-readable bookings row.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

const { db, reslabMock, stripeMock, parkGuardMock, sentry, order } = await vi.hoisted(async () => {
  const { FakeSupabase } = await import("@/lib/booking/__tests__/supabase-fake");
  return {
    db: new FakeSupabase(),
    reslabMock: { cancelReservation: vi.fn() },
    stripeMock: { getPaymentIntent: vi.fn(), createRefund: vi.fn(), cancelPaymentIntent: vi.fn() },
    parkGuardMock: { updateReservation: vi.fn() },
    sentry: { captureAPIError: vi.fn(), captureParkGuardError: vi.fn() },
    order: [] as string[],
  };
});

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { email: "admin@example.com" } } }) },
  }),
  createAdminClient: async () => db,
}));
vi.mock("@/config/admin", () => ({ isAdminEmail: () => true }));
vi.mock("@/lib/reslab/client", () => ({ reslab: reslabMock }));
vi.mock("@/lib/stripe/client", () => stripeMock);
vi.mock("@/lib/resend/send-cancellation-confirmation", () => ({
  sendCancellationConfirmation: vi.fn(async () => ({ success: true })),
}));
vi.mock("@/lib/sentry", () => sentry);
vi.mock("@/lib/parkguard/client", () => ({
  parkGuard: parkGuardMock,
  ParkGuardError: class extends Error {},
}));

import { POST } from "../route";

const PG_ROW = {
  protection_plan: "parkguard",
  protection_plan_price: "12.99",
  protection_plan_wholesale: "6.00",
  pg_identifier: "pg_1",
};

function seed(over: Record<string, unknown> = {}) {
  db.tables.bookings = [
    {
      id: "b1",
      reslab_reservation_number: "RTL1",
      status: "confirmed",
      location_name: "Lot",
      location_address: "1 Way",
      check_in: "2030-06-15 10:00:00",
      check_out: "2030-06-20 10:00:00",
      grand_total: "90.00",
      triply_service_fee: "5.95",
      protection_plan: null,
      protection_plan_price: null,
      protection_plan_wholesale: null,
      pg_identifier: null,
      stripe_payment_intent_id: "pi_1",
      cancel_claimed_at: null,
      cancel_state: null,
      cancellation_reason: null,
      cancelled_by: null,
      ...over,
    },
  ];
  db.tables.booking_cancellation_notes = [];
}

const req = (body: Record<string, unknown>) =>
  new NextRequest("https://x.test/api/admin/bookings/cancel", {
    method: "POST",
    body: JSON.stringify({ reservationNumber: "RTL1", ...body }),
    headers: { "Content-Type": "application/json" },
  });

const row = () => db.tables.bookings[0];
const failReasonWrite = () =>
  db.failWhen("bookings", "update", (p) => !!p && "cancelled_by" in p, "no column");

beforeEach(() => {
  seed();
  db.clearFailures();
  db.log = [];
  order.length = 0;
  reslabMock.cancelReservation.mockReset().mockImplementation(async () => {
    order.push(`reslab:reason=${String(row().cancellation_reason)}`);
    return { cancelled: true };
  });
  stripeMock.getPaymentIntent.mockReset().mockResolvedValue({ status: "succeeded", amount_received: 10_000 });
  stripeMock.createRefund.mockReset().mockImplementation(async () => {
    order.push(`refund:by=${String(row().cancelled_by)}`);
    return { id: "re_1" };
  });
  stripeMock.cancelPaymentIntent.mockReset();
  parkGuardMock.updateReservation.mockReset().mockResolvedValue({});
  sentry.captureAPIError.mockReset();
  sentry.captureParkGuardError.mockReset();
});

/** Every 400 must happen before ANY side effect: no DB access at all, no Stripe, no PG. */
function expectNoSideEffects() {
  expect(db.log).toEqual([]);
  expect(reslabMock.cancelReservation).not.toHaveBeenCalled();
  expect(stripeMock.getPaymentIntent).not.toHaveBeenCalled();
  expect(stripeMock.createRefund).not.toHaveBeenCalled();
  expect(parkGuardMock.updateReservation).not.toHaveBeenCalled();
  expect(row().cancel_claimed_at).toBeNull();
  expect(row().cancel_state).toBeNull();
  expect(row().status).toBe("confirmed");
}

describe("POST /api/admin/bookings/cancel — reason is required", () => {
  it("missing reason → 400, and NOTHING happens (no DB read/write, no claim, no ResLab, no refund)", async () => {
    const res = await POST(req({}));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/reason is required/i);
    expectNoSideEffects();
  });

  it("'unknown' and made-up reasons are rejected for admins, with no side effects", async () => {
    for (const reason of ["unknown", "because"]) {
      const res = await POST(req({ reason }));
      expect(res.status).toBe(400);
    }
    expectNoSideEffects();
  });

  it("a note over 500 characters → 400 before any side effect", async () => {
    const res = await POST(req({ reason: "other", note: "x".repeat(501) }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/500/);
    expectNoSideEffects();
  });
});

describe("POST /api/admin/bookings/cancel — attribution", () => {
  it("records reason + cancelled_by=admin BEFORE ResLab and the refund; the note goes to its own table", async () => {
    const res = await POST(req({ reason: "lot_turned_away", note: "  gate closed at 3am  ", refundServiceFee: true }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ success: true, reasonRecorded: true, noteRecorded: true });
    expect(order).toEqual(["reslab:reason=lot_turned_away", "refund:by=admin"]);
    expect(row()).toMatchObject({
      status: "refunded",
      cancellation_reason: "lot_turned_away",
      cancelled_by: "admin",
    });
    // The staff note is NOT on the customer-readable bookings row.
    expect(Object.keys(row())).not.toContain("cancellation_note");
    expect(db.tables.booking_cancellation_notes).toEqual([
      expect.objectContaining({ booking_id: "b1", note: "gate closed at 3am" }),
    ]);
  });

  it("no note given → noteRecorded is null and the notes table is untouched", async () => {
    const res = await POST(req({ reason: "plans_changed" }));
    expect(res.status).toBe(200);
    expect((await res.json()).noteRecorded).toBeNull();
    expect(db.tables.booking_cancellation_notes).toEqual([]);
    expect(db.log.filter((l) => l.table === "booking_cancellation_notes")).toEqual([]);
  });

  it("a failed reason write does not stop the cancel, is reported to Sentry, and is NOT claimed as recorded", async () => {
    failReasonWrite();
    const res = await POST(req({ reason: "plans_changed", note: "call the lot" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.reasonRecorded).toBe(false);
    // The note write is independent of the reason write.
    expect(body.noteRecorded).toBe(true);
    expect(body.results.errors).toEqual(
      expect.arrayContaining([expect.stringMatching(/cancellation reason NOT recorded/)]),
    );
    expect(row().status).toBe("refunded");
    expect(row().cancellation_reason).toBeNull();
    expect(row().cancelled_by).toBeNull();
    expect(stripeMock.createRefund).toHaveBeenCalledWith("pi_1", 94.05, "admin-cancel:pi_1");
    expect(
      sentry.captureAPIError.mock.calls.some((c) =>
        /cancellation reason not recorded for RTL1/.test(String((c[0] as Error).message)),
      ),
    ).toBe(true);
  });

  it("a failed note write does not stop the cancel and is NOT claimed as recorded", async () => {
    db.failOnce("booking_cancellation_notes", "insert", "relation does not exist", "42P01");
    const res = await POST(req({ reason: "other", note: "rude on the phone" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ success: true, reasonRecorded: true, noteRecorded: false });
    expect(body.results.errors).toEqual(
      expect.arrayContaining([expect.stringMatching(/admin note NOT recorded/)]),
    );
    expect(row()).toMatchObject({ status: "refunded", cancellation_reason: "other", cancelled_by: "admin" });
    expect(db.tables.booking_cancellation_notes).toEqual([]);
    // Never the note text in Sentry.
    for (const c of sentry.captureAPIError.mock.calls) {
      expect(String((c[0] as Error).message)).not.toMatch(/rude on the phone/);
    }
  });
});

/**
 * The money is unchanged by the reason feature. $100.00 received, $5.95 service
 * fee, Park Guard premium $12.99 with $6.00 wholesale:
 *   standard cancel  → refund 100 − 5.95 − 6.00 = 88.05, fee retained
 *   full refund      → refund 100.00, fee refunded
 * Each case is run with the reason write healthy AND failing; the refund
 * arguments must be byte-identical.
 */
describe("POST /api/admin/bookings/cancel — money is unchanged by the reason feature", () => {
  it.each([
    ["healthy reason write", false],
    ["failed reason write", true],
  ])("standard cancel with Park Guard: refund 88.05, PG synced, fee retained (%s)", async (_label, fail) => {
    seed(PG_ROW);
    if (fail) failReasonWrite();
    const res = await POST(req({ reason: "plans_changed" }));
    expect(res.status).toBe(200);
    // Proves the injected failure actually fired in the failing variant.
    expect((await res.json()).reasonRecorded).toBe(!fail);
    expect(stripeMock.createRefund).toHaveBeenCalledTimes(1);
    expect(stripeMock.createRefund).toHaveBeenCalledWith("pi_1", 88.05, "admin-cancel:pi_1");
    expect(parkGuardMock.updateReservation).toHaveBeenCalledTimes(1);
    expect(parkGuardMock.updateReservation).toHaveBeenCalledWith("b1", { status: "cancelled" });
    expect(row()).toMatchObject({ status: "refunded", service_fee_refunded: false, pg_identifier: null });
  });

  it.each([
    ["healthy reason write", false],
    ["failed reason write", true],
  ])("full refund with Park Guard: refund 100.00, PG synced, fee refunded (%s)", async (_label, fail) => {
    seed(PG_ROW);
    if (fail) failReasonWrite();
    const res = await POST(req({ reason: "lot_turned_away", refundServiceFee: true }));
    expect(res.status).toBe(200);
    expect((await res.json()).reasonRecorded).toBe(!fail);
    expect(stripeMock.createRefund).toHaveBeenCalledTimes(1);
    expect(stripeMock.createRefund).toHaveBeenCalledWith("pi_1", 100, "admin-cancel:pi_1");
    expect(parkGuardMock.updateReservation).toHaveBeenCalledWith("b1", { status: "cancelled" });
    expect(row()).toMatchObject({ status: "refunded", service_fee_refunded: true, pg_identifier: null });
  });

  it("standard cancel without Park Guard: refund 94.05 (fee retained), PG never called", async () => {
    const res = await POST(req({ reason: "found_cheaper" }));
    expect(res.status).toBe(200);
    expect(stripeMock.createRefund).toHaveBeenCalledWith("pi_1", 94.05, "admin-cancel:pi_1");
    expect(parkGuardMock.updateReservation).not.toHaveBeenCalled();
    expect(row()).toMatchObject({ status: "refunded", service_fee_refunded: false });
  });
});

describe("POST /api/admin/bookings/cancel — direct lots + environment guards (plan 4b §9 H-C/H-D)", () => {
  it("a direct booking never calls ResLab and is refunded as usual", async () => {
    seed({ reslab_reservation_number: "TRP-AB12CD34", inventory_source: "direct", livemode: false });
    const res = await POST(
      new NextRequest("https://x.test/api/admin/bookings/cancel", {
        method: "POST",
        body: JSON.stringify({ reservationNumber: "TRP-AB12CD34", reason: "found_cheaper" }),
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(res.status).toBe(200);
    expect(reslabMock.cancelReservation).not.toHaveBeenCalled();
    expect(stripeMock.createRefund).toHaveBeenCalled();
    expect(row().status).toBe("refunded");
  });

  it("a ResLab row read without inventory_source still calls ResLab", async () => {
    await POST(req({ reason: "found_cheaper" }));
    expect(reslabMock.cancelReservation).toHaveBeenCalledWith("RTL1");
  });

  it("a booking paid in the other Stripe mode is refused before any side effect", async () => {
    seed({ livemode: true });
    const res = await POST(req({ reason: "found_cheaper" }));
    expect(res.status).toBe(409);
    expect(reslabMock.cancelReservation).not.toHaveBeenCalled();
    expect(stripeMock.createRefund).not.toHaveBeenCalled();
    expect(row()).toMatchObject({ status: "confirmed", cancel_claimed_at: null, cancelled_by: null });
  });

  it("source and number disagreeing is refused before any side effect", async () => {
    seed({ inventory_source: "direct" });
    const res = await POST(req({ reason: "found_cheaper" }));
    expect(res.status).toBe(500);
    expect(reslabMock.cancelReservation).not.toHaveBeenCalled();
    expect(stripeMock.createRefund).not.toHaveBeenCalled();
    expect(row().cancel_claimed_at).toBeNull();
  });
});
