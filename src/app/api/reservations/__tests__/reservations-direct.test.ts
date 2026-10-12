/**
 * POST /api/reservations — DIRECT branch (4b plan §3.2, §9 H-A): the body is
 * shape-checked and only its PaymentIntent id reaches the engine. The engine
 * fulfils from the staged row, never from this request.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

const createBooking = vi.hoisted(() => vi.fn());
vi.mock("@/lib/booking/create-booking", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/booking/create-booking")>()),
  createBooking,
}));
vi.mock("@/lib/booking/customer-link", () => ({
  sessionIdentityFromRequest: vi.fn(async () => ({ identity: null, reason: "guest" })),
}));
vi.mock("@/lib/sentry", () => ({ capturePaymentError: vi.fn(), captureBookingError: vi.fn() }));

import { POST } from "../route";

const directBody = (over: Record<string, unknown> = {}) => ({
  inventorySource: "direct",
  lotId: "direct-1",
  fromDate: "2026-10-20 10:00:00",
  toDate: "2026-10-25 10:00:00",
  customer: { firstName: "Ada", lastName: "L", email: "ada@example.com", phone: "555" },
  vehicle: { make: "Ford", model: "F-150", color: "Black", licensePlate: "ABC", state: "NY" },
  userId: null,
  stripePaymentIntentId: "pi_direct",
  protectionPlanCode: null,
  vehicleSize: "none",
  vehicleSizeSource: "modal",
  ...over,
});
const post = (body: unknown) =>
  POST(new NextRequest("http://localhost/api/reservations", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }));

beforeEach(() => vi.clearAllMocks());

describe("POST /api/reservations — direct", () => {
  it("passes ONLY the PaymentIntent id to the engine (no payload)", async () => {
    createBooking.mockResolvedValue({ kind: "created", reservationNumber: "TRP-AAAA1111", reservation: { reservationNumber: "TRP-AAAA1111" } });
    const res = await post(directBody());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, reservation: { reservationNumber: "TRP-AAAA1111" } });
    expect(createBooking).toHaveBeenCalledTimes(1);
    const input = createBooking.mock.calls[0][0];
    expect(input).toMatchObject({ source: "client", stripePaymentIntentId: "pi_direct" });
    expect(input).not.toHaveProperty("payload");
  });

  it.each([
    ["deferred", 202],
    ["in_progress", 202],
    ["suspected_duplicate", 409],
  ])("maps %s exactly like a ResLab outcome (%s)", async (kind, status) => {
    createBooking.mockResolvedValue({ kind });
    expect((await post(directBody())).status).toBe(status);
  });

  it("a failed direct booking returns the engine's customer message", async () => {
    createBooking.mockResolvedValue({ kind: "failed", reason: "x", userMessage: "You have not been charged." });
    const res = await post(directBody());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "You have not been charged." });
  });

  it("uses ONLY the PaymentIntent id: client money fields never reach the engine (§9 H-A)", async () => {
    await post(directBody({ grandTotal: 1, subtotal: 999 }));
    expect(createBooking).toHaveBeenCalledTimes(1);
    const call = vi.mocked(createBooking).mock.calls[0][0];
    expect(call).not.toHaveProperty("payload");
    expect(call).toMatchObject({ source: "client", stripePaymentIntentId: expect.stringMatching(/^pi_/) });
  });

  it("no usable PaymentIntent id → 400 that never echoes a validation message or says 'not charged' (the card is authorized)", async () => {
    const res = await post(directBody({ stripePaymentIntentId: undefined }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/don't pay again/);
    expect(body.error).not.toMatch(/not been charged/);
    expect(createBooking).not.toHaveBeenCalled();
  });
});
