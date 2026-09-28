/**
 * Once-per-customer promo codes (migration 033), at the AUTHORITATIVE layer:
 * createBooking step 8.5, which claims a promo_redemptions row while the card
 * is only authorized — before ResLab, before capture.
 *
 * The invariant under test: a reused code is refused by CANCELLING THE HOLD,
 * never by failing a booking whose money has moved.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { FakeSupabase } from "./supabase-fake";

const db = new FakeSupabase();

const stripeMock = {
  paymentIntents: { retrieve: vi.fn(), capture: vi.fn(), cancel: vi.fn() },
};
const capturePaymentIntent = vi.fn();
const cancelPaymentIntent = vi.fn();
const createRefund = vi.fn();
const reslabMock = {
  createReservation: vi.fn(),
  getReservation: vi.fn(),
  getCost: vi.fn(),
  getLocation: vi.fn(),
};

vi.mock("@/lib/supabase/server", () => ({ createAdminClient: async () => db }));
vi.mock("@/lib/stripe/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/stripe/client")>("@/lib/stripe/client");
  return {
    stripe: stripeMock,
    capturePaymentIntent,
    cancelPaymentIntent,
    createRefund,
    paymentIntentRefundState: actual.paymentIntentRefundState,
  };
});
vi.mock("@/lib/reslab/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/reslab/client")>("@/lib/reslab/client");
  return { reslab: reslabMock, ReslabError: actual.ReslabError, stripHtml: actual.stripHtml };
});
vi.mock("@/lib/resend/send-booking-confirmation", () => ({
  sendBookingConfirmation: vi.fn(async () => undefined),
}));
vi.mock("@/lib/resend/send-admin-booking-notification", () => ({
  sendAdminBookingNotification: vi.fn(async () => undefined),
}));
vi.mock("@/lib/parkguard/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/parkguard/client")>("@/lib/parkguard/client");
  return { ...actual, parkGuard: { captureReservation: vi.fn(), updateReservation: vi.fn() } };
});
vi.mock("@/lib/sentry", () => ({
  capturePaymentError: vi.fn(),
  captureBookingError: vi.fn(),
  captureParkGuardError: vi.fn(),
  captureAPIError: vi.fn(),
}));

const { createBooking } = await import("../create-booking");
const { ReslabError } = await import("@/lib/reslab/client");

const PI = "pi_promo_1";
const FROM = "2026-08-14 10:00:00";
const TO = "2026-08-18 14:00:00";
const PROMO_ID = "promo_welcome";

function pendingRow(over: Record<string, unknown> = {}) {
  return {
    stripe_payment_intent_id: PI,
    status: "pending",
    reslab_reservation_number: null,
    claimed_at: null,
    email_sent: false,
    livemode: false,
    location_id: 42,
    costs_token: "tok_1",
    from_date: FROM,
    to_date: TO,
    parking_type_id: 7,
    customer: { firstName: "Ada", lastName: "Lovelace", email: "Ada.Lovelace@Example.com", phone: "555-0100" },
    vehicle: { make: "Volvo", model: "XC60", color: "Blue", licensePlate: "ABC123", state: "NY" },
    extra_fields: null,
    location_name: "Lot A",
    location_address: "1 Road",
    airport_code: "JFK",
    subtotal: "80.00",
    tax_total: "5.00",
    fees_total: "3.00",
    grand_total: "88.00",
    triply_service_fee: "6.00",
    user_id: null,
    has_protection_plan: false,
    protection_plan_code: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...over,
  };
}

/** 10% off: online = 88 + 6 − 20 − 8 = 66. */
function paymentIntent(over: Record<string, unknown> = {}) {
  return {
    id: PI,
    status: "requires_capture",
    amount: 6600,
    livemode: false,
    metadata: { customerEmail: "Ada.Lovelace@Example.com", discountPercent: "10", promoCode: "welcome10" },
    latest_charge: null,
    ...over,
  };
}

