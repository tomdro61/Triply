/**
 * POST /api/reservations/complete — the finishing page's answer when the
 * booking is in reconciliation (launch-QA finding #8, Oct 28 2026): the page
 * must be able to say what is on the card, from Stripe's own figures, and give
 * the customer a reference. It must never say "not charged".
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

const retrieve = vi.hoisted(() => vi.fn());
const createBooking = vi.hoisted(() => vi.fn());
vi.mock("@/lib/stripe/client", () => ({ stripe: { paymentIntents: { retrieve } } }));
vi.mock("@/lib/booking/create-booking", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/booking/create-booking")>()),
  createBooking,
}));
vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: async () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }),
  }),
}));
vi.mock("@/lib/sentry", () => ({ capturePaymentError: vi.fn(), captureBookingError: vi.fn() }));

import { POST } from "../route";

const SECRET = "pi_abc_secret_xyz";
const post = (body: unknown) =>
  POST(
    new NextRequest("http://localhost/api/reservations/complete", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    })
  );

const pi = (status: string, over: Record<string, unknown> = {}) => ({
  id: "pi_abc",
  client_secret: SECRET,
  status,
  amount: 2537,
  amount_capturable: status === "requires_capture" ? 2537 : 0,
  amount_received: status === "succeeded" ? 2537 : 0,
  currency: "usd",
  metadata: { customerEmail: "ada@example.com" },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  retrieve.mockResolvedValue(pi("requires_capture"));
});

describe("POST /api/reservations/complete — needs_support answer", () => {
  it("carries the reference and Stripe's amount for a hold, and never says 'not charged'", async () => {
    createBooking.mockResolvedValue({ kind: "needs_reconciliation", reason: "ResLab ambiguous failure", retryable: false });
    const res = await post({ paymentIntentId: "pi_abc", clientSecret: SECRET });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      state: "needs_support",
      reference: "pi_abc",
      amountCents: 2537,
      currency: "usd",
      charge: "hold",
    });
    expect(body.message).not.toMatch(/not (been )?charged/i);
    expect(body.message).not.toMatch(/charged twice/i);
    expect(body.message).not.toMatch(/business day/i); // no deadline the code can't enforce
  });

  it("reads the card AFTER the engine ran: a hold before, captured after → says 'captured' (review High, Oct 28)", async () => {
    retrieve.mockResolvedValueOnce(pi("requires_capture")).mockResolvedValueOnce(pi("succeeded"));
    createBooking.mockResolvedValue({ kind: "needs_reconciliation", reason: "booking insert rejected after capture", retryable: false });
    const body = await (await post({ paymentIntentId: "pi_abc", clientSecret: SECRET })).json();
    expect(body).toMatchObject({ state: "needs_support", charge: "captured", amountCents: 2537, currency: "usd" });
    expect(retrieve).toHaveBeenCalledTimes(2);
  });

  it("says nothing about the amount while the payment is still 'processing' or the second read fails", async () => {
    retrieve.mockResolvedValueOnce(pi("requires_capture")).mockResolvedValueOnce(pi("processing"));
    createBooking.mockResolvedValue({ kind: "needs_reconciliation", reason: "x", retryable: false });
    let body = await (await post({ paymentIntentId: "pi_abc", clientSecret: SECRET })).json();
    expect(body).toMatchObject({ state: "needs_support", reference: "pi_abc" });
    expect(body).not.toHaveProperty("charge");
    expect(body).not.toHaveProperty("amountCents");

    retrieve.mockResolvedValueOnce(pi("requires_capture")).mockRejectedValueOnce(new Error("stripe down"));
    body = await (await post({ paymentIntentId: "pi_abc", clientSecret: SECRET })).json();
    expect(body).toMatchObject({ state: "needs_support", reference: "pi_abc" });
    expect(body).not.toHaveProperty("charge");
  });

  it("a wrong client secret is a 404 with nothing about the payment", async () => {
    const res = await post({ paymentIntentId: "pi_abc", clientSecret: "pi_abc_secret_WRONG" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
    expect(createBooking).not.toHaveBeenCalled();
  });

  it("the other answers are unchanged: booked carries the confirmation URL, failed carries the engine's message", async () => {
    createBooking.mockResolvedValue({ kind: "already_exists", reservationNumber: "RTL1" });
    let body = await (await post({ paymentIntentId: "pi_abc", clientSecret: SECRET })).json();
    expect(body).toMatchObject({ state: "booked", reservationNumber: "RTL1" });
    expect(body.confirmationUrl).toMatch(/^\/confirmation\/RTL1\?email=/);

    createBooking.mockResolvedValue({ kind: "sold_out" });
    body = await (await post({ paymentIntentId: "pi_abc", clientSecret: SECRET })).json();
    expect(body.state).toBe("failed");
    expect(body).not.toHaveProperty("amountCents");
  });
});
