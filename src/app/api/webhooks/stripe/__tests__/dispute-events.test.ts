/**
 * The webhook's dispute wiring: created/updated/closed reach the ledger, the
 * evidence is built from the booking BEFORE it is flipped to `disputed`, and a
 * ledger failure asks Stripe to redeliver (503).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

const { db, constructEvent, disputesUpdate, disputesRetrieve, sentry, alerts } = await vi.hoisted(async () => {
  const { FakeSupabase } = await import("@/lib/booking/__tests__/supabase-fake");
  return {
    db: new FakeSupabase(),
    constructEvent: vi.fn(),
    disputesUpdate: vi.fn(),
    disputesRetrieve: vi.fn(),
    sentry: {
      capturePaymentError: vi.fn(),
      captureParkGuardError: vi.fn(),
      captureAPIError: vi.fn(),
      captureNonCheckoutPayment: vi.fn(),
    },
    alerts: { sendDisputeOpenedAlert: vi.fn(), sendDisputeClosedAlert: vi.fn() },
  };
});

vi.mock("@/lib/supabase/server", () => ({ createAdminClient: async () => db }));
vi.mock("@/lib/stripe/client", () => ({
  stripe: { webhooks: { constructEvent }, disputes: { update: disputesUpdate, retrieve: disputesRetrieve } },
}));
vi.mock("@/lib/sentry", () => sentry);
vi.mock("@/lib/resend/send-dispute-alert", () => alerts);
vi.mock("@/lib/direct/lot-notice", () => ({ sendLotCancelNotice: vi.fn(), sendLotBookingNotice: vi.fn() }));
vi.mock("@/lib/parkguard/client", () => ({ parkGuard: { updateReservation: vi.fn() }, ParkGuardError: class extends Error {} }));
vi.mock("@/lib/booking/create-booking", () => ({ createBooking: vi.fn(), shouldStripeRedeliver: vi.fn() }));

import { POST } from "../route";

const disputeObj = (status: string) => ({
  id: "dp_1",
  amount: 5057,
  currency: "usd",
  reason: "subscription_canceled",
  status,
  livemode: true,
  payment_intent: "pi_1",
  charge: "ch_1",
  evidence_details: { due_by: 1_762_300_800 },
});

function req() {
  return new NextRequest("https://x.test/api/webhooks/stripe", {
    method: "POST",
    body: "{}",
    headers: { "stripe-signature": "sig" },
  });
}

async function send(type: string, status: string) {
  constructEvent.mockReturnValueOnce({ type, data: { object: disputeObj(status) } });
  return POST(req());
}

beforeEach(() => {
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
  db.clearFailures();
  db.seed("bookings", [
    { id: "b1", customer_id: "c1", stripe_payment_intent_id: "pi_1", reslab_reservation_number: "RTL1", status: "confirmed", cancelled_by: null },
  ])
    .seed("customers", [{ id: "c1", email: "a@b.com" }])
    .seed("pending_bookings", [])
    .seed("disputes", []);
  constructEvent.mockReset();
  disputesUpdate.mockReset().mockResolvedValue({});
  disputesRetrieve.mockReset().mockResolvedValue({ status: "needs_response", evidence: {}, charge: { amount_captured: 5057, amount_refunded: 0, currency: "usd", created: 1_759_320_000 }, payment_intent: { id: "pi_1", metadata: {} } });
  for (const m of Object.values(sentry)) m.mockReset();
  alerts.sendDisputeOpenedAlert.mockReset().mockResolvedValue(undefined);
  alerts.sendDisputeClosedAlert.mockReset().mockResolvedValue(undefined);
});

describe("Stripe webhook — disputes", () => {
  it("created: flips the booking, but the evidence describes it as it was", async () => {
    const res = await send("charge.dispute.created", "needs_response");
    expect(res.status).toBe(200);
    expect(db.tables.bookings[0].status).toBe("disputed");
    expect(db.tables.disputes[0]).toMatchObject({ booking_id: "b1", booking_status_at_dispute: "confirmed" });
    const [, params] = disputesUpdate.mock.calls[0];
    expect(params.submit).toBe(false);
    expect(params.evidence.cancellation_rebuttal).toContain("no cancellation");
    expect(alerts.sendDisputeOpenedAlert).toHaveBeenCalledTimes(1);
  });

  it("created: a ledger failure returns 503 and holds the flip, so the redelivery still sees the real status", async () => {
    db.failOnce("disputes", "insert", "connection reset");
    const res = await send("charge.dispute.created", "needs_response");
    expect(res.status).toBe(503);
    expect(db.tables.bookings[0].status).toBe("confirmed");
    expect(alerts.sendDisputeOpenedAlert).not.toHaveBeenCalled();

    expect((await send("charge.dispute.created", "needs_response")).status).toBe(200);
    expect(db.tables.bookings[0].status).toBe("disputed");
    expect(db.tables.disputes[0].booking_status_at_dispute).toBe("confirmed");
  });

  it("created: an email retry does not re-flip a booking someone changed since", async () => {
    alerts.sendDisputeOpenedAlert.mockRejectedValueOnce(new Error("Resend down"));
    expect((await send("charge.dispute.created", "needs_response")).status).toBe(503);
    expect(db.tables.bookings[0].status).toBe("disputed");
    db.tables.bookings[0].status = "cancelled"; // e.g. refunded in the meantime
    expect((await send("charge.dispute.created", "needs_response")).status).toBe(200);
    expect(db.tables.bookings[0].status).toBe("cancelled");
  });

  it("created: a refund that lands while the delivery runs keeps its status (compare-and-set flip)", async () => {
    alerts.sendDisputeOpenedAlert.mockImplementationOnce(async () => {
      db.tables.bookings[0].status = "refunded"; // an admin refund mid-run
    });
    expect((await send("charge.dispute.created", "needs_response")).status).toBe(200);
    expect(db.tables.bookings[0].status).toBe("refunded");
    expect(sentry.capturePaymentError.mock.calls.some(([e]) => e.message.includes("not flipped to disputed"))).toBe(true);
  });

  it("created: a failed booking lookup for the flip returns 503 and the redelivery flips", async () => {
    // First bookings select = the handler's evidence read; the second is the route's flip lookup.
    let reads = 0;
    db.failWhen("bookings", "select", () => ++reads === 2, "timeout");
    expect((await send("charge.dispute.created", "needs_response")).status).toBe(503);
    expect(db.tables.bookings[0].status).toBe("confirmed");
    expect((await send("charge.dispute.created", "needs_response")).status).toBe(200);
    expect(db.tables.bookings[0].status).toBe("disputed");
    expect(alerts.sendDisputeOpenedAlert).toHaveBeenCalledTimes(1);
  });

  it("created: a failed flip returns 503 and the redelivery flips without a second alert", async () => {
    db.failOnce("bookings", "update", "connection reset");
    expect((await send("charge.dispute.created", "needs_response")).status).toBe(503);
    expect(db.tables.bookings[0].status).toBe("confirmed");
    expect((await send("charge.dispute.created", "needs_response")).status).toBe(200);
    expect(db.tables.bookings[0].status).toBe("disputed");
    expect(alerts.sendDisputeOpenedAlert).toHaveBeenCalledTimes(1);
  });

  it("created: a booking with a NULL status is still flipped, including on a redelivery after a failed flip", async () => {
    db.tables.bookings[0].status = null;
    db.failOnce("bookings", "update", "connection reset");
    expect((await send("charge.dispute.created", "needs_response")).status).toBe(503);
    expect(db.tables.bookings[0].status).toBeNull();
    expect((await send("charge.dispute.created", "needs_response")).status).toBe(200);
    expect(db.tables.bookings[0].status).toBe("disputed");
  });

  it("updated + closed reach the ledger and the outcome email goes out once", async () => {
    await send("charge.dispute.created", "needs_response");
    expect((await send("charge.dispute.updated", "under_review")).status).toBe(200);
    expect(db.tables.disputes[0].status).toBe("under_review");
    await send("charge.dispute.updated", "lost");
    await send("charge.dispute.closed", "lost");
    expect(db.tables.disputes[0]).toMatchObject({ outcome: "lost" });
    expect(alerts.sendDisputeClosedAlert).toHaveBeenCalledTimes(1);
  });
});