function reslabReservation(num = "RTL999") {
  return {
    reservation_number: num,
    cancelled: false,
    history: [
      {
        id: 1,
        grand_total: 88,
        due_at_location_total: 20,
        subtotal: 80,
        total_tax: 5,
        total_fees: 3,
        location: { id: 42, name: "Lot A", address: "1 Road", city: "Queens", state: { code: "NY" }, zip_code: "11430" },
        dates: [],
      },
    ],
  };
}

function promoCode(over: Record<string, unknown> = {}) {
  return {
    id: PROMO_ID,
    code: "WELCOME10",
    discount_percent: 10,
    active: true,
    expires_at: null,
    max_uses: null,
    current_uses: 0,
    once_per_customer: true,
    source: "email",
    ...over,
  };
}

function claim(over: Record<string, unknown> = {}) {
  return {
    id: "red_1",
    promo_code_id: PROMO_ID,
    code: "WELCOME10",
    email_lower: "ada.lovelace@example.com",
    stripe_payment_intent_id: "pi_first_use",
    livemode: false,
    claimed_at: new Date().toISOString(),
    released_at: null,
    ...over,
  };
}

const liveClaims = () => db.tables.promo_redemptions.filter((r) => r.released_at == null);

beforeEach(() => {
  vi.clearAllMocks();
  db.clearFailures();
  db.tables = {
    pending_bookings: [],
    bookings: [],
    cart_claims: [],
    customers: [],
    promo_codes: [promoCode()],
    promo_redemptions: [],
  };
  db.log = [];
  reslabMock.getCost.mockResolvedValue({
    costs_token: "tok_2",
    reservation: { sold_out: false, sub_total: 80, fees_total: 3, tax_total: 5, grand_total: 88, due_at_location: 20 },
  });
  reslabMock.createReservation.mockResolvedValue(reslabReservation());
  reslabMock.getLocation.mockResolvedValue(undefined);
  reslabMock.getReservation.mockImplementation(async (num: string) => reslabReservation(num));
  capturePaymentIntent.mockResolvedValue({ status: "succeeded" });
  cancelPaymentIntent.mockResolvedValue({ status: "canceled" });
  createRefund.mockResolvedValue({ id: "re_1" });
});

