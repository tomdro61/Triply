/**
 * /api/checkout/lot POST — the EARLY once-per-customer check (migration 033).
 * It refuses before a PaymentIntent exists, so a customer who already used a
 * code never authorizes a card for it. Advisory: the race-safe claim is in
 * createBooking (see promo-once-per-customer.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { db, createPaymentIntent, getCost, captureAPIError } = await vi.hoisted(async () => {
  const { FakeSupabase } = await import("@/lib/booking/__tests__/supabase-fake");
  return {
    db: new FakeSupabase(),
    createPaymentIntent: vi.fn(),
    getCost: vi.fn(),
    captureAPIError: vi.fn(),
  };
});

vi.mock("@/lib/supabase/server", () => ({ createAdminClient: async () => db }));
vi.mock("@/lib/stripe/client", () => ({ createPaymentIntent }));
vi.mock("@/lib/reslab/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/reslab/client")>("@/lib/reslab/client");
  return { reslab: { getCost }, ReslabError: actual.ReslabError };
});
vi.mock("@/lib/reslab/get-lot", () => ({ getLotById: vi.fn() }));
vi.mock("@/lib/sentry", () => ({
  captureAPIError,
  capturePaymentError: vi.fn(),
  captureBookingError: vi.fn(),
}));

import { POST } from "../route";

function post(over: Record<string, unknown> = {}) {
  return new NextRequest("https://www.triplypro.com/api/checkout/lot", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      lotId: "lot-1",
      locationId: 42,
      checkin: "2026-10-01",
      checkout: "2026-10-05",
      checkinTime: "10:00 AM",
      checkoutTime: "2:00 PM",
      parkingTypeId: 7,
      customerEmail: "Ada@Example.com",
      promoCode: "welcome10",
      protectionPlanCode: null,
      ...over,
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  db.clearFailures();
  db.tables = {
    promo_codes: [
      {
        id: "p1",
        code: "WELCOME10",
        discount_percent: 10,
        active: true,
        expires_at: null,
        max_uses: null,
        current_uses: 1,
        once_per_customer: true,
      },
    ],
    promo_redemptions: [],
    pending_bookings: [],
  };
  getCost.mockResolvedValue({
    costs_token: "tok",
    reservation: { sold_out: false, sub_total: 80, fees_total: 3, tax_total: 5, grand_total: 88, due_at_location: 20 },
  });
  createPaymentIntent.mockResolvedValue({ id: "pi_new", client_secret: "cs" });
});

function seedUsed(email_lower: string) {
  db.tables.promo_redemptions.push({
    id: "r1",
    promo_code_id: "p1",
    code: "WELCOME10",
    email_lower,
    stripe_payment_intent_id: "pi_first",
    livemode: false,
    released_at: null,
  });
  db.tables.pending_bookings.push({ stripe_payment_intent_id: "pi_first", status: "completed" });
}

describe("POST /api/checkout/lot — once-per-customer early check", () => {
  it("refuses with 409 and the clear message BEFORE any PaymentIntent is created (email matched case-insensitively)", async () => {
    seedUsed("ada@example.com");

    const res = await POST(post());
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toMatch(/^This code has already been used with this email/);
    expect(json.code).toBe("promo_already_used");
    expect(createPaymentIntent).not.toHaveBeenCalled();
  });

  it("a first-time email gets the discount", async () => {
    seedUsed("someone.else@example.com");

    const res = await POST(post());
    expect(res.status).toBe(200);
    expect((await res.json()).discountPercent).toBe(10);
    expect(createPaymentIntent).toHaveBeenCalledTimes(1);
  });

  it("a redemption lookup fault is reported and falls through to the authoritative check (no silent verdict)", async () => {
    db.failOnce("promo_redemptions", "select", "connection reset", "08006");

    const res = await POST(post());
    expect(res.status).toBe(200);
    expect(captureAPIError).toHaveBeenCalledTimes(1);
    expect(createPaymentIntent).toHaveBeenCalledTimes(1);
  });
});
