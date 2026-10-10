/**
 * charge.refunded (full refund) is the one SYSTEM path that turns a booking
 * terminal. It attributes the cancel as `system` / `unknown` only when no app
 * path already did — an admin or customer cancel records its reason BEFORE it
 * refunds, and this webhook must never relabel that.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

const { db, constructEvent, sentry } = await vi.hoisted(async () => {
  const { FakeSupabase } = await import("@/lib/booking/__tests__/supabase-fake");
  return {
    db: new FakeSupabase(),
    constructEvent: vi.fn(),
    sentry: {
      capturePaymentError: vi.fn(),
      captureParkGuardError: vi.fn(),
      captureAPIError: vi.fn(),
      captureBookingError: vi.fn(),
    },
  };
});

vi.mock("@/lib/supabase/server", () => ({ createAdminClient: async () => db }));
vi.mock("@/lib/stripe/client", () => ({ stripe: { webhooks: { constructEvent } } }));
vi.mock("@/lib/sentry", () => sentry);
vi.mock("@/lib/parkguard/client", () => ({
  parkGuard: { updateReservation: vi.fn() },
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
    expect(sentry.captureBookingError).toHaveBeenCalledTimes(1);
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

  it("a failed reason write does not fail the webhook", async () => {
    seed();
    db.failWhen("bookings", "update", (p) => !!p && "cancelled_by" in p, "no column");
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(db.tables.bookings[0].status).toBe("refunded");
    expect(sentry.captureAPIError).toHaveBeenCalledTimes(1);
  });
});
