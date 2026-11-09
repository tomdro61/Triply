/**
 * POST /api/reservations — the signed booking key for the confirmation page.
 * Returned only for a booking that exists, and only when the request proves it
 * paid: the x-payment-client-secret header must be THIS PaymentIntent's client
 * secret (the route names the reservation to anyone holding the bare pi_ id).
 * Without a key the booking answer is unchanged.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";

const createBooking = vi.hoisted(() => vi.fn());
const retrieve = vi.hoisted(() => vi.fn());
const sentry = vi.hoisted(() => ({ capturePaymentError: vi.fn(), captureBookingError: vi.fn() }));
vi.mock("@/lib/booking/create-booking", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/booking/create-booking")>()),
  createBooking,
}));
vi.mock("@/lib/booking/customer-link", () => ({
  sessionIdentityFromRequest: vi.fn(async () => ({ identity: null, reason: "guest" })),
}));
vi.mock("@/lib/stripe/client", () => ({ stripe: { paymentIntents: { retrieve } } }));
vi.mock("@/lib/sentry", () => sentry);

import { POST } from "../route";
import { bookingKey } from "@/lib/confirmation/booking-key";
import { CLIENT_SECRET_CHECK_TIMEOUT_MS } from "@/lib/stripe/client-secret";

const SECRET = "pi_direct_secret_s3cr3t";
const TRP = "TRP-AAAA1111";
const body = {
  inventorySource: "direct",
  lotId: "direct-1",
  fromDate: "2026-11-20 10:00:00",
  toDate: "2026-11-25 10:00:00",
  customer: { firstName: "Ada", lastName: "L", email: "ada@example.com", phone: "555" },
  vehicle: { make: "Ford", model: "F-150", color: "Black", licensePlate: "ABC", state: "NY" },
  userId: null,
  stripePaymentIntentId: "pi_direct",
  protectionPlanCode: null,
  vehicleSize: "none",
  vehicleSizeSource: "modal",
};
const post = (secretHeader?: string) =>
  POST(
    new NextRequest("http://localhost/api/reservations", {
      method: "POST",
      body: JSON.stringify(body),
      headers: {
        "content-type": "application/json",
        ...(secretHeader !== undefined ? { "x-payment-client-secret": secretHeader } : {}),
      },
    })
  );

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("BOOKING_LINK_SIGNING_SECRET", "test-secret-one");
  createBooking.mockResolvedValue({ kind: "created", reservationNumber: TRP, reservation: { reservationNumber: TRP } });
  retrieve.mockResolvedValue({ id: "pi_direct", client_secret: SECRET });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("POST /api/reservations — the hand-off key", () => {
  it("created + this PaymentIntent's client secret → the booking key, from one bounded, no-retry Stripe read", async () => {
    const res = await post(SECRET);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, reservation: { reservationNumber: TRP }, bookingKey: bookingKey(TRP) });
    expect(retrieve).toHaveBeenCalledTimes(1);
    expect(retrieve).toHaveBeenCalledWith("pi_direct", {}, { timeout: 3000, maxNetworkRetries: 0 });
  });

  it("already_exists (a replay) gets the key too", async () => {
    createBooking.mockResolvedValue({ kind: "already_exists", reservationNumber: TRP });
    expect(await (await post(SECRET)).json()).toEqual({
      success: true,
      reservation: { reservationNumber: TRP },
      bookingKey: bookingKey(TRP),
    });
  });

  it("no header (an older checkout page) → no key and no Stripe read; the answer is today's", async () => {
    expect(await (await post()).json()).toEqual({ success: true, reservation: { reservationNumber: TRP } });
    expect(retrieve).not.toHaveBeenCalled();
    expect(sentry.captureBookingError).not.toHaveBeenCalled();
  });

  it("a bare pi_ id or someone else's secret is not proof → no key, a warning, the answer unchanged", async () => {
    for (const given of ["pi_direct", "pi_direct_secret_wrong", "pi_other_secret_s3cr3t"]) {
      sentry.captureBookingError.mockClear();
      const res = await post(given);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true, reservation: { reservationNumber: TRP } });
      expect(sentry.captureBookingError).toHaveBeenCalledTimes(1);
      const [err, ctx] = sentry.captureBookingError.mock.calls[0];
      // Never the value that was sent.
      expect(String(err.message)).not.toMatch(/_secret_/);
      expect(ctx).toMatchObject({ step: "checkout", level: "warning", fingerprint: ["handoff-secret", "mismatch"] });
    }
  });

  it("a PaymentIntent with no client secret never matches", async () => {
    retrieve.mockResolvedValue({ id: "pi_direct", client_secret: null });
    expect(await (await post(SECRET)).json()).not.toHaveProperty("bookingKey");
  });

  it("Stripe failing or slow → no key, the booking answer unchanged (a booking never fails over its key)", async () => {
    retrieve.mockRejectedValue(new Error("Stripe connection error"));
    let res = await post(SECRET);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, reservation: { reservationNumber: TRP } });
    expect(sentry.captureBookingError.mock.calls[0][1]).toMatchObject({ fingerprint: ["handoff-secret", "unknown"] });

    vi.useFakeTimers();
    retrieve.mockReturnValue(new Promise(() => {}));
    const pending = post(SECRET);
    await vi.advanceTimersByTimeAsync(CLIENT_SECRET_CHECK_TIMEOUT_MS + 600);
    res = await pending;
    expect(res.status).toBe(200);
    expect(await res.json()).not.toHaveProperty("bookingKey");
  });

  it("a missing signing secret → no key and a report; the booking answer unchanged", async () => {
    vi.stubEnv("BOOKING_LINK_SIGNING_SECRET", "");
    const res = await post(SECRET);
    expect(await res.json()).toEqual({ success: true, reservation: { reservationNumber: TRP } });
    expect(sentry.captureBookingError.mock.calls[0][1]).toMatchObject({ fingerprint: ["handoff-without-key"] });
  });

  it.each([
    ["deferred", 202],
    ["in_progress", 202],
    ["sold_out", 409],
    ["needs_reconciliation", 502],
  ])("%s → no Stripe read, no key (%s)", async (kind, status) => {
    createBooking.mockResolvedValue({ kind, retryable: false });
    const res = await post(SECRET);
    expect(res.status).toBe(status);
    expect(await res.json()).not.toHaveProperty("bookingKey");
    expect(retrieve).not.toHaveBeenCalled();
  });
});
