/**
 * charge.refunded (full refund) is the one SYSTEM path that turns a booking
 * terminal. It attributes the cancel as `system` / `unknown` only when no app
 * path already did — an admin or customer cancel records its reason BEFORE it
 * refunds, and this webhook must never relabel that.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

const { db, constructEvent, sentry, parkGuardMock } = await vi.hoisted(async () => {
  const { FakeSupabase } = await import("@/lib/booking/__tests__/supabase-fake");
  return {
    db: new FakeSupabase(),
    constructEvent: vi.fn(),
    sentry: {
      capturePaymentError: vi.fn(),
      captureParkGuardError: vi.fn(),
      captureAPIError: vi.fn(),
      captureNonCheckoutPayment: vi.fn(),
    },
    parkGuardMock: { updateReservation: vi.fn() },
  };
});

vi.mock("@/lib/supabase/server", () => ({ createAdminClient: async () => db }));
vi.mock("@/lib/stripe/client", () => ({ stripe: { webhooks: { constructEvent } } }));
vi.mock("@/lib/sentry", () => sentry);
// The lot-facing notice (4b plan §3.4) has its own tests (direct/lot-notice);
// here it is a recorded call, never a network or DB side effect.
const lotNotice = vi.hoisted(() => ({ sendLotCancelNotice: vi.fn(async () => "not_claimed"), sendLotBookingNotice: vi.fn(async () => "not_claimed") }));
vi.mock("@/lib/direct/lot-notice", () => lotNotice);
vi.mock("@/lib/parkguard/client", () => ({
  parkGuard: parkGuardMock,
  ParkGuardError: class extends Error {},
}));
vi.mock("@/lib/booking/create-booking", () => ({
  createBooking: vi.fn(),
  shouldStripeRedeliver: vi.fn(),
}));

import { POST } from "../route";

function fullRefundEvent() {
  return {
    type: "charge.refunded",
    data: { object: { payment_intent: "pi_1", amount: 10_000, amount_refunded: 10_000 } },
  };
}

function req() {
  return new NextRequest("https://x.test/api/webhooks/stripe", {
    method: "POST",
    body: "{}",
    headers: { "stripe-signature": "sig" },
  });
}

function seed(over: Record<string, unknown> = {}) {
  db.tables.bookings = [
    {
      id: "b1",
      stripe_payment_intent_id: "pi_1",
      status: "confirmed",
      protection_plan: null,
      protection_plan_price: null,
      pg_identifier: null,
      pg_sync_status: null,
      cancellation_reason: null,
      cancelled_by: null,
      ...over,
    },
  ];
}

beforeEach(() => {
  db.clearFailures();
  constructEvent.mockReset();
  constructEvent.mockReturnValue(fullRefundEvent());
  for (const m of Object.values(sentry)) m.mockReset();
  parkGuardMock.updateReservation.mockReset().mockResolvedValue({});
});

describe("webhook charge.refunded — cancellation reason", () => {
  it("a full refund from outside the app → refunded, cancelled_by=system, reason=unknown", async () => {
    seed();
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(db.tables.bookings[0]).toMatchObject({
      status: "refunded",
      cancelled_by: "system",
      cancellation_reason: "unknown",
    });
  });

  it("never overwrites an admin's recorded reason (admin full refund fires this webhook too)", async () => {
    seed({ status: "refunded", cancelled_by: "admin", cancellation_reason: "lot_turned_away" });
    await POST(req());
    expect(db.tables.bookings[0]).toMatchObject({
      cancelled_by: "admin",
      cancellation_reason: "lot_turned_away",
    });
  });

  it("never relabels a customer who skipped the dropdown (cancelled_by set, reason NULL) — the common self-cancel case", async () => {
    // A no-Park-Guard self-cancel refunds 100%, so this webhook fires for it.
    // `onlyIfUnset` must key on cancelled_by, not on the reason.
    seed({ status: "refunded", cancelled_by: "customer", cancellation_reason: null });
    await POST(req());
    expect(db.tables.bookings[0]).toMatchObject({
      cancelled_by: "customer",
      cancellation_reason: null,
    });
  });

  it("a partial refund writes no attribution at all", async () => {
    seed();
    constructEvent.mockReturnValue({
      type: "charge.refunded",
      data: { object: { payment_intent: "pi_1", amount: 10_000, amount_refunded: 2_500 } },
    });
    const res = await POST(req());
    expect(res.status).toBe(200);
    // The partial-refund branch was actually reached (it logs an informational event).
    expect(
      sentry.capturePaymentError.mock.calls.some((c) =>
        /Partial refund on booking b1/.test(String((c[0] as Error).message)),
      ),
    ).toBe(true);
    expect(db.tables.bookings[0]).toMatchObject({
      status: "confirmed",
      cancelled_by: null,
      cancellation_reason: null,
    });
  });

  it("never overwrites a dispute, and writes no reason for a row that didn't move", async () => {
    seed({ status: "disputed" });
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(db.tables.bookings[0]).toMatchObject({ status: "disputed", cancelled_by: null, cancellation_reason: null });
    // Reported as a PAYMENT event, tagged with the PI and the refunded amount.
    const notAdvanced = sentry.capturePaymentError.mock.calls.filter((c) =>
      /left its status as is/.test(String((c[0] as Error).message)),
    );
    expect(notAdvanced).toHaveLength(1);
    expect(notAdvanced[0][1]).toEqual({ stripePaymentIntentId: "pi_1", amount: 100 });
    expect(parkGuardMock.updateReservation).not.toHaveBeenCalled();
  });

  it("a disputed row WITH Park Guard: the refund still cancels the protection, but no reason is written", async () => {
    seed({
      status: "disputed",
      protection_plan: "parkguard",
      protection_plan_price: "12.99",
      pg_identifier: "pg_1",
      pg_sync_status: "synced",
    });
    const res = await POST(req());
    expect(res.status).toBe(200);
    // Park Guard must not keep billing Triply for a premium that was refunded,
    // whatever the booking's status did.
    expect(parkGuardMock.updateReservation).toHaveBeenCalledTimes(1);
    expect(parkGuardMock.updateReservation).toHaveBeenCalledWith("b1", { status: "cancelled" });
    expect(db.tables.bookings[0]).toMatchObject({
      status: "disputed",
      cancelled_by: null,
      cancellation_reason: null,
    });
  });

  it("a payment_failed row is left as is too", async () => {
    seed({ status: "payment_failed" });
    await POST(req());
    expect(db.tables.bookings[0].status).toBe("payment_failed");
  });

  it("a cancelled row with a full refund still becomes refunded (accounting reads refunded as money returned)", async () => {
    seed({ status: "cancelled" });
    await POST(req());
    expect(db.tables.bookings[0].status).toBe("refunded");
  });

  describe("the DIRECT lot's cancel notice (4b plan §3.4)", () => {
    beforeEach(() => lotNotice.sendLotCancelNotice.mockClear());

    const partialRefund = () => ({
      type: "charge.refunded",
      data: { object: { payment_intent: "pi_1", amount: 10_000, amount_refunded: 2_500 } },
    });

    it("a FULL refund on a confirmed direct booking → the lot is told, once, with the PaymentIntent, after the status write", async () => {
      seed({ inventory_source: "direct" });
      const seenStatus: unknown[] = [];
      lotNotice.sendLotCancelNotice.mockImplementationOnce(async () => {
        seenStatus.push(db.tables.bookings[0].status);
        return "not_claimed";
      });
      const res = await POST(req());
      expect(res.status).toBe(200);
      expect(lotNotice.sendLotCancelNotice).toHaveBeenCalledTimes(1);
      expect(lotNotice.sendLotCancelNotice).toHaveBeenCalledWith("pi_1");
      expect(seenStatus).toEqual(["refunded"]);
    });

    it("a PARTIAL refund on a direct booking → NO cancel notice (the lot would turn away a paying customer)", async () => {
      seed({ inventory_source: "direct" });
      constructEvent.mockReturnValue(partialRefund());
      const res = await POST(req());
      expect(res.status).toBe(200);
      expect(db.tables.bookings[0].status).toBe("confirmed");
      expect(lotNotice.sendLotCancelNotice).not.toHaveBeenCalled();
    });

    it("a full refund on a ResLab booking → no lot notice", async () => {
      seed({ inventory_source: "reslab" });
      await POST(req());
      expect(db.tables.bookings[0].status).toBe("refunded");
      expect(lotNotice.sendLotCancelNotice).not.toHaveBeenCalled();
    });

    it("a full refund on a DISPUTED direct booking (status does not advance) → no lot notice", async () => {
      seed({ inventory_source: "direct", status: "disputed" });
      await POST(req());
      expect(db.tables.bookings[0].status).toBe("disputed");
      expect(lotNotice.sendLotCancelNotice).not.toHaveBeenCalled();
    });
  });

  it("a failed reason write does not fail the webhook", async () => {
    seed();
    db.failWhen("bookings", "update", (p) => !!p && "cancelled_by" in p, "no column");
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(db.tables.bookings[0].status).toBe("refunded");
    expect(sentry.captureAPIError).toHaveBeenCalledTimes(1);
  });
});