describe("once-per-customer promo claim (createBooking step 8.5)", () => {
  it("first use: claims the redemption before ResLab and books normally", async () => {
    db.seed("pending_bookings", [pendingRow()]);
    stripeMock.paymentIntents.retrieve.mockResolvedValue(paymentIntent());

    const out = await createBooking({ source: "client", stripePaymentIntentId: PI });

    expect(out.kind).toBe("created");
    expect(liveClaims()).toHaveLength(1);
    expect(liveClaims()[0]).toMatchObject({
      promo_code_id: PROMO_ID,
      code: "WELCOME10",
      email_lower: "ada.lovelace@example.com",
      stripe_payment_intent_id: PI,
      livemode: false,
    });
    expect(db.tables.bookings[0].promo_code).toBe("WELCOME10");
  });

  it("second use by the same email is refused by cancelling the HOLD — no ResLab call, no capture, no booking", async () => {
    db.seed("promo_redemptions", [claim()]);
    db.seed("pending_bookings", [
      pendingRow(),
      pendingRow({ stripe_payment_intent_id: "pi_first_use", status: "completed", reslab_reservation_number: "RTL1" }),
    ]);
    stripeMock.paymentIntents.retrieve.mockResolvedValue(paymentIntent());

    const out = await createBooking({ source: "client", stripePaymentIntentId: PI });

    expect(out.kind).toBe("failed");
    if (out.kind === "failed") {
      expect(out.userMessage).toMatch(/This code has already been used with this email/);
      expect(out.userMessage).toMatch(/not been charged/);
    }
    expect(cancelPaymentIntent).toHaveBeenCalledWith(PI);
    expect(reslabMock.createReservation).not.toHaveBeenCalled();
    expect(capturePaymentIntent).not.toHaveBeenCalled();
    expect(db.tables.bookings).toHaveLength(0);
    const row = db.tables.pending_bookings.find((r) => r.stripe_payment_intent_id === PI);
    expect(row?.status).toBe("released_failed");
    // The cart is handed back so the customer can re-check-out without the code.
    expect(db.tables.cart_claims.filter((c) => c.released_at == null)).toHaveLength(0);
  });

  it("matches the email case-insensitively", async () => {
    // The first use was stored lowercased; this checkout typed it in mixed case.
    db.seed("promo_redemptions", [claim()]);
    db.seed("pending_bookings", [
      pendingRow({
        customer: { firstName: "Ada", lastName: "Lovelace", email: "ADA.LOVELACE@example.COM", phone: "555-0100" },
      }),
      pendingRow({ stripe_payment_intent_id: "pi_first_use", status: "completed" }),
    ]);
    stripeMock.paymentIntents.retrieve.mockResolvedValue(paymentIntent());

    const out = await createBooking({ source: "webhook", stripePaymentIntentId: PI });

    expect(out.kind).toBe("failed");
    expect(reslabMock.createReservation).not.toHaveBeenCalled();
  });

  it("RACE: two concurrent checkouts with the same code + email — exactly one books, the other's hold is cancelled", async () => {
    const PI_B = "pi_promo_2";
    db.seed("pending_bookings", [
      pendingRow(),
      // A different cart (parking type), so the cart lock does not decide it —
      // only the promo claim can.
      pendingRow({ stripe_payment_intent_id: PI_B, parking_type_id: 8 }),
    ]);
    stripeMock.paymentIntents.retrieve.mockImplementation(async (id: string) => paymentIntent({ id }));
    reslabMock.createReservation.mockImplementation(async () => reslabReservation(`RTL-${Math.random()}`));

    const [a, b] = await Promise.all([
      createBooking({ source: "client", stripePaymentIntentId: PI }),
      createBooking({ source: "webhook", stripePaymentIntentId: PI_B }),
    ]);

    const kinds = [a.kind, b.kind].sort();
    expect(kinds).toEqual(["created", "failed"]);
    expect(reslabMock.createReservation).toHaveBeenCalledTimes(1);
    expect(capturePaymentIntent).toHaveBeenCalledTimes(1);
    expect(cancelPaymentIntent).toHaveBeenCalledTimes(1);
    expect(liveClaims()).toHaveLength(1);
    expect(db.tables.bookings).toHaveLength(1);
    const winner = a.kind === "created" ? PI : PI_B;
    expect(liveClaims()[0].stripe_payment_intent_id).toBe(winner);
    expect(capturePaymentIntent).toHaveBeenCalledWith(winner);
  });

  it("a claim whose owner never booked (released) is dead: it is released and the new checkout proceeds", async () => {
    db.seed("promo_redemptions", [claim()]);
    db.seed("pending_bookings", [
      pendingRow(),
      pendingRow({ stripe_payment_intent_id: "pi_first_use", status: "released_sold_out" }),
    ]);
    stripeMock.paymentIntents.retrieve.mockResolvedValue(paymentIntent());

    const out = await createBooking({ source: "client", stripePaymentIntentId: PI });

    expect(out.kind).toBe("created");
    expect(liveClaims()).toHaveLength(1);
    expect(liveClaims()[0].stripe_payment_intent_id).toBe(PI);
  });

  it("a re-drive of the SAME PaymentIntent finds its own claim and proceeds", async () => {
    db.seed("promo_redemptions", [claim({ stripe_payment_intent_id: PI })]);
    db.seed("pending_bookings", [pendingRow()]);
    stripeMock.paymentIntents.retrieve.mockResolvedValue(paymentIntent());

    const out = await createBooking({ source: "webhook", stripePaymentIntentId: PI });

    expect(out.kind).toBe("created");
    expect(liveClaims()).toHaveLength(1);
  });

  it("releases the claim when ResLab definitively rejects (nothing charged), so the code is usable again", async () => {
    db.seed("pending_bookings", [pendingRow()]);
    stripeMock.paymentIntents.retrieve.mockResolvedValue(paymentIntent());
    reslabMock.createReservation.mockRejectedValue(
      new ReslabError(409, "API request failed: {\"message\":\"Sold out\"}")
    );

    const out = await createBooking({ source: "client", stripePaymentIntentId: PI });

    expect(out.kind).toBe("sold_out");
    expect(cancelPaymentIntent).toHaveBeenCalledWith(PI);
    expect(db.tables.promo_redemptions).toHaveLength(1);
    expect(liveClaims()).toHaveLength(0);
  });

  it("NEVER fails a booking whose money already moved (auto-captured wallet PI): proceeds and alerts", async () => {
    db.seed("promo_redemptions", [claim()]);
    db.seed("pending_bookings", [
      pendingRow(),
      pendingRow({ stripe_payment_intent_id: "pi_first_use", status: "completed" }),
    ]);
    stripeMock.paymentIntents.retrieve.mockResolvedValue(
      paymentIntent({ status: "succeeded", latest_charge: { amount_refunded: 0 } })
    );
    const { captureBookingError } = await import("@/lib/sentry");

    const out = await createBooking({ source: "client", stripePaymentIntentId: PI });

    expect(out.kind).toBe("created");
    expect(createRefund).not.toHaveBeenCalled();
    expect(cancelPaymentIntent).not.toHaveBeenCalled();
    expect(
      vi.mocked(captureBookingError).mock.calls.some(([e]) => /reused on already-captured/.test((e as Error).message))
    ).toBe(true);
  });

  it("a code with once_per_customer = false (every pre-033 code) is not limited", async () => {
    db.tables.promo_codes = [promoCode({ once_per_customer: false })];
    db.seed("promo_redemptions", [claim()]);
    db.seed("pending_bookings", [
      pendingRow(),
      pendingRow({ stripe_payment_intent_id: "pi_first_use", status: "completed" }),
    ]);
    stripeMock.paymentIntents.retrieve.mockResolvedValue(paymentIntent());

    const out = await createBooking({ source: "client", stripePaymentIntentId: PI });

    expect(out.kind).toBe("created");
    expect(db.log.some((q) => q.table === "promo_redemptions")).toBe(false);
  });

  it("a staging (test-mode) use does not consume the code for the same email in live mode", async () => {
    db.seed("promo_redemptions", [claim({ livemode: true })]);
    db.seed("pending_bookings", [
      pendingRow(),
      pendingRow({ stripe_payment_intent_id: "pi_first_use", status: "completed" }),
    ]);
    stripeMock.paymentIntents.retrieve.mockResolvedValue(paymentIntent({ livemode: false }));

    const out = await createBooking({ source: "client", stripePaymentIntentId: PI });

    expect(out.kind).toBe("created");
  });

  it("a DB fault on the claim is RETRYABLE — never read as 'used' (cancel) or 'unused' (book)", async () => {
    db.seed("pending_bookings", [pendingRow()]);
    stripeMock.paymentIntents.retrieve.mockResolvedValue(paymentIntent());
    db.failOnce("promo_redemptions", "insert", "connection reset", "08006");

    const out = await createBooking({ source: "webhook", stripePaymentIntentId: PI });

    expect(out).toMatchObject({ kind: "needs_reconciliation", retryable: true });
    expect(reslabMock.createReservation).not.toHaveBeenCalled();
    expect(cancelPaymentIntent).not.toHaveBeenCalled();
    expect(db.tables.pending_bookings[0].status).toBe("pending");
  });

  it("a missing once_per_customer column (migration 033 not applied) is retryable, not a silent default", async () => {
    const { once_per_customer: _drop, ...pre033 } = promoCode();
    db.tables.promo_codes = [pre033];
    db.seed("pending_bookings", [pendingRow()]);
    stripeMock.paymentIntents.retrieve.mockResolvedValue(paymentIntent());

    const out = await createBooking({ source: "webhook", stripePaymentIntentId: PI });

    expect(out).toMatchObject({ kind: "needs_reconciliation", retryable: true });
    expect(reslabMock.createReservation).not.toHaveBeenCalled();
  });
});
