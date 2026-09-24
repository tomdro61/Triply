/**
 * P0 tests for the booking engine.
 *
 * These encode the invariants that four review passes established. The rule they
 * all serve, stated once:
 *
 *   No path may end with money taken and no booking, or a booking with no money.
 *
 * Every case below is a specific way that was violated at some point during
 * development. They exist so the next round of fixes cannot quietly re-break
 * them — four passes each found bugs introduced by the previous pass's fixes,
 * and nothing but tests stops a fifth.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { FakeSupabase } from "./supabase-fake";
import { __setAuthUserLookupForTests } from "../customer-link";

// ---------------------------------------------------------------------------
// Mocks. ReslabError is kept REAL — classification is instanceof-based, and a
// fake class would silently reclassify every ambiguous timeout as definitive.
// ---------------------------------------------------------------------------

const db = new FakeSupabase();

const stripeMock = {
  paymentIntents: {
    retrieve: vi.fn(),
    capture: vi.fn(),
    cancel: vi.fn(),
  },
};
const capturePaymentIntent = vi.fn();
const cancelPaymentIntent = vi.fn();
const createRefund = vi.fn();

const reslabMock = {
  createReservation: vi.fn(),
  getReservation: vi.fn(),
  getCost: vi.fn(),
  // persistBooking's single fallback fetch for timezone + coordinates. Absent
  // from the mock it threw "not a function" (swallowed) and every airport test
  // would have passed with NULL, proving nothing.
  getLocation: vi.fn(),
};

vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: async () => db,
}));

vi.mock("@/lib/stripe/client", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/stripe/client")
  >("@/lib/stripe/client");
  return {
    stripe: stripeMock,
    capturePaymentIntent,
    cancelPaymentIntent,
    createRefund,
    // The refund-state predicate is pure logic worth exercising for real.
    paymentIntentRefundState: actual.paymentIntentRefundState,
  };
});

vi.mock("@/lib/reslab/client", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/reslab/client")
  >("@/lib/reslab/client");
  return { reslab: reslabMock, ReslabError: actual.ReslabError, stripHtml: actual.stripHtml };
});

vi.mock("@/lib/resend/send-booking-confirmation", () => ({
  sendBookingConfirmation: vi.fn(async () => undefined),
}));
vi.mock("@/lib/resend/send-admin-booking-notification", () => ({
  sendAdminBookingNotification: vi.fn(async () => undefined),
}));
vi.mock("@/lib/parkguard/client", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/parkguard/client")
  >("@/lib/parkguard/client");
  return { ...actual, parkGuard: { captureReservation: vi.fn(), updateReservation: vi.fn() } };
});
vi.mock("@/lib/sentry", () => ({
  capturePaymentError: vi.fn(),
  captureBookingError: vi.fn(),
  captureParkGuardError: vi.fn(),
  captureAPIError: vi.fn(),
}));

const { createBooking, PaymentNotConfirmedError, shouldStripeRedeliver } =
  await import("../create-booking");
const { ReslabError } = await import("@/lib/reslab/client");
const { parkGuard } = await import("@/lib/parkguard/client");
const { captureBookingError, capturePaymentError } = await import("@/lib/sentry");
const { sendBookingConfirmation } = await import("@/lib/resend/send-booking-confirmation");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PI = "pi_test_123";
const FROM = "2026-08-14 10:00:00";
const TO = "2026-08-18 14:00:00";

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
    customer: {
      firstName: "Ada",
      lastName: "Lovelace",
      email: "Ada.Lovelace@Example.com",
      phone: "555-0100",
    },
    vehicle: {
      make: "Volvo",
      model: "XC60",
      color: "Blue",
      licensePlate: "ABC123",
      state: "NY",
    },
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

function paymentIntent(over: Record<string, unknown> = {}) {
  return {
    id: PI,
    status: "requires_capture",
    amount: 9400,
    livemode: false,
    metadata: { customerEmail: "Ada.Lovelace@Example.com" },
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
        location: {
          id: 42,
          name: "Lot A",
          address: "1 Road",
          city: "Queens",
          state: { code: "NY" },
          zip_code: "11430",
        },
        dates: [],
      },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  db.tables = { pending_bookings: [], bookings: [], cart_claims: [], customers: [] };
  db.log = [];
  reslabMock.getCost.mockResolvedValue({
    costs_token: "tok_2",
    reservation: {
      sold_out: false,
      sub_total: 80,
      fees_total: 3,
      tax_total: 5,
      grand_total: 88,
      due_at_location: 20,
    },
  });
  reslabMock.createReservation.mockResolvedValue(reslabReservation());
  reslabMock.getLocation.mockResolvedValue(undefined);
  // Echo the requested number, as the real GET does — otherwise the resume
  // test would pass even if the engine looked up the wrong reservation.
  reslabMock.getReservation.mockImplementation(async (num: string) =>
    reslabReservation(num)
  );
  capturePaymentIntent.mockResolvedValue({ status: "succeeded" });
  cancelPaymentIntent.mockResolvedValue({ status: "canceled" });
  createRefund.mockResolvedValue({ id: "re_1" });
});

// ---------------------------------------------------------------------------

describe("the refund gate (G1)", () => {
  it("never books a PaymentIntent that already carries a refund", async () => {
    db.seed("pending_bookings", [pendingRow()]);
    stripeMock.paymentIntents.retrieve.mockResolvedValue(
      paymentIntent({
        status: "succeeded",
        latest_charge: { amount_refunded: 9400 },
      })
    );

    const out = await createBooking({ source: "webhook", stripePaymentIntentId: PI });

    expect(out.kind).toBe("already_refunded");
    expect(reslabMock.createReservation).not.toHaveBeenCalled();
    expect(capturePaymentIntent).not.toHaveBeenCalled();
  });

  it("refuses without asserting a refund happened when the state is undeterminable", async () => {
    // A succeeded PI with no charge: we cannot tell. Writing a terminal
    // `refunded_after_capture` here would permanently block a customer who
    // actually paid, on the basis of a read that failed.
    db.seed("pending_bookings", [pendingRow()]);
    stripeMock.paymentIntents.retrieve.mockResolvedValue(
      paymentIntent({ status: "succeeded", latest_charge: null })
    );

    const out = await createBooking({ source: "webhook", stripePaymentIntentId: PI });

    expect(out.kind).toBe("needs_reconciliation");
    expect(out).toMatchObject({ retryable: true });
    expect(db.tables.pending_bookings[0].status).not.toBe("refunded_after_capture");
    expect(reslabMock.createReservation).not.toHaveBeenCalled();
  });
});

describe("idempotency", () => {
  it("returns the existing reservation instead of booking twice", async () => {
    db.seed("pending_bookings", [pendingRow({ status: "processing" })]);
    db.seed("bookings", [
      { stripe_payment_intent_id: PI, reslab_reservation_number: "RTL111" },
    ]);
    stripeMock.paymentIntents.retrieve.mockResolvedValue(paymentIntent());

    const out = await createBooking({ source: "client", stripePaymentIntentId: PI });

    expect(out).toMatchObject({ kind: "already_exists", reservationNumber: "RTL111" });
    expect(reslabMock.createReservation).not.toHaveBeenCalled();
    expect(capturePaymentIntent).not.toHaveBeenCalled();
  });

  it("reports a completed row as already_exists, never as a failure", async () => {
    // Omitting this case told a paying customer whose booking WORKED that it had
    // failed, as a terminal screen with no retry.
    db.seed("pending_bookings", [
      pendingRow({ status: "completed", reslab_reservation_number: "RTL222" }),
    ]);
    stripeMock.paymentIntents.retrieve.mockResolvedValue(paymentIntent());

    const out = await createBooking({ source: "complete", stripePaymentIntentId: PI });

    expect(out).toMatchObject({ kind: "already_exists", reservationNumber: "RTL222" });
  });

  it("never fabricates an empty reservation number for a completed row", async () => {
    db.seed("pending_bookings", [
      pendingRow({ status: "completed", reslab_reservation_number: null }),
    ]);
    stripeMock.paymentIntents.retrieve.mockResolvedValue(paymentIntent());

    const out = await createBooking({ source: "complete", stripePaymentIntentId: PI });

    // `?? ""` here built /confirmation/?lot=... — a broken URL for a paid customer.
    if (out.kind === "already_exists") {
      expect(out.reservationNumber).not.toBe("");
    } else {
      expect(out.kind).toBe("needs_reconciliation");
    }
  });
});

describe("the mutex", () => {
  it("refuses to proceed while another caller holds a fresh claim", async () => {
    db.seed("pending_bookings", [
      pendingRow({ status: "processing", claimed_at: new Date().toISOString() }),
    ]);
    stripeMock.paymentIntents.retrieve.mockResolvedValue(paymentIntent());

    const out = await createBooking({ source: "webhook", stripePaymentIntentId: PI });

    expect(out.kind).toBe("in_progress");
    expect(reslabMock.createReservation).not.toHaveBeenCalled();
  });

  it("steals a claim that has gone stale, so a dead browser cannot strand a booking", async () => {
    db.seed("pending_bookings", [
      pendingRow({
        status: "processing",
        claimed_at: new Date(Date.now() - 5 * 60_000).toISOString(),
      }),
    ]);
    stripeMock.paymentIntents.retrieve.mockResolvedValue(paymentIntent());

    const out = await createBooking({ source: "webhook", stripePaymentIntentId: PI });

    expect(out.kind).toBe("created");
    expect(reslabMock.createReservation).toHaveBeenCalledTimes(1);
  });

  it("treats a database fault as retryable, never as benign contention", async () => {
    // The defect this pins: `{ data: null }` means both "no row matched" and
    // "the query failed". Reading the second as the first made a degraded DB
    // look like "someone else is working on it" while money was already gone.
    db.seed("pending_bookings", [pendingRow()]);
    stripeMock.paymentIntents.retrieve.mockResolvedValue(paymentIntent());
    db.failOnce("pending_bookings", "update", "connection reset");

    const out = await createBooking({ source: "webhook", stripePaymentIntentId: PI });

    expect(out.kind).toBe("needs_reconciliation");
    expect(out).toMatchObject({ retryable: true });
    expect(out.kind === "needs_reconciliation" && out.reason).toContain("claim");
  });
});

describe("the resume path", () => {
  it("adopts an existing reservation instead of creating a second one", async () => {
    // ResLab has no idempotency key, so re-creating here double-books a real
    // customer at a real lot.
    db.seed("pending_bookings", [
      pendingRow({
        status: "processing",
        claimed_at: new Date(Date.now() - 5 * 60_000).toISOString(),
        reslab_reservation_number: "RTL777",
      }),
    ]);
    stripeMock.paymentIntents.retrieve.mockResolvedValue(paymentIntent());

    const out = await createBooking({ source: "webhook", stripePaymentIntentId: PI });

    expect(out).toMatchObject({ kind: "created", reservationNumber: "RTL777" });
    expect(reslabMock.createReservation).not.toHaveBeenCalled();
    expect(reslabMock.getReservation).toHaveBeenCalledWith("RTL777");
  });

  it("re-fetches rather than fabricating, so due_at_location is never silently zero", async () => {
    db.seed("pending_bookings", [
      pendingRow({
        status: "processing",
        claimed_at: new Date(Date.now() - 5 * 60_000).toISOString(),
        reslab_reservation_number: "RTL777",
      }),
    ]);
    stripeMock.paymentIntents.retrieve.mockResolvedValue(paymentIntent());

    await createBooking({ source: "webhook", stripePaymentIntentId: PI });

    // The stub-cast version stored 0 here and emailed the customer "$0 due at
    // the lot" when they actually owed money on arrival.
    expect(db.tables.bookings[0].due_at_location).toBe(20);
  });

  it("stays retryable when the re-fetch fails, because a GET cannot double-book", async () => {
    db.seed("pending_bookings", [
      pendingRow({
        status: "processing",
        claimed_at: new Date(Date.now() - 5 * 60_000).toISOString(),
        reslab_reservation_number: "RTL777",
      }),
    ]);
    stripeMock.paymentIntents.retrieve.mockResolvedValue(paymentIntent());
    reslabMock.getReservation.mockRejectedValue(new ReslabError(502, "upstream"));

    const out = await createBooking({ source: "webhook", stripePaymentIntentId: PI });

    expect(out).toMatchObject({ kind: "needs_reconciliation", retryable: true });
    // Must NOT be poisoned — a later attempt has to be able to finish this.
    expect(db.tables.pending_bookings[0].status).toBe("pending");
  });
});

describe("ResLab failure classification", () => {
  it("releases the authorization on a definitive rejection", async () => {
    db.seed("pending_bookings", [pendingRow()]);
    stripeMock.paymentIntents.retrieve.mockResolvedValue(paymentIntent());
    reslabMock.createReservation.mockRejectedValue(
      new ReslabError(409, 'API request failed: {"message":"Sold out"}')
    );

    const out = await createBooking({ source: "client", stripePaymentIntentId: PI });

    expect(out.kind).toBe("sold_out");
    expect(cancelPaymentIntent).toHaveBeenCalledWith(PI);
    expect(createRefund).not.toHaveBeenCalled(); // never captured — cancel, don't refund
    expect(db.tables.bookings).toHaveLength(0);
  });

  it.each([
    ["an aborted request", Object.assign(new Error("aborted"), { name: "AbortError" })],
    ["a 5xx", new ReslabError(502, "bad gateway")],
    ["a 429", new ReslabError(429, "slow down")],
  ])("leaves the money alone on %s, because a reservation may exist", async (_label, err) => {
    db.seed("pending_bookings", [pendingRow()]);
    stripeMock.paymentIntents.retrieve.mockResolvedValue(paymentIntent());
    reslabMock.createReservation.mockRejectedValue(err);

    const out = await createBooking({ source: "client", stripePaymentIntentId: PI });

    expect(out.kind).toBe("needs_reconciliation");
    // The whole point: no cancel, no refund, and above all no retry.
    expect(cancelPaymentIntent).not.toHaveBeenCalled();
    expect(createRefund).not.toHaveBeenCalled();
    expect(reslabMock.createReservation).toHaveBeenCalledTimes(1);
  });

  it("never re-attempts a reservation once the row is needs_reconciliation", async () => {
    db.seed("pending_bookings", [pendingRow({ status: "needs_reconciliation" })]);
    stripeMock.paymentIntents.retrieve.mockResolvedValue(paymentIntent());

    const out = await createBooking({ source: "webhook", stripePaymentIntentId: PI });

    expect(out.kind).toBe("needs_reconciliation");
    expect(reslabMock.createReservation).not.toHaveBeenCalled();
  });
});

describe("capture — the moment money moves", () => {
  it("captures only after ResLab has confirmed a reservation", async () => {
    db.seed("pending_bookings", [pendingRow()]);
    stripeMock.paymentIntents.retrieve.mockResolvedValue(paymentIntent());

    const out = await createBooking({ source: "client", stripePaymentIntentId: PI });

    expect(out.kind).toBe("created");
    const order = reslabMock.createReservation.mock.invocationCallOrder[0];
    const captureOrder = capturePaymentIntent.mock.invocationCallOrder[0];
    expect(order).toBeLessThan(captureOrder);
  });

  it("defers every side effect while the payment is still settling", async () => {
    db.seed("pending_bookings", [pendingRow()]);
    stripeMock.paymentIntents.retrieve.mockResolvedValue(
      paymentIntent({ status: "processing" })
    );

    const out = await createBooking({ source: "client", stripePaymentIntentId: PI });

    expect(out.kind).toBe("deferred");
    // Creating the reservation here made a billable commitment before the money
    // was known to arrive, and payment_failed could not release it.
    expect(reslabMock.createReservation).not.toHaveBeenCalled();
    expect(capturePaymentIntent).not.toHaveBeenCalled();
    expect(db.tables.bookings).toHaveLength(0);
    // The mutex is handed back so the settle-time re-drive isn't stalled 90s.
    expect(db.tables.pending_bookings[0].status).toBe("pending");
    // ...but the cart stays claimed, so a retry can't book the same cart.
    expect(db.tables.cart_claims.filter((c) => c.released_at == null)).toHaveLength(1);
  });

  it("does not roll back when a capture error turns out to have captured", async () => {
    // Stripe can capture and then drop the HTTP response. Rolling back here
    // deletes a booking the customer has already paid for.
    db.seed("pending_bookings", [pendingRow()]);
    stripeMock.paymentIntents.retrieve
      .mockResolvedValueOnce(paymentIntent())
      .mockResolvedValueOnce(paymentIntent({ status: "succeeded" }));
    capturePaymentIntent.mockRejectedValue(new Error("network blip"));

    const out = await createBooking({ source: "client", stripePaymentIntentId: PI });

    expect(out.kind).toBe("created");
    expect(cancelPaymentIntent).not.toHaveBeenCalled();
    expect(createRefund).not.toHaveBeenCalled();
  });

  it("skips capture for a PaymentIntent that already succeeded", async () => {
    db.seed("pending_bookings", [pendingRow()]);
    stripeMock.paymentIntents.retrieve.mockResolvedValue(
      paymentIntent({ status: "succeeded", latest_charge: { amount_refunded: 0 } })
    );

    const out = await createBooking({ source: "client", stripePaymentIntentId: PI });

    expect(out.kind).toBe("created");
    expect(capturePaymentIntent).not.toHaveBeenCalled();
  });
});

describe("payment state", () => {
  it.each(["requires_payment_method", "requires_action", "canceled"])(
    "refuses to fulfil a PaymentIntent in %s",
    async (status) => {
      db.seed("pending_bookings", [pendingRow()]);
      stripeMock.paymentIntents.retrieve.mockResolvedValue(paymentIntent({ status }));

      await expect(
        createBooking({ source: "client", stripePaymentIntentId: PI })
      ).rejects.toBeInstanceOf(PaymentNotConfirmedError);
      expect(reslabMock.createReservation).not.toHaveBeenCalled();
    }
  );
});

describe("price integrity", () => {
  it("refuses to book above the authorized amount", async () => {
    db.seed("pending_bookings", [pendingRow()]);
    stripeMock.paymentIntents.retrieve.mockResolvedValue(paymentIntent({ amount: 9400 }));
    reslabMock.getCost.mockResolvedValue({
      costs_token: "tok_2",
      reservation: {
        sold_out: false,
        sub_total: 120,
        fees_total: 3,
        tax_total: 5,
        grand_total: 140,
        due_at_location: 20,
      },
    });

    const out = await createBooking({ source: "client", stripePaymentIntentId: PI });

    expect(out.kind).toBe("failed");
    expect(reslabMock.createReservation).not.toHaveBeenCalled();
    expect(cancelPaymentIntent).toHaveBeenCalled();
  });

  it("applies the promo discount, so a discounted booking is not read as price drift", async () => {
    // Without this, EVERY promo-code booking was blocked with "the price changed
    // while you were checking out".
    db.seed("pending_bookings", [pendingRow()]);
    stripeMock.paymentIntents.retrieve.mockResolvedValue(
      paymentIntent({
        // online = grand_total 88 + serviceFee 6 − due 20 − discount 8 = 66
        amount: 6600,
        metadata: { customerEmail: "a@b.com", discountPercent: "10" },
      })
    );

    const out = await createBooking({ source: "client", stripePaymentIntentId: PI });

    expect(out.kind).toBe("created");
  });

  it("records the promo code + discount, derived from the real Stripe charge (migration 016)", async () => {
    // The discount was charged by Stripe but not stored, so admin overstated
    // "Paid online". discount_amount is derived from pi.amount so it reconciles
    // to Stripe EXACTLY: pre-discount online (88+6−20 = 74) − charged (66) = 8.00.
    // promo_code stored uppercased.
    db.seed("pending_bookings", [pendingRow()]);
    stripeMock.paymentIntents.retrieve.mockResolvedValue(
      paymentIntent({
        amount: 6600,
        metadata: { customerEmail: "a@b.com", discountPercent: "10", promoCode: "save10" },
      })
    );

    const out = await createBooking({ source: "client", stripePaymentIntentId: PI });

    expect(out.kind).toBe("created");
    const booking = db.tables.bookings[0];
    expect(booking.discount_amount).toBe(8); // 74 − 66, matches Stripe exactly
    expect(booking.promo_code).toBe("SAVE10");
  });

  it("derives the discount from the charge to the CENT (not re-rounded percent×subtotal)", async () => {
    // Regression lock for the reviewed 1¢ drift. pre-discount online = 74.00;
    // Stripe actually charged 66.01, so the true discount is 7.99. A percent×
    // subtotal re-round (round(80×10)/100) would wrongly store 8.00 and understate
    // "Paid online" by a cent. Deriving from pi.amount stores exactly 7.99.
    db.seed("pending_bookings", [pendingRow()]);
    stripeMock.paymentIntents.retrieve.mockResolvedValue(
      paymentIntent({
        amount: 6601,
        metadata: { customerEmail: "a@b.com", discountPercent: "10", promoCode: "save10" },
      })
    );

    await createBooking({ source: "client", stripePaymentIntentId: PI });

    expect(db.tables.bookings[0].discount_amount).toBe(7.99);
  });

  it("stores no promo when none was applied (discount_amount defaults to 0)", async () => {
    db.seed("pending_bookings", [pendingRow()]);
    stripeMock.paymentIntents.retrieve.mockResolvedValue(paymentIntent());

    await createBooking({ source: "client", stripePaymentIntentId: PI });

    const booking = db.tables.bookings[0];
    expect(booking.discount_amount).toBe(0);
    expect(booking.promo_code ?? null).toBeNull();
  });

  it("releases the payment when the lot sold out during checkout", async () => {
    db.seed("pending_bookings", [pendingRow()]);
    stripeMock.paymentIntents.retrieve.mockResolvedValue(paymentIntent());
    reslabMock.getCost.mockResolvedValue({
      costs_token: "tok_2",
      reservation: {
        sold_out: true,
        sub_total: 80,
        fees_total: 3,
        tax_total: 5,
        grand_total: 88,
        due_at_location: 20,
      },
    });

    const out = await createBooking({ source: "client", stripePaymentIntentId: PI });

    expect(out.kind).toBe("sold_out");
    expect(cancelPaymentIntent).toHaveBeenCalled();
    expect(db.tables.bookings).toHaveLength(0);
  });
});

describe("duplicate carts", () => {
  it("refuses a concurrent PaymentIntent while another live cart_claim holds the cart", async () => {
    // Prevention lives in the cart_claims lock, NOT in a bookings-table heuristic.
    // A different PI holds a LIVE claim on this exact cart → the new PI must lose
    // and be released, never fulfilled.
    db.seed("pending_bookings", [pendingRow()]);
    db.seed("cart_claims", [
      {
        id: "cc1",
        cart_key: ["test", "ada.lovelace@example.com", 42, FROM, TO, 7].join("|"),
        stripe_payment_intent_id: "pi_concurrent_other",
        claimed_at: new Date().toISOString(),
        released_at: null,
        livemode: false,
      },
    ]);
    stripeMock.paymentIntents.retrieve.mockResolvedValue(paymentIntent());

    const out = await createBooking({ source: "client", stripePaymentIntentId: PI });

    expect(out.kind).toBe("suspected_duplicate");
    expect(reslabMock.createReservation).not.toHaveBeenCalled();
    expect(cancelPaymentIntent).toHaveBeenCalledWith(PI);
  });

  it("ALLOWS a second vehicle at the same lot and dates (there is no bookings-table auto-refund)", async () => {
    // Every reservation is number_of_spots: 1, so a family parking two cars MUST
    // check out twice with the identical email+lot+dates. A prior revision matched
    // that tuple in the bookings table and auto-refunded the second booking as a
    // duplicate — refunding real customers (and, with no livemode filter, live
    // customers from staging tests). That heuristic was removed; only a live
    // cart_claims collision blocks, and a completed prior booking released its
    // claim, so the second vehicle proceeds. Even booked the SAME instant.
    db.seed("customers", [{ id: "c1", email: "Ada.Lovelace@Example.com" }]);
    db.seed("bookings", [
      {
        customer_id: "c1",
        stripe_payment_intent_id: "pi_first_vehicle",
        reslab_reservation_number: "RTL555",
        reslab_location_id: 42,
        check_in: FROM,
        check_out: TO,
        status: "confirmed",
        created_at: new Date().toISOString(), // same day — the case that used to fail
      },
    ]);
    db.seed("pending_bookings", [pendingRow()]);
    stripeMock.paymentIntents.retrieve.mockResolvedValue(paymentIntent());

    const out = await createBooking({ source: "webhook", stripePaymentIntentId: PI });

    expect(out.kind).toBe("created");
    expect(cancelPaymentIntent).not.toHaveBeenCalled();
  });

  it("keeps staging and production carts apart on the shared database", async () => {
    db.seed("pending_bookings", [pendingRow()]);
    db.seed("cart_claims", [
      {
        id: "cc1",
        // Same cart identity, LIVE mode — must not collide with this test-mode PI.
        cart_key: ["live", "ada.lovelace@example.com", 42, FROM, TO, 7].join("|"),
        stripe_payment_intent_id: "pi_live_other",
        claimed_at: new Date().toISOString(),
        released_at: null,
        livemode: true,
      },
    ]);
    stripeMock.paymentIntents.retrieve.mockResolvedValue(
      paymentIntent({ livemode: false })
    );

    const out = await createBooking({ source: "client", stripePaymentIntentId: PI });

    expect(out.kind).toBe("created");
  });
});

describe("emails", () => {
  it("sends only on a genuinely new booking", async () => {
    const { sendBookingConfirmation } = await import(
      "@/lib/resend/send-booking-confirmation"
    );
    db.seed("pending_bookings", [pendingRow({ status: "processing" })]);
    db.seed("bookings", [
      { stripe_payment_intent_id: PI, reslab_reservation_number: "RTL111" },
    ]);
    stripeMock.paymentIntents.retrieve.mockResolvedValue(paymentIntent());

    await createBooking({ source: "webhook", stripePaymentIntentId: PI });

    expect(sendBookingConfirmation).not.toHaveBeenCalled();
  });

  it("does not re-send when the row already recorded one", async () => {
    const { sendBookingConfirmation } = await import(
      "@/lib/resend/send-booking-confirmation"
    );
    db.seed("pending_bookings", [pendingRow({ email_sent: true })]);
    stripeMock.paymentIntents.retrieve.mockResolvedValue(paymentIntent());

    const out = await createBooking({ source: "client", stripePaymentIntentId: PI });

    expect(out.kind).toBe("created");
    expect(sendBookingConfirmation).not.toHaveBeenCalled();
  });
});

describe("capture failure — reservation live, must never roll back", () => {
  it("escalates (not roll back) when re-retrieve shows the capture did NOT happen", async () => {
    db.seed("pending_bookings", [pendingRow()]);
    stripeMock.paymentIntents.retrieve
      .mockResolvedValueOnce(paymentIntent()) // step 1
      .mockResolvedValueOnce(paymentIntent()); // re-retrieve after capture throw → still requires_capture
    capturePaymentIntent.mockRejectedValue(new Error("capture network error"));

    const out = await createBooking({ source: "client", stripePaymentIntentId: PI });

    expect(out).toMatchObject({ kind: "needs_reconciliation", retryable: false });
    // The reservation exists and is unpaid — never cancel/refund it blindly.
    expect(cancelPaymentIntent).not.toHaveBeenCalled();
    expect(createRefund).not.toHaveBeenCalled();
    expect(db.tables.pending_bookings[0].status).toBe("capture_ambiguous");
  });

  it("escalates when the capture result is entirely unknown (re-retrieve fails)", async () => {
    db.seed("pending_bookings", [pendingRow()]);
    stripeMock.paymentIntents.retrieve
      .mockResolvedValueOnce(paymentIntent())
      .mockRejectedValueOnce(new Error("stripe unreachable")); // re-retrieve throws
    capturePaymentIntent.mockRejectedValue(new Error("capture network error"));

    const out = await createBooking({ source: "client", stripePaymentIntentId: PI });

    expect(out).toMatchObject({ kind: "needs_reconciliation", retryable: false });
    expect(cancelPaymentIntent).not.toHaveBeenCalled();
    expect(createRefund).not.toHaveBeenCalled();
  });
});

describe("wallet auto-capture path (PI already succeeded)", () => {
  it("REFUNDS (not cancels) when ResLab definitively rejects an already-captured PI", async () => {
    db.seed("pending_bookings", [pendingRow()]);
    stripeMock.paymentIntents.retrieve.mockResolvedValue(
      paymentIntent({ status: "succeeded", latest_charge: { amount_refunded: 0 } })
    );
    reslabMock.createReservation.mockRejectedValue(
      new ReslabError(409, 'API request failed: {"message":"Sold out"}')
    );

    const out = await createBooking({ source: "webhook", stripePaymentIntentId: PI });

    expect(out.kind).toBe("sold_out");
    // Money already moved on a wallet auto-capture → refund, never a hold-cancel.
    expect(createRefund).toHaveBeenCalledWith(PI, undefined, `refund:${PI}`);
    expect(cancelPaymentIntent).not.toHaveBeenCalled();
    expect(db.tables.pending_bookings[0].status).toBe("refunded_sold_out");
  });
});

describe("booking insert failure classification", () => {
  it("is RETRYABLE for a transient DB error after capture (self-heals on re-drive)", async () => {
    db.seed("pending_bookings", [pendingRow()]);
    stripeMock.paymentIntents.retrieve.mockResolvedValue(paymentIntent());
    db.failOnce("bookings", "insert", "connection reset");

    const out = await createBooking({ source: "webhook", stripePaymentIntentId: PI });

    expect(out).toMatchObject({ kind: "needs_reconciliation", retryable: true });
  });

  it("is NON-retryable for a Postgres constraint violation (would fail identically forever)", async () => {
    db.seed("pending_bookings", [pendingRow()]);
    stripeMock.paymentIntents.retrieve.mockResolvedValue(paymentIntent());
    // 23514 = CHECK violation — deterministic; retrying burns Stripe's budget.
    db.failOnce("bookings", "insert", "check constraint violated", "23514");

    const out = await createBooking({ source: "webhook", stripePaymentIntentId: PI });

    expect(out).toMatchObject({ kind: "needs_reconciliation", retryable: false });
  });
});

describe("shouldStripeRedeliver — the 503-vs-2xx contract", () => {
  it("asks for redelivery only where a later attempt can help", () => {
    expect(shouldStripeRedeliver({ kind: "in_progress" })).toBe(true);
    expect(shouldStripeRedeliver({ kind: "deferred" })).toBe(true);
    expect(
      shouldStripeRedeliver({ kind: "needs_reconciliation", reason: "db", retryable: true })
    ).toBe(true);
  });

  it("does NOT redeliver terminal outcomes (retrying would double-book or is pointless)", () => {
    expect(
      shouldStripeRedeliver({ kind: "needs_reconciliation", reason: "reslab", retryable: false })
    ).toBe(false);
    expect(shouldStripeRedeliver({ kind: "already_exists", reservationNumber: "R" })).toBe(false);
    expect(shouldStripeRedeliver({ kind: "already_refunded" })).toBe(false);
    expect(shouldStripeRedeliver({ kind: "sold_out" })).toBe(false);
    expect(shouldStripeRedeliver({ kind: "suspected_duplicate" })).toBe(false);
    expect(shouldStripeRedeliver({ kind: "failed", reason: "x", userMessage: "y" })).toBe(false);
  });
});

describe("Park Guard tiers (migration 021)", () => {
  // The PaymentIntent's metadata pair is what fulfilment books; the staged
  // row's tier is advisory. Fixtures carry both so each test says which wins.
  const meta = (extra: Record<string, string> = {}) => ({
    customerEmail: "Ada.Lovelace@Example.com",
    ...extra,
  });

  it("persists the tier snapshot, enrols Park Guard on the charged tier, and tells the customer the same thing (Plan B)", async () => {
    db.seed("pending_bookings", [pendingRow({ has_protection_plan: true, protection_plan_code: "B" })]);
    // 88 + 6 − 20 parking-only = 74, plus the $7.99 premium = 81.99 < the $94 hold.
    stripeMock.paymentIntents.retrieve.mockResolvedValue(
      paymentIntent({ amount: 9400, metadata: meta({ protectionPlanCode: "B", protectionPlanPrice: "7.99" }) })
    );
    vi.mocked(parkGuard.captureReservation).mockResolvedValue({ pg_identifier: "PG-B-1", message: "ok" });

    const out = await createBooking({ source: "client", stripePaymentIntentId: PI });

    expect(out.kind).toBe("created");
    const booking = db.tables.bookings[0];
    // Display name for emails/pages, code for PG, charged premium + wholesale for money.
    expect(booking.protection_plan).toBe("$500 Protection");
    expect(booking.protection_plan_code).toBe("B");
    expect(booking.protection_plan_price).toBe(7.99);
    expect(booking.protection_plan_wholesale).toBe(4);
    // Park Guard gets the contractual code for THIS tier, never the display name
    // and never Plan A by default.
    expect(parkGuard.captureReservation).toHaveBeenCalledWith(
      expect.objectContaining({ protection_plan: "Plan B", protection_plan_price: 7.99 })
    );
    // The email of record and the API response say the same tier at the same price.
    expect(sendBookingConfirmation).toHaveBeenCalledWith(
      expect.objectContaining({ protectionPlan: "$500 Protection", protectionPlanPrice: 7.99 })
    );
    expect(out.kind === "created" && out.reservation).toMatchObject({
      protectionPlan: "$500 Protection",
      protectionPlanPrice: 7.99,
    });
    expect(capturePaymentError).not.toHaveBeenCalled();
  });

  it("writes no tier columns at all on a no-protection booking", async () => {
    db.seed("pending_bookings", [pendingRow()]);
    stripeMock.paymentIntents.retrieve.mockResolvedValue(paymentIntent());

    await createBooking({ source: "client", stripePaymentIntentId: PI });

    const booking = db.tables.bookings[0];
    expect(booking.protection_plan ?? null).toBeNull();
    expect(booking.protection_plan_code ?? null).toBeNull();
    expect(booking.protection_plan_wholesale ?? null).toBeNull();
    expect(parkGuard.captureReservation).not.toHaveBeenCalled();
  });

  it("books what the PaymentIntent was charged for, not the stale row: row says C, Stripe holds A", async () => {
    // Declined card → the customer switches Plan C → Plan A → retries. The row
    // from the first attempt still says C; the hold and its metadata say A.
    db.seed("pending_bookings", [pendingRow({ has_protection_plan: true, protection_plan_code: "C" })]);
    stripeMock.paymentIntents.retrieve.mockResolvedValue(
      paymentIntent({ amount: 8699, metadata: meta({ protectionPlanCode: "A", protectionPlanPrice: "12.99" }) })
    );
    vi.mocked(parkGuard.captureReservation).mockResolvedValue({ pg_identifier: "PG-A-2", message: "ok" });

    const out = await createBooking({ source: "client", stripePaymentIntentId: PI });

    expect(out.kind).toBe("created");
    expect(db.tables.bookings[0]).toMatchObject({
      protection_plan: "$1,000 Protection",
      protection_plan_code: "A",
      protection_plan_price: 12.99,
      protection_plan_wholesale: 6,
    });
    expect(parkGuard.captureReservation).toHaveBeenCalledWith(
      expect.objectContaining({ protection_plan: "Plan A", protection_plan_price: 12.99 })
    );
    // …and the disagreement is loud, because it means a bug or a tampered request.
    expect(capturePaymentError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/tier mismatch/) }),
      expect.anything()
    );
  });

  it("does not record or enrol protection the PaymentIntent never carried, even if the row claims it", async () => {
    // Reverse direction: row says B, Stripe holds parking-only (the customer
    // dropped protection before retrying). Nothing was charged → nothing booked.
    db.seed("pending_bookings", [pendingRow({ has_protection_plan: true, protection_plan_code: "B" })]);
    stripeMock.paymentIntents.retrieve.mockResolvedValue(paymentIntent({ amount: 7400 }));

    const out = await createBooking({ source: "client", stripePaymentIntentId: PI });

    expect(out.kind).toBe("created");
    expect(db.tables.bookings[0].protection_plan ?? null).toBeNull();
    expect(parkGuard.captureReservation).not.toHaveBeenCalled();
    expect(capturePaymentError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/tier mismatch/) }),
      expect.anything()
    );
  });

  it("records the CHARGED premium, not the live retail: a pre-tier $10.99 PaymentIntent fulfils as Plan A at $10.99", async () => {
    // Staged by the pre-tier code (no tier column) on a PaymentIntent the old
    // update-pi stamped with a price only. The live Plan A retail is $12.99;
    // using it would trip the drift guard (84.99 hold < 74 + 12.99) and, on
    // the ResLab-wobble branch, record a price Stripe never took.
    db.seed("pending_bookings", [pendingRow({ has_protection_plan: true, protection_plan_code: null })]);
    stripeMock.paymentIntents.retrieve.mockResolvedValue(
      paymentIntent({ amount: 8499, metadata: meta({ protectionPlanPrice: "10.99" }) })
    );
    vi.mocked(parkGuard.captureReservation).mockResolvedValue({ pg_identifier: "PG-A-1", message: "ok" });

    const out = await createBooking({ source: "client", stripePaymentIntentId: PI });

    expect(out.kind).toBe("created");
    expect(db.tables.bookings[0]).toMatchObject({
      protection_plan_code: "A",
      protection_plan_price: 10.99,
      protection_plan_wholesale: 6,
    });
    expect(parkGuard.captureReservation).toHaveBeenCalledWith(
      expect.objectContaining({ protection_plan: "Plan A", protection_plan_price: 10.99 })
    );
    expect(sendBookingConfirmation).toHaveBeenCalledWith(
      expect.objectContaining({ protectionPlan: "$1,000 Protection", protectionPlanPrice: 10.99 })
    );
    // Both the row rule and the PI rule announce themselves so ops can count the window.
    expect(captureBookingError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/pre-tier/) }),
      expect.anything()
    );
    // Row and PI agree (both Plan A) — no mismatch alert.
    expect(capturePaymentError).not.toHaveBeenCalled();
  });

  it("refuses to fulfil a contradictory row (a tier code on a row that says no protection)", async () => {
    db.seed("pending_bookings", [pendingRow({ has_protection_plan: false, protection_plan_code: "B" })]);
    stripeMock.paymentIntents.retrieve.mockResolvedValue(paymentIntent({ amount: 9400 }));

    const out = await createBooking({ source: "client", stripePaymentIntentId: PI });

    // An unparseable staged row is terminal (needs_reconciliation): money is
    // held, nothing was booked, and a retry would fail identically.
    expect(out.kind).toBe("needs_reconciliation");
    expect(reslabMock.createReservation).not.toHaveBeenCalled();
    expect(db.tables.bookings).toHaveLength(0);
  });

  it("treats a MISSING protection_plan_code column (migration 021 not applied yet) as retryable, never terminal", async () => {
    // A dead-browser fulfilment that lands minutes before the migration must
    // be re-driven once the column exists — not retired to needs_reconciliation.
    const row: Record<string, unknown> = { ...pendingRow({ has_protection_plan: false }) };
    delete row.protection_plan_code;
    db.seed("pending_bookings", [row]);
    stripeMock.paymentIntents.retrieve.mockResolvedValue(paymentIntent());

    const out = await createBooking({ source: "webhook", stripePaymentIntentId: PI });

    expect(out.kind).toBe("needs_reconciliation");
    expect(out).toMatchObject({ retryable: true });
    expect(out.kind === "needs_reconciliation" && out.reason).toContain("migration 021");
    expect(shouldStripeRedeliver(out)).toBe(true);
    expect(reslabMock.createReservation).not.toHaveBeenCalled();
    expect(db.tables.bookings).toHaveLength(0);
  });

  it("refuses an inconsistent PaymentIntent protection pair and releases the hold", async () => {
    // A code with no price: nothing downstream may guess what was sold.
    db.seed("pending_bookings", [pendingRow({ has_protection_plan: true, protection_plan_code: "A" })]);
    stripeMock.paymentIntents.retrieve.mockResolvedValue(
      paymentIntent({ amount: 8699, metadata: meta({ protectionPlanCode: "A" }) })
    );

    const out = await createBooking({ source: "client", stripePaymentIntentId: PI });

    expect(out.kind).toBe("failed");
    expect(reslabMock.createReservation).not.toHaveBeenCalled();
    expect(cancelPaymentIntent).toHaveBeenCalled();
    expect(db.tables.bookings).toHaveLength(0);
  });

  it("counts the charged premium in the price-drift guard (a parking price rise still blocks a tier booking)", async () => {
    db.seed("pending_bookings", [pendingRow({ has_protection_plan: true, protection_plan_code: "A" })]);
    stripeMock.paymentIntents.retrieve.mockResolvedValue(
      paymentIntent({ amount: 8699, metadata: meta({ protectionPlanCode: "A", protectionPlanPrice: "12.99" }) })
    );
    // Parking rose from 88 to 140 since authorization: fresh = 140 + 6 − 20 + 12.99 > 86.99.
    reslabMock.getCost.mockResolvedValue({
      costs_token: "tok_2",
      reservation: { sold_out: false, sub_total: 120, fees_total: 3, tax_total: 5, grand_total: 140, due_at_location: 20 },
    });

    const out = await createBooking({ source: "client", stripePaymentIntentId: PI });

    expect(out.kind).toBe("failed");
    expect(reslabMock.createReservation).not.toHaveBeenCalled();
    expect(cancelPaymentIntent).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Attribution + derived airport (migration 023)
// ---------------------------------------------------------------------------

describe("attribution (migration 023)", () => {
  const ATTR = {
    v: 1 as const,
    first: { src: "google", med: "cpc", click: "gclid:x", land: "/new-york-jfk/airport-parking", at: 1 },
    apt: "JFK",
  };
  // PARK AC JFK — ~2 mi from JFK. Strings, as ResLab returns them.
  const LOT_JFK = { id: 42, latitude: "40.6675", longitude: "-73.7845", timezone: { code: "America/New_York" } };

  function clientPayload() {
    const r = pendingRow();
    return {
      locationId: r.location_id,
      costsToken: r.costs_token,
      fromDate: r.from_date,
      toDate: r.to_date,
      parkingTypeId: r.parking_type_id,
      customer: r.customer,
      vehicle: r.vehicle,
      locationName: r.location_name,
      locationAddress: r.location_address,
      airportCode: "RESLAB",
      subtotal: 80,
      taxTotal: 5,
      feesTotal: 3,
      grandTotal: 88,
      triplyServiceFee: 6,
      userId: null,
      stripePaymentIntentId: PI,
      protectionPlanCode: null,
    };
  }

  it("a webhook fulfilment from a staged row carries attribution, channel and a derived airport", async () => {
    // THE regression this pins: attribution rides OUTSIDE BookingPayload. Inside
    // it, reservationSchema would strip it on every dead-browser path.
    db.seed("pending_bookings", [pendingRow({ attribution: ATTR })]);
    stripeMock.paymentIntents.retrieve.mockResolvedValue(paymentIntent());
    reslabMock.getLocation.mockResolvedValue(LOT_JFK);

    const out = await createBooking({ source: "webhook", stripePaymentIntentId: PI });

    expect(out.kind).toBe("created");
    const b = db.tables.bookings[0];
    expect(b.attribution).toEqual(ATTR);
    expect(b.channel).toBe("paid_search");
    // Derived from the lot's coordinates — never the client's "RESLAB".
    expect(b.airport_code).toBe("JFK");
    // ONE fetch serves timezone AND coordinates (the fixture's embedded
    // location carries neither) — never the shared location-list sweep.
    expect(reslabMock.getLocation).toHaveBeenCalledTimes(1);
    expect(b.location_timezone).toBe("America/New_York");
  });

  it("no cookie: NULL attribution and channel; airport still derived; booking succeeds", async () => {
    db.seed("pending_bookings", [pendingRow()]);
    stripeMock.paymentIntents.retrieve.mockResolvedValue(paymentIntent());
    reslabMock.getLocation.mockResolvedValue(LOT_JFK);

    const out = await createBooking({ source: "webhook", stripePaymentIntentId: PI });

    expect(out.kind).toBe("created");
    const b = db.tables.bookings[0];
    expect(b.attribution).toBeNull();
    expect(b.channel).toBeNull();
    expect(b.airport_code).toBe("JFK");
  });

  it("the client route cookie is the fallback for a row staged without attribution", async () => {
    db.seed("pending_bookings", [pendingRow()]);
    stripeMock.paymentIntents.retrieve.mockResolvedValue(paymentIntent());
    reslabMock.getLocation.mockResolvedValue(LOT_JFK);

    const out = await createBooking({
      source: "client",
      stripePaymentIntentId: PI,
      payload: clientPayload(),
      attribution: ATTR,
    });

    expect(out.kind).toBe("created");
    expect(db.tables.bookings[0].attribution).toEqual(ATTR);
    expect(db.tables.bookings[0].channel).toBe("paid_search");
  });

  it("the ROW wins over the client cookie when both exist", async () => {
    const rowAttr = { ...ATTR, first: { src: "newsletter", med: "email", land: "/", at: 1 } };
    db.seed("pending_bookings", [pendingRow({ attribution: rowAttr })]);
    stripeMock.paymentIntents.retrieve.mockResolvedValue(paymentIntent());

    const out = await createBooking({
      source: "client",
      stripePaymentIntentId: PI,
      payload: clientPayload(),
      attribution: ATTR,
    });

    expect(out.kind).toBe("created");
    expect(db.tables.bookings[0].channel).toBe("email");
  });

  it("the embedded reservation location coordinates are used with NO extra fetch", async () => {
    db.seed("pending_bookings", [pendingRow({ attribution: ATTR })]);
    stripeMock.paymentIntents.retrieve.mockResolvedValue(paymentIntent());
    const res = reslabReservation();
    res.history[0].location = { ...res.history[0].location, ...LOT_JFK } as unknown as typeof res.history[0]["location"];
    reslabMock.createReservation.mockResolvedValue(res);

    const out = await createBooking({ source: "webhook", stripePaymentIntentId: PI });

    expect(out.kind).toBe("created");
    expect(db.tables.bookings[0].airport_code).toBe("JFK");
    expect(reslabMock.getLocation).not.toHaveBeenCalled();
  });

  it("the searched airport wins in a multi-airport metro; a stale one falls through to nearest", async () => {
    // A Long-Island-City hotel lot: nearer LGA, but the customer searched JFK.
    const LIC = { id: 42, latitude: "40.75", longitude: "-73.95", timezone: { code: "America/New_York" } };
    db.seed("pending_bookings", [pendingRow({ attribution: { ...ATTR, apt: "JFK" } })]);
    stripeMock.paymentIntents.retrieve.mockResolvedValue(paymentIntent());
    reslabMock.getLocation.mockResolvedValue(LIC);
    let out = await createBooking({ source: "webhook", stripePaymentIntentId: PI });
    expect(out.kind).toBe("created");
    expect(db.tables.bookings[0].airport_code).toBe("JFK");

    db.tables = { pending_bookings: [], bookings: [], cart_claims: [], customers: [] };
    db.seed("pending_bookings", [pendingRow({ attribution: { ...ATTR, apt: "BOS" } })]);
    out = await createBooking({ source: "webhook", stripePaymentIntentId: PI });
    expect(out.kind).toBe("created");
    expect(db.tables.bookings[0].airport_code).toBe("LGA");
  });

  it("an invalid-cookie marker is stored as-is with a NULL channel", async () => {
    db.seed("pending_bookings", [pendingRow({ attribution: { v: null, invalid: true } })]);
    stripeMock.paymentIntents.retrieve.mockResolvedValue(paymentIntent());

    const out = await createBooking({ source: "webhook", stripePaymentIntentId: PI });

    expect(out.kind).toBe("created");
    expect(db.tables.bookings[0].attribution).toEqual({ v: null, invalid: true });
    expect(db.tables.bookings[0].channel).toBeNull();
  });

  it("corrupt attribution JSON never fails the money-committed insert", async () => {
    // {v:1} with no `first` fails the persisted-shape parser at the row
    // boundary and is stored as the invalid marker — it never reaches the
    // classifier, and the booking is unaffected. (The classifier's own
    // try/catch is exercised by the partners-read-error test below.)
    db.seed("pending_bookings", [pendingRow({ attribution: { v: 1 } })]);
    stripeMock.paymentIntents.retrieve.mockResolvedValue(paymentIntent());
    reslabMock.getLocation.mockResolvedValue(LOT_JFK);

    const out = await createBooking({ source: "webhook", stripePaymentIntentId: PI });

    expect(out.kind).toBe("created");
    expect(db.tables.bookings).toHaveLength(1);
    expect(db.tables.bookings[0].attribution).toEqual({ v: null, invalid: true });
    expect(db.tables.bookings[0].channel).toBeNull();
    expect(db.tables.bookings[0].airport_code).toBe("JFK");
  });

  it("unresolvable coordinates: NULL airport, never a guess, booking succeeds", async () => {
    db.seed("pending_bookings", [pendingRow({ attribution: ATTR })]);
    stripeMock.paymentIntents.retrieve.mockResolvedValue(paymentIntent());
    reslabMock.getLocation.mockRejectedValue(new Error("ResLab 502"));

    const out = await createBooking({ source: "webhook", stripePaymentIntentId: PI });

    expect(out.kind).toBe("created");
    // apt is known (JFK) but unverifiable — still NULL.
    expect(db.tables.bookings[0].airport_code).toBeNull();
    expect(db.tables.bookings[0].channel).toBe("paid_search");
  });

  it("a partner tag earns the partner channel only for an ACTIVE partner", async () => {
    const tagged = { ...ATTR, first: { src: "partner-416", med: "referral", land: "/", at: 1 } };
    db.seed("partners", [{ reslab_location_id: 416, is_active: true }]);
    db.seed("pending_bookings", [pendingRow({ attribution: tagged })]);
    stripeMock.paymentIntents.retrieve.mockResolvedValue(paymentIntent());
    let out = await createBooking({ source: "webhook", stripePaymentIntentId: PI });
    expect(out.kind).toBe("created");
    expect(db.tables.bookings[0].channel).toBe("partner");

    db.tables = { pending_bookings: [], bookings: [], cart_claims: [], customers: [], partners: [] };
    db.seed("pending_bookings", [pendingRow({ attribution: tagged })]);
    out = await createBooking({ source: "webhook", stripePaymentIntentId: PI });
    expect(out.kind).toBe("created");
    expect(db.tables.bookings[0].channel).toBe("referral");
  });
});

describe("attribution (migration 023) — review pass 1 additions", () => {
  const ATTR = {
    v: 1 as const,
    first: { src: "google", med: "cpc", click: "gclid:x", land: "/new-york-jfk/airport-parking", at: 1 },
    apt: "JFK",
  };
  const LOT_JFK = { id: 42, latitude: "40.6675", longitude: "-73.7845", timezone: { code: "America/New_York" } };

  it("an INACTIVE partner does not earn partner credit (the is_active filter is load-bearing)", async () => {
    const tagged = { ...ATTR, first: { src: "partner-416", med: "referral", land: "/", at: 1 } };
    db.seed("partners", [{ reslab_location_id: 416, is_active: false }]);
    db.seed("pending_bookings", [pendingRow({ attribution: tagged })]);
    stripeMock.paymentIntents.retrieve.mockResolvedValue(paymentIntent());

    const out = await createBooking({ source: "webhook", stripePaymentIntentId: PI });

    expect(out.kind).toBe("created");
    expect(db.tables.bookings[0].channel).toBe("referral");
  });

  it("a partners-table read error leaves the channel UNKNOWN (null) and is captured — never a silent 'referral'", async () => {
    const tagged = { ...ATTR, first: { src: "partner-416", med: "referral", land: "/", at: 1 } };
    db.seed("partners", [{ reslab_location_id: 416, is_active: true }]);
    db.seed("pending_bookings", [pendingRow({ attribution: tagged })]);
    stripeMock.paymentIntents.retrieve.mockResolvedValue(paymentIntent());
    db.failOnce("partners", "select", "connection reset");

    const out = await createBooking({ source: "webhook", stripePaymentIntentId: PI });

    expect(out.kind).toBe("created");
    expect(db.tables.bookings[0].channel).toBeNull();
    expect(captureBookingError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("partners lookup failed") }),
      expect.objectContaining({ confirmationNumber: "RTL999" })
    );
  });

  it("the browser path with NO staged row writes attribution onto the pending row it self-creates", async () => {
    stripeMock.paymentIntents.retrieve.mockResolvedValue(paymentIntent());
    reslabMock.getLocation.mockResolvedValue(LOT_JFK);
    const r = pendingRow();
    const payload = {
      locationId: r.location_id, costsToken: r.costs_token, fromDate: r.from_date, toDate: r.to_date,
      parkingTypeId: r.parking_type_id, customer: r.customer, vehicle: r.vehicle,
      locationName: r.location_name, locationAddress: r.location_address, airportCode: "RESLAB",
      subtotal: 80, taxTotal: 5, feesTotal: 3, grandTotal: 88, triplyServiceFee: 6,
      userId: null, stripePaymentIntentId: PI, protectionPlanCode: null,
    };

    const out = await createBooking({ source: "client", stripePaymentIntentId: PI, payload, attribution: ATTR });

    expect(out.kind).toBe("created");
    expect(db.tables.pending_bookings[0].attribution).toEqual(ATTR);
    expect(db.tables.bookings[0].channel).toBe("paid_search");
  });

  it("a coordinate-only fetch failure never wipes a timezone the reservation already supplied", async () => {
    // Reservation carries tz but no coords → one getLocation for coords → it
    // fails → tz must survive (the self-cancel gate depends on it).
    db.seed("pending_bookings", [pendingRow({ attribution: ATTR })]);
    stripeMock.paymentIntents.retrieve.mockResolvedValue(paymentIntent());
    const res = reslabReservation();
    res.history[0].location = { ...res.history[0].location, timezone: { code: "America/New_York" } } as unknown as typeof res.history[0]["location"];
    reslabMock.createReservation.mockResolvedValue(res);
    reslabMock.getLocation.mockRejectedValue(new Error("ResLab 502"));

    const out = await createBooking({ source: "webhook", stripePaymentIntentId: PI });

    expect(out.kind).toBe("created");
    expect(db.tables.bookings[0].location_timezone).toBe("America/New_York");
    expect(db.tables.bookings[0].airport_code).toBeNull();
  });

  it("a row whose attribution JSONB does not match the persisted schema is stored as the invalid marker", async () => {
    db.seed("pending_bookings", [pendingRow({ attribution: { v: 1, first: { at: "not-a-number" } } })]);
    stripeMock.paymentIntents.retrieve.mockResolvedValue(paymentIntent());

    const out = await createBooking({ source: "webhook", stripePaymentIntentId: PI });

    expect(out.kind).toBe("created");
    expect(db.tables.bookings[0].attribution).toEqual({ v: null, invalid: true });
    expect(db.tables.bookings[0].channel).toBeNull();
  });
});


describe("customer linking at fulfilment — the account-takeover fix (2026-09-24)", () => {
  beforeEach(() => {
    db.tables = { pending_bookings: [], bookings: [], cart_claims: [], customers: [] };
    stripeMock.paymentIntents.retrieve.mockResolvedValue(paymentIntent());
  });
  afterEach(() => __setAuthUserLookupForTests(null));

  it("does NOT attach a victim's existing customer row to the booker's account when the booker's email differs (the attack)", async () => {
    db.seed("customers", [{ id: "victim", email: "Ada.Lovelace@Example.com", user_id: null }]);
    // Staged by the pending route from the ATTACKER's session; the typed email is the victim's.
    db.seed("pending_bookings", [pendingRow({ user_id: "attacker-uid" })]);
    __setAuthUserLookupForTests(async (id) =>
      id === "attacker-uid" ? { verifiedEmail: "attacker@example.com" } : null
    );

    const out = await createBooking({ source: "webhook", stripePaymentIntentId: PI });

    expect(out.kind).toBe("created");
    const victim = db.tables.customers.find((c) => c.id === "victim");
    expect(victim?.user_id).toBeNull();
    // No second row was created for the victim's email either.
    expect(db.tables.customers.filter((c) => String(c.email).toLowerCase() === "ada.lovelace@example.com")).toHaveLength(1);
  });

  it("links a guest customer row to the account whose VERIFIED email is that address (the legitimate case)", async () => {
    db.seed("customers", [{ id: "ada", email: "Ada.Lovelace@Example.com", user_id: null }]);
    db.seed("pending_bookings", [pendingRow({ user_id: "ada-uid" })]);
    __setAuthUserLookupForTests(async (id) =>
      id === "ada-uid" ? { verifiedEmail: "ada.lovelace@example.com" } : null
    );

    const out = await createBooking({ source: "webhook", stripePaymentIntentId: PI });

    expect(out.kind).toBe("created");
    expect(db.tables.customers.find((c) => c.id === "ada")?.user_id).toBe("ada-uid");
  });

  it("never overwrites a row that already belongs to a different account", async () => {
    db.seed("customers", [{ id: "ada", email: "Ada.Lovelace@Example.com", user_id: "someone-else" }]);
    db.seed("pending_bookings", [pendingRow({ user_id: "ada-uid" })]);
    __setAuthUserLookupForTests(async () => ({ verifiedEmail: "ada.lovelace@example.com" }));

    await createBooking({ source: "webhook", stripePaymentIntentId: PI });

    expect(db.tables.customers.find((c) => c.id === "ada")?.user_id).toBe("someone-else");
  });

  it("a signed-in booker using a different email gets a plain guest row for that address, not one attached to their account", async () => {
    db.seed("pending_bookings", [pendingRow({ user_id: "booker-uid" })]);
    __setAuthUserLookupForTests(async () => ({ verifiedEmail: "booker@example.com" }));

    const out = await createBooking({ source: "webhook", stripePaymentIntentId: PI });

    expect(out.kind).toBe("created");
    const row = db.tables.customers.find((c) => String(c.email).toLowerCase() === "ada.lovelace@example.com");
    expect(row).toBeDefined();
    expect(row?.user_id ?? null).toBeNull();
  });

  it("a signed-in booker's OWN row is used for a booking under someone else's email, and the other person's name/phone do not overwrite the account holder's", async () => {
    db.seed("customers", [
      { id: "booker", email: "booker@example.com", first_name: "Bo", last_name: "Oker", phone: "111", user_id: "booker-uid" },
    ]);
    db.seed("pending_bookings", [pendingRow({ user_id: "booker-uid" })]);
    const lookup = vi.fn(async () => ({ verifiedEmail: "booker@example.com" }));
    __setAuthUserLookupForTests(lookup);

    const out = await createBooking({ source: "webhook", stripePaymentIntentId: PI });

    expect(out.kind).toBe("created");
    const booker = db.tables.customers.find((c) => c.id === "booker");
    expect(booker?.first_name).toBe("Bo");
    expect(booker?.phone).toBe("111");
    expect(booker?.user_id).toBe("booker-uid");
    expect(db.tables.bookings[0].customer_id).toBe("booker");
    // Already linked → nothing the auth lookup returns can change the outcome, so it is not made.
    expect(lookup).not.toHaveBeenCalled();
  });

  it("a customers SELECT fault (not PGRST116) is reported to Sentry rather than read as 'no customer'", async () => {
    db.seed("customers", [{ id: "ada", email: "Ada.Lovelace@Example.com", user_id: "ada-uid" }]);
    db.seed("pending_bookings", [pendingRow({ user_id: "ada-uid" })]);
    db.failOnce("customers", "select", "connection reset", "08006");
    __setAuthUserLookupForTests(async () => ({ verifiedEmail: "ada.lovelace@example.com" }));

    const out = await createBooking({ source: "webhook", stripePaymentIntentId: PI });

    expect(out.kind).toBe("created");
    expect(captureBookingError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/customers lookup by user_id failed .*connection reset/) }),
      expect.objectContaining({ step: "checkout" })
    );
    // The email lookup then found the row — no duplicate customer was inserted.
    expect(db.tables.customers).toHaveLength(1);
    expect(db.tables.bookings[0].customer_id).toBe("ada");
  });

  it("duplicate customers rows (no UNIQUE on email) are NOT read as 'no customer': the oldest wins, it is reported, and no third row is inserted", async () => {
    db.seed("customers", [
      { id: "newer", email: "Ada.Lovelace@Example.com", user_id: null, created_at: "2026-09-02T00:00:00Z" },
      { id: "older", email: "Ada.Lovelace@Example.com", user_id: null, created_at: "2026-09-01T00:00:00Z" },
    ]);
    db.seed("pending_bookings", [pendingRow({ user_id: null })]);

    const out = await createBooking({ source: "webhook", stripePaymentIntentId: PI });

    expect(out.kind).toBe("created");
    expect(db.tables.customers).toHaveLength(2);
    expect(db.tables.bookings[0].customer_id).toBe("older");
    expect(captureBookingError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/2 customers rows share the same email/) }),
      expect.objectContaining({ step: "checkout" })
    );
  });

  it("a session that lapses between staging and completion does not downgrade the booking to a guest one (the staged server id wins)", async () => {
    db.seed("customers", [{ id: "ada", email: "Ada.Lovelace@Example.com", user_id: "ada-uid" }]);
    const r = pendingRow({ user_id: "ada-uid" });
    db.seed("pending_bookings", [r]);
    __setAuthUserLookupForTests(async () => ({ verifiedEmail: "ada.lovelace@example.com" }));

    // Browser path: the route could not read a session this time, so the
    // server-overwritten payload carries userId: null.
    const out = await createBooking({
      source: "client",
      stripePaymentIntentId: PI,
      payload: {
        locationId: r.location_id,
        costsToken: r.costs_token,
        fromDate: r.from_date,
        toDate: r.to_date,
        parkingTypeId: r.parking_type_id,
        customer: r.customer,
        vehicle: r.vehicle,
        locationName: r.location_name,
        locationAddress: r.location_address,
        airportCode: "RESLAB",
        subtotal: 80,
        taxTotal: 5,
        feesTotal: 3,
        grandTotal: 88,
        triplyServiceFee: 6,
        userId: null,
        stripePaymentIntentId: PI,
        protectionPlanCode: null,
      },
    });

    expect(out.kind).toBe("created");
    expect(db.tables.bookings[0].customer_id).toBe("ada");
  });
});
