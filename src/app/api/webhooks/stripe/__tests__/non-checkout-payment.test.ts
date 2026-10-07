/**
 * A Stripe payment that did not come from checkout — a Payment Link sent to a
 * customer for a date change, a dashboard charge — hits the same webhook as a
 * booking. It has no `lotId` metadata and no staged pending row. The webhook
 * must acknowledge it (200), record it at info level, and NOT run the booking
 * engine on it (which raised "cannot fulfil without a payload" as an error —
 * TRIPLY-24, a $4.74 Payment Link). A real checkout PaymentIntent that merely
 * lost its metadata still fulfils, because its pending row exists.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

const { db, constructEvent, sentry, createBooking } = await vi.hoisted(async () => {
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
    createBooking: vi.fn(async () => ({ kind: "created" })),
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
  createBooking,
  shouldStripeRedeliver: vi.fn(() => false),
}));

import { POST } from "../route";

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
