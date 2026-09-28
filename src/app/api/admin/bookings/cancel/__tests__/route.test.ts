/**
 * Admin cancel: a reason is REQUIRED (400 before any side effect when missing),
 * and it is recorded as cancelled_by=admin BEFORE the refund — so the
 * charge.refunded webhook that the refund triggers can't relabel it "system".
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

const { db, reslabMock, stripeMock, order } = await vi.hoisted(async () => {
  const { FakeSupabase } = await import("@/lib/booking/__tests__/supabase-fake");
  return {
    db: new FakeSupabase(),
    reslabMock: { cancelReservation: vi.fn() },
    stripeMock: { getPaymentIntent: vi.fn(), createRefund: vi.fn(), cancelPaymentIntent: vi.fn() },
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
vi.mock("@/lib/sentry", () => ({
  captureAPIError: vi.fn(),
  captureParkGuardError: vi.fn(),
}));
vi.mock("@/lib/parkguard/client", () => ({
  parkGuard: { updateReservation: vi.fn() },
  ParkGuardError: class extends Error {},
}));

import { POST } from "../route";

function seed() {
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
      cancellation_note: null,
      cancelled_by: null,
    },
  ];
}

const req = (body: Record<string, unknown>) =>
  new NextRequest("https://x.test/api/admin/bookings/cancel", {
    method: "POST",
    body: JSON.stringify({ reservationNumber: "RTL1", ...body }),
    headers: { "Content-Type": "application/json" },
  });

beforeEach(() => {
  seed();
  order.length = 0;
  reslabMock.cancelReservation.mockReset().mockImplementation(async () => {
    order.push(`reslab:reason=${String(db.tables.bookings[0].cancellation_reason)}`);
    return { cancelled: true };
  });
  stripeMock.getPaymentIntent.mockReset().mockResolvedValue({ status: "succeeded", amount_received: 10_000 });
  stripeMock.createRefund.mockReset().mockImplementation(async () => {
    order.push(`refund:by=${String(db.tables.bookings[0].cancelled_by)}`);
    return { id: "re_1" };
  });
  stripeMock.cancelPaymentIntent.mockReset();
});

describe("POST /api/admin/bookings/cancel — reason", () => {
  it("missing reason → 400, and NOTHING happens (no claim, no ResLab, no refund)", async () => {
    const res = await POST(req({}));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/reason is required/i);
    expect(reslabMock.cancelReservation).not.toHaveBeenCalled();
    expect(stripeMock.createRefund).not.toHaveBeenCalled();
    expect(db.tables.bookings[0].cancel_claimed_at).toBeNull();
  });

  it("'unknown' and made-up reasons are rejected for admins", async () => {
    for (const reason of ["unknown", "because"]) {
      const res = await POST(req({ reason }));
      expect(res.status).toBe(400);
    }
    expect(reslabMock.cancelReservation).not.toHaveBeenCalled();
  });

  it("records reason + note + cancelled_by=admin BEFORE ResLab and the refund", async () => {
    const res = await POST(req({ reason: "lot_turned_away", note: "  gate closed at 3am  ", refundServiceFee: true }));
    expect(res.status).toBe(200);
    expect(order).toEqual(["reslab:reason=lot_turned_away", "refund:by=admin"]);
    expect(db.tables.bookings[0]).toMatchObject({
      status: "refunded",
      cancellation_reason: "lot_turned_away",
      cancellation_note: "gate closed at 3am",
      cancelled_by: "admin",
    });
  });

  it("a failed reason write does not stop the admin cancel", async () => {
    db.failWhen("bookings", "update", (p) => !!p && "cancelled_by" in p, "no column");
    const res = await POST(req({ reason: "plans_changed" }));
    expect(res.status).toBe(200);
    expect(stripeMock.createRefund).toHaveBeenCalled();
    expect(db.tables.bookings[0].status).toBe("refunded");
  });
});
