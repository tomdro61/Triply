/**
 * A Stripe payment that did not come from checkout — a Payment Link sent to a
 * customer for a date change, a dashboard charge — hits the same webhook as a
 * booking. It has no `lotId` metadata and no staged pending row. The webhook
 * must acknowledge it (200), record it at info level, and NOT run the booking
 * engine on it (which raised "cannot fulfil without a payload" as an error —
 * TRIPLY-24, a $4.74 Payment Link). A real checkout PaymentIntent that merely
 * lost its metadata still fulfils, because its pending row exists.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";

const { db, constructEvent, retrievePi, sentry, createBooking } = await vi.hoisted(async () => {
  const { FakeSupabase } = await import("@/lib/booking/__tests__/supabase-fake");
  return {
    db: new FakeSupabase(),
    constructEvent: vi.fn(),
    retrievePi: vi.fn(),
    sentry: {
      capturePaymentError: vi.fn(),
      captureParkGuardError: vi.fn(),
      captureAPIError: vi.fn(),
      captureNonCheckoutPayment: vi.fn(),
    },
    createBooking: vi.fn(async () => ({ kind: "created" })),
  };
});

vi.mock("@/lib/supabase/server", () => ({ createAdminClient: async () => db }));
vi.mock("@/lib/stripe/client", () => ({ stripe: { webhooks: { constructEvent }, paymentIntents: { retrieve: retrievePi } } }));
vi.mock("@/lib/sentry", () => sentry);
// The lot-facing notice (4b plan §3.4) has its own tests (direct/lot-notice);
// here it is a recorded call, never a network or DB side effect.
const lotNotice = vi.hoisted(() => ({ sendLotCancelNotice: vi.fn(async () => "not_claimed"), sendLotBookingNotice: vi.fn(async () => "not_claimed") }));
vi.mock("@/lib/direct/lot-notice", () => lotNotice);
vi.mock("@/lib/parkguard/client", () => ({
  parkGuard: { updateReservation: vi.fn() },
  ParkGuardError: class extends Error {},
}));
vi.mock("@/lib/booking/create-booking", () => ({
  createBooking,
  shouldStripeRedeliver: vi.fn(() => false),
}));

import { POST } from "../route";
import { shouldStripeRedeliver } from "@/lib/booking/create-booking";

const req = () =>
  new NextRequest("https://x.test/api/webhooks/stripe", {
    method: "POST",
    body: "{}",
    headers: { "stripe-signature": "sig" },
  });

const succeeded = (metadata: Record<string, string>) => ({
  type: "payment_intent.succeeded",
  data: { object: { id: "pi_link", amount: 474, metadata } },
});

beforeEach(() => {
  db.clearFailures();
  db.tables.bookings = [];
  db.tables.pending_bookings = [];
  db.log = [];
  constructEvent.mockReset();
  createBooking.mockClear();
  for (const m of Object.values(sentry)) m.mockReset();
});

describe("webhook — payments that did not come from checkout", () => {
  it("a Payment Link payment (no lotId, no pending row) → 200, info event, engine NOT run", async () => {
    constructEvent.mockReturnValue(succeeded({}));
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(createBooking).not.toHaveBeenCalled();
    expect(sentry.capturePaymentError).not.toHaveBeenCalled();
    expect(sentry.captureNonCheckoutPayment).toHaveBeenCalledTimes(1);
    expect(sentry.captureNonCheckoutPayment).toHaveBeenCalledWith({
      stripePaymentIntentId: "pi_link",
      amount: 4.74,
      eventType: "payment_intent.succeeded",
    });
  });

  it("a checkout PaymentIntent (lotId stamped) still runs the engine", async () => {
    constructEvent.mockReturnValue(succeeded({ lotId: "reslab-277", locationId: "277" }));
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(createBooking).toHaveBeenCalledTimes(1);
    expect(sentry.captureNonCheckoutPayment).not.toHaveBeenCalled();
  });

  it("no lotId but a staged pending row exists → still fulfils (a stamping bug can't strand a booking)", async () => {
    db.tables.pending_bookings = [{ stripe_payment_intent_id: "pi_link", status: "pending" }];
    constructEvent.mockReturnValue(succeeded({}));
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(createBooking).toHaveBeenCalledTimes(1);
    expect(sentry.captureNonCheckoutPayment).not.toHaveBeenCalled();
  });

  it("the pending lookup failing is retried, never classified as non-checkout", async () => {
    db.failOnce("pending_bookings", "select", "connection reset");
    constructEvent.mockReturnValue(succeeded({}));
    const res = await POST(req());
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(createBooking).not.toHaveBeenCalled();
    expect(sentry.captureNonCheckoutPayment).not.toHaveBeenCalled();
    expect(sentry.capturePaymentError).toHaveBeenCalledTimes(1);
  });
});

describe("webhook — checkout detection is belt-and-braces", () => {
  it("a PaymentIntent with customerEmail but no lotId is still treated as a checkout (engine runs)", async () => {
    constructEvent.mockReturnValue(succeeded({ customerEmail: "v@example.com" }));
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(createBooking).toHaveBeenCalledTimes(1);
    expect(sentry.captureNonCheckoutPayment).not.toHaveBeenCalled();
  });
});

describe("webhook — payment_intent.payment_failed (declined card, 2026-10-11)", () => {
  const failed = () => ({
    type: "payment_intent.payment_failed",
    data: { object: { id: "pi_link", amount: 9400, metadata: { lotId: "reslab-42" }, last_payment_error: { message: "Your card was declined." } } },
  });

  beforeEach(() => retrievePi.mockReset().mockResolvedValue({ id: "pi_link", status: "requires_payment_method" }));

  it("marks a staged (`pending`) row failed and releases its cart claim", async () => {
    db.tables.pending_bookings = [{ stripe_payment_intent_id: "pi_link", status: "pending", reslab_reservation_number: null }];
    db.tables.cart_claims = [{ id: "c1", cart_key: "k", stripe_payment_intent_id: "pi_link", released_at: null }];
    constructEvent.mockReturnValue(failed());
    expect((await POST(req())).status).toBe(200);
    expect(db.tables.pending_bookings[0]).toMatchObject({ status: "failed", last_error: "PaymentIntent failed: Your card was declined." });
    expect(db.tables.cart_claims[0].released_at).toBeTruthy();
  });

  it("an event for a row a fulfilment holds (`processing`) changes nothing and asks Stripe to redeliver", async () => {
    db.tables.pending_bookings = [{ stripe_payment_intent_id: "pi_link", status: "processing", claimed_at: new Date().toISOString(), reslab_reservation_number: null }];
    db.tables.cart_claims = [{ id: "c1", cart_key: "k", stripe_payment_intent_id: "pi_link", released_at: null }];
    constructEvent.mockReturnValue(failed());
    expect((await POST(req())).status).toBeGreaterThanOrEqual(500);
    expect(db.tables.pending_bookings[0].status).toBe("processing");
    expect(db.tables.cart_claims[0].released_at).toBeNull();
    expect(sentry.capturePaymentError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/fulfilment holds the row/) }),
      expect.anything()
    );
  });
});

describe("webhook — payment_failed never releases a cart claim a caller took meanwhile", () => {
  it("a row read as `pending` but claimed before the update keeps its cart claim", async () => {
    retrievePi.mockReset().mockResolvedValue({ id: "pi_link", status: "requires_payment_method" });
    db.tables.pending_bookings = [{ stripe_payment_intent_id: "pi_link", status: "pending", reslab_reservation_number: null }];
    db.tables.cart_claims = [{ id: "c1", cart_key: "k", stripe_payment_intent_id: "pi_link", released_at: null }];
    // The update finds the row already claimed (a caller won the race).
    db.failWhen("pending_bookings", "update", (p) => {
      if (p?.status === "failed") db.tables.pending_bookings[0].status = "processing";
      return false;
    }, "unused");
    constructEvent.mockReturnValue({
      type: "payment_intent.payment_failed",
      data: { object: { id: "pi_link", amount: 9400, metadata: { lotId: "reslab-42" }, last_payment_error: { message: "declined" } } },
    });
    expect((await POST(req())).status).toBe(200);
    expect(db.tables.pending_bookings[0].status).toBe("processing");
    expect(db.tables.cart_claims[0].released_at).toBeNull();
  });
});

describe("webhook — a STALE payment_failed (the retry on the same payment succeeded)", () => {
  const failed = () => ({
    type: "payment_intent.payment_failed",
    data: { object: { id: "pi_link", amount: 9400, metadata: { lotId: "reslab-42" }, last_payment_error: { message: "Your card was declined." } } },
  });

  it.each(["requires_capture", "succeeded", "processing"])("live PaymentIntent %s → nothing is written: booking, pending row and cart claim untouched", async (status) => {
    retrievePi.mockReset().mockResolvedValue({ id: "pi_link", status });
    db.tables.bookings = [{ id: "b1", stripe_payment_intent_id: "pi_link", status: "confirmed" }];
    db.tables.pending_bookings = [{ stripe_payment_intent_id: "pi_link", status: "pending", reslab_reservation_number: "RTL900" }];
    db.tables.cart_claims = [{ id: "c1", cart_key: "k", stripe_payment_intent_id: "pi_link", released_at: null }];
    constructEvent.mockReturnValue(failed());
    db.log = [];
    expect((await POST(req())).status).toBe(200);
    expect(db.tables.bookings[0].status).toBe("confirmed");
    expect(db.tables.pending_bookings[0].status).toBe("pending");
    expect(db.tables.cart_claims[0].released_at).toBeNull();
    expect(db.log.some((l) => l.op === "update")).toBe(false);
    // and never the "release the spot manually" instruction for a paid reservation
    expect(String(sentry.capturePaymentError.mock.calls.map((c) => String(c[0])).join(" | "))).not.toMatch(/release the spot/);
  });

  it("the live PaymentIntent cannot be read → retry (503), nothing written", async () => {
    retrievePi.mockReset().mockRejectedValue(new Error("stripe 500"));
    db.tables.pending_bookings = [{ stripe_payment_intent_id: "pi_link", status: "pending", reslab_reservation_number: null }];
    constructEvent.mockReturnValue(failed());
    expect((await POST(req())).status).toBeGreaterThanOrEqual(500);
    expect(db.tables.pending_bookings[0].status).toBe("pending");
  });
});

describe("webhook — a booking that already exists (4b plan §9 H-B)", () => {
  it("an existing confirmed DIRECT booking is re-driven through the engine (outstanding lot notice / email)", async () => {
    db.tables.bookings = [{ id: "b1", stripe_payment_intent_id: "pi_link", status: "confirmed", inventory_source: "direct" }];
    constructEvent.mockReturnValue(succeeded({ lotId: "direct-1", inventorySource: "direct" }));
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(createBooking).toHaveBeenCalledWith({ source: "webhook", stripePaymentIntentId: "pi_link" });
  });

  it("an existing ResLab booking is NOT re-driven (unchanged)", async () => {
    db.tables.bookings = [{ id: "b1", stripe_payment_intent_id: "pi_link", status: "confirmed", inventory_source: "reslab" }];
    constructEvent.mockReturnValue(succeeded({ lotId: "reslab-277" }));
    await POST(req());
    expect(createBooking).not.toHaveBeenCalled();
  });

  describe("the engine's answer decides the HTTP status (real shouldStripeRedeliver)", () => {
    beforeEach(async () => {
      const actual = await vi.importActual<typeof import("@/lib/booking/create-booking")>("@/lib/booking/create-booking");
      vi.mocked(shouldStripeRedeliver).mockImplementation(actual.shouldStripeRedeliver);
    });
    afterEach(() => {
      vi.mocked(shouldStripeRedeliver).mockImplementation(() => false);
      createBooking.mockImplementation(async () => ({ kind: "created" }));
    });

    const seedDirect = () => {
      db.tables.bookings = [{ id: "b1", stripe_payment_intent_id: "pi_link", status: "confirmed", inventory_source: "direct" }];
      constructEvent.mockReturnValue(succeeded({ lotId: "direct-1", inventorySource: "direct" }));
    };

    it("in_progress (the main path is still sending the notices) → a retryable 5xx so Stripe redelivers", async () => {
      seedDirect();
      createBooking.mockImplementation(async () => ({ kind: "in_progress" }));
      const res = await POST(req());
      expect(res.status).toBeGreaterThanOrEqual(500);
      expect(await res.json()).toMatchObject({ received: true, retry: true });
      expect(createBooking).toHaveBeenCalledTimes(1);
    });

    it("already_exists → 200, no redelivery", async () => {
      seedDirect();
      createBooking.mockImplementation(async () => ({ kind: "already_exists", reservationNumber: "TRP-AB12CD34" }));
      const res = await POST(req());
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ received: true });
      expect(createBooking).toHaveBeenCalledTimes(1);
    });
  });

  it("a cancelled direct booking is not re-driven (no notices for a booking the lot must not expect)", async () => {
    db.tables.bookings = [{ id: "b1", stripe_payment_intent_id: "pi_link", status: "refunded", inventory_source: "direct" }];
    constructEvent.mockReturnValue(succeeded({ lotId: "direct-1" }));
    await POST(req());
    expect(createBooking).not.toHaveBeenCalled();
  });
});
