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

import { describe, it, expect, beforeEach, vi } from "vitest";
import { FakeSupabase } from "./supabase-fake";

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
        amount: 8600, // 94.00 less a 10% discount on the 80.00 subtotal
        metadata: { customerEmail: "a@b.com", discountPercent: "10" },
      })
    );

    const out = await createBooking({ source: "client", stripePaymentIntentId: PI });

    expect(out.kind).toBe("created");
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
