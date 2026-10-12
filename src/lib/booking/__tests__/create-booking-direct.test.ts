/**
 * The booking engine fulfilling a DIRECT-lot booking (4b plan §3.2–§3.4, §5
 * A-43), on the in-memory database. The invariant is the engine's own:
 *
 *   No path may end with money taken and no booking, or a booking with no money.
 *
 * plus the direct-lot ones: our TRP- number is recorded BEFORE capture, a
 * resume never issues a second number and never touches ResLab, the money comes
 * only from the PaymentIntent's metadata, and the LOT is told (to the override
 * inbox off production) before the customer.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { FakeSupabase } from "./supabase-fake";

const db = new FakeSupabase();
const stripeMock = { paymentIntents: { retrieve: vi.fn(), capture: vi.fn(), cancel: vi.fn() } };
const capturePaymentIntent = vi.fn();
const cancelPaymentIntent = vi.fn();
const createRefund = vi.fn();
const reslabMock = { createReservation: vi.fn(), getReservation: vi.fn(), getCost: vi.fn(), getLocation: vi.fn() };
const resendSend = vi.fn();
const numbers = vi.hoisted(() => ({ queue: [] as string[] }));

vi.mock("@/lib/supabase/server", () => ({ createAdminClient: async () => db }));
vi.mock("@/lib/stripe/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/stripe/client")>("@/lib/stripe/client");
  return { stripe: stripeMock, capturePaymentIntent, cancelPaymentIntent, createRefund, paymentIntentRefundState: actual.paymentIntentRefundState };
});
vi.mock("@/lib/reslab/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/reslab/client")>("@/lib/reslab/client");
  return { reslab: reslabMock, ReslabError: actual.ReslabError, stripHtml: actual.stripHtml };
});
vi.mock("@/lib/resend/client", () => ({ resend: { emails: { send: resendSend } }, FROM_EMAIL: "Triply <bookings@triplypro.com>" }));
vi.mock("@/lib/resend/send-booking-confirmation", () => ({
  sendBookingConfirmation: vi.fn(async () => ({ success: true, emailId: "em_customer" })),
}));
vi.mock("@/lib/resend/send-admin-booking-notification", () => ({ sendAdminBookingNotification: vi.fn(async () => undefined) }));
vi.mock("@/lib/parkguard/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/parkguard/client")>("@/lib/parkguard/client");
  return { ...actual, parkGuard: { captureReservation: vi.fn(async () => ({ pg_identifier: "pg_1" })), updateReservation: vi.fn() } };
});
vi.mock("@/lib/sentry", () => ({
  capturePaymentError: vi.fn(),
  captureBookingError: vi.fn(),
  captureParkGuardError: vi.fn(),
  captureAPIError: vi.fn(),
  captureDirectLotNotice: vi.fn(),
}));
// Deterministic numbers when a test queues them; random otherwise.
vi.mock("@/lib/direct/confirmation-number", async () => {
  const actual = await vi.importActual<typeof import("@/lib/direct/confirmation-number")>("@/lib/direct/confirmation-number");
  return { ...actual, issueConfirmationNumber: () => numbers.queue.shift() ?? actual.issueConfirmationNumber() };
});

const { createBooking, redriveDirectBookingSends } = await import("../create-booking");
const { capturePaymentError, captureDirectLotNotice } = await import("@/lib/sentry");
const { sendBookingConfirmation } = await import("@/lib/resend/send-booking-confirmation");
const { sendAdminBookingNotification } = await import("@/lib/resend/send-admin-booking-notification");
const { parkGuard } = await import("@/lib/parkguard/client");
const { buildLotSnapshotV2 } = await import("@/lib/direct/lot-snapshot-build");
const { directLotFromRow } = await import("@/lib/direct/store");
const { directLotRow } = await import("@/lib/direct/__tests__/fixtures");
const { getProtectionPlan, protectionMetadataPatch } = await import("@/lib/parkguard/plans");

const PI = "pi_direct_1";
const NOW = new Date("2026-10-12T16:00:00Z"); // Oct 12, noon in New York
const FROM = "2026-10-20 10:00:00";
const TO = "2026-10-25 10:00:00";
const TRP = /^TRP-[0-9A-HJKMNP-TV-Z]{8}$/;

function snapshot(payloadId = 1) {
  const out = directLotFromRow(directLotRow({ id: payloadId, tax_rate_percent: 16 }));
  if (!out.lot) throw new Error("fixture lot did not parse");
  const s = buildLotSnapshotV2(out.lot);
  if (!s) throw new Error("fixture snapshot did not build");
  return s;
}

/** A pending row exactly as stageDirect writes it (large SUV, no Park Guard). */
function directRow(over: Record<string, unknown> = {}) {
  return {
    stripe_payment_intent_id: PI,
    status: "pending",
    inventory_source: "direct",
    direct_lot_id: "1",
    lot_snapshot: snapshot(),
    location_id: null,
    parking_type_id: null,
    costs_token: null,
    reslab_reservation_number: null,
    claimed_at: null,
    email_sent: false,
    livemode: false,
    from_date: FROM,
    to_date: TO,
    customer: { firstName: "Ada", lastName: "Lovelace", email: "ada@example.com", phone: "555-0100" },
    vehicle: { make: "Ford", model: "F-150", color: "Black", licensePlate: "ABC123", state: "NY" },
    extra_fields: null,
    confirmation_params: { lot: "direct-1" },
    location_name: "The Parking Point JFK",
    location_address: "150-57 183rd St, Springfield Gardens, NY 11413",
    airport_code: "JFK",
    subtotal: "49.75",
    tax_total: "7.96",
    fees_total: "0",
    grand_total: "57.71",
    triply_service_fee: "5.95",
    user_id: null,
    has_protection_plan: false,
    protection_plan_code: null,
    attribution: null,
    vehicle_size: "large_suv_truck",
    vehicle_size_label: "Large SUV / truck",
    vehicle_surcharge_cents: 5000,
    vehicle_surcharge_tax_cents: 800,
    vehicle_size_source: "modal",
    capture_attempts: 0,
    created_at: "2026-10-12T15:00:00.000Z",
    ...over,
  };
}

const META = {
  inventorySource: "direct",
  lotId: "direct-1",
  directLotId: "1",
  checkin: "2026-10-20",
  checkout: "2026-10-25",
  checkinTime: "10:00 AM",
  checkoutTime: "10:00 AM",
  customerEmail: "ada@example.com",
  parkingOnlyChargeAmountCents: "6366",
  directRateCents: "995",
  directDays: "5",
  directSubtotalCents: "4975",
  directTaxCents: "796",
  directGrandTotalCents: "5771",
  directDiscountCents: "0",
  directServiceFeeCents: "595",
  directTaxRatePercent: "16",
  directSurcharges: "small_suv:500,midsize_suv:700,large_suv_truck:1000",
};

function pi(over: Record<string, unknown> = {}) {
  return {
    id: PI,
    status: "requires_capture",
    amount: 6366,
    livemode: false,
    created: Math.floor(Date.parse("2026-10-12T15:30:00Z") / 1000),
    metadata: { ...META },
    latest_charge: null,
    ...over,
  };
}

function terms(over: Record<string, unknown> = {}) {
  return {
    stripe_payment_intent_id: PI,
    direct_lot_id: "1",
    livemode: false,
    partner_share_percent: 80,
    tax_rate_percent: 16,
    tax_collected_by: "lot",
    lot_recipients: ["parkingpointjfk@gmail.com"],
    lot_notice_email_id: null,
    lot_notice_recipients: null,
    lot_cancel_notice_email_id: null,
    ...over,
  };
}

function seed(rowOver: Record<string, unknown> = {}, termsOver: Record<string, unknown> | null = {}) {
  db.tables = {
    pending_bookings: [directRow(rowOver)],
    bookings: [],
    cart_claims: [],
    customers: [],
    direct_booking_terms: termsOver === null ? [] : [terms(termsOver)],
  };
}

const lotSends = () => resendSend.mock.calls.map((c) => c[0] as { to: string[]; subject: string; html: string });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  numbers.queue = [];
  db.clearFailures();
  db.log = [];
  vi.stubEnv("NEXT_PUBLIC_APP_ENV", "staging");
  vi.stubEnv("DIRECT_LOT_NOTICE_OVERRIDE_TO", "tom@triplypro.com");
  vi.stubEnv("DIRECT_CHECKOUT_PREVIEW", "true");
  seed();
  stripeMock.paymentIntents.retrieve.mockResolvedValue(pi());
  capturePaymentIntent.mockResolvedValue({ status: "succeeded" });
  cancelPaymentIntent.mockResolvedValue({ status: "canceled" });
  resendSend.mockResolvedValue({ data: { id: "em_lot" }, error: null });
  vi.mocked(sendBookingConfirmation).mockResolvedValue({ success: true, emailId: "em_customer" });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const noReslab = () => {
  for (const f of Object.values(reslabMock)) expect(f).not.toHaveBeenCalled();
};

describe("direct fulfilment — the happy path", () => {
  it.each(["webhook", "complete", "sweep", "client"] as const)("%s: issues a TRP- number BEFORE capture, books from metadata, tells the lot then the customer", async (source) => {
    let numberAtCapture: unknown = "not captured";
    capturePaymentIntent.mockImplementation(async () => {
      numberAtCapture = db.tables.pending_bookings[0].reslab_reservation_number;
      return { status: "succeeded" };
    });

    const out = await createBooking({ source, stripePaymentIntentId: PI });

    expect(out.kind).toBe("created");
    if (out.kind !== "created") return;
    expect(out.reservationNumber).toMatch(TRP);
    // D6: the number was recorded before the money moved.
    expect(numberAtCapture).toBe(out.reservationNumber);
    noReslab();

    const b = db.tables.bookings[0];
    expect(b).toMatchObject({
      reslab_reservation_number: out.reservationNumber,
      inventory_source: "direct",
      direct_lot_id: "1",
      reslab_location_id: null,
      location_name: "The Parking Point JFK",
      airport_code: "JFK",
      location_timezone: "America/New_York",
      check_in: FROM,
      check_out: TO,
      subtotal: 49.75,
      tax_total: 7.96,
      fees_total: 0,
      grand_total: 57.71,
      triply_service_fee: 5.95,
      due_at_location: 0,
      discount_amount: 0,
      status: "confirmed",
      livemode: false,
      stripe_payment_intent_id: PI,
      vehicle_size: "large_suv_truck",
      vehicle_size_label: "Large SUV / truck",
      vehicle_surcharge_cents: 5000,
      vehicle_surcharge_tax_cents: 800,
      vehicle_size_source: "modal",
    });
    expect(b.lot_snapshot).toMatchObject({ v: 2, directLotId: "1" });
    expect(b.lot_snapshot).not.toHaveProperty("notificationEmails");
    expect(b.lot_notified_at).toBeTruthy();

    // The lot notice: override inbox, [TEST], never the lot's own address off production.
    expect(resendSend).toHaveBeenCalledTimes(1);
    const [notice] = lotSends();
    expect(notice.to).toEqual(["tom@triplypro.com"]);
    expect(notice.subject).toMatch(/^\[TEST\] New Triply booking TRP-/);
    expect(notice.html).toContain("Large SUV / truck");
    expect(notice.html).toContain("$58.00"); // 5000 + 800 cents, collected at the lot
    expect(resendSend.mock.calls[0][1]).toEqual({ idempotencyKey: expect.stringMatching(/^direct-lot-notice\/booking\//) });
    expect(db.tables.direct_booking_terms[0]).toMatchObject({ lot_notice_email_id: "em_lot", lot_notice_recipients: ["tom@triplypro.com"] });

    // The customer email: online total ≠ at-lot estimate; no ResLab branding.
    expect(sendBookingConfirmation).toHaveBeenCalledTimes(1);
    const email = vi.mocked(sendBookingConfirmation).mock.calls[0][0];
    expect(email).toMatchObject({
      confirmationNumber: out.reservationNumber,
      totalAmount: 63.66,
      dueAtLocation: 0,
      lotName: "The Parking Point JFK",
      direct: { vehicleSizeLabel: "Large SUV / truck", atLotEstimate: 58 },
    });
    // Lot BEFORE customer (§9 H-B).
    expect(resendSend.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(sendBookingConfirmation).mock.invocationCallOrder[0]);
    expect(sendAdminBookingNotification).toHaveBeenCalledWith(expect.objectContaining({ sourceLine: expect.stringMatching(/Direct lot/), totalAmount: 63.66 }));

    const row = db.tables.pending_bookings[0];
    expect(row).toMatchObject({ status: "completed", email_sent: true, reslab_reservation_number: out.reservationNumber });
    expect(db.tables.cart_claims[0].cart_key).toBe("test|ada@example.com|direct:1|2026-10-20 10:00:00|2026-10-25 10:00:00|direct");
    expect(db.tables.cart_claims[0].released_at).toBeTruthy();
    expect(out.reservation).toMatchObject({ dueNow: 63.66, dueAtLocation: 0, serviceFee: 5.95 });
  });

  it("Park Guard Plan A: the premium is in the charge, the row and the enrolment — never the at-lot estimate", async () => {
    const meta = { ...META, ...protectionMetadataPatch(getProtectionPlan("A")!) };
    seed({ has_protection_plan: true, protection_plan_code: "A" });
    stripeMock.paymentIntents.retrieve.mockResolvedValue(pi({ amount: 6366 + 1299, metadata: meta }));
    const out = await createBooking({ source: "webhook", stripePaymentIntentId: PI });
    expect(out.kind).toBe("created");
    expect(db.tables.bookings[0]).toMatchObject({ protection_plan_code: "A", protection_plan_price: 12.99, protection_plan_wholesale: 6 });
    expect(parkGuard.captureReservation).toHaveBeenCalledWith(
      expect.objectContaining({ parking_state: "NY", parking_zipcode: "11413", parking_city: "Springfield Gardens" })
    );
    expect(vi.mocked(sendBookingConfirmation).mock.calls[0][0]).toMatchObject({ totalAmount: 76.65 });
  });

  it("a promo: the discount stamped on the payment is stored and the code recorded", async () => {
    const meta = { ...META, discountPercent: "10", promoCode: "welcome10", directDiscountCents: "498", parkingOnlyChargeAmountCents: "5868" };
    stripeMock.paymentIntents.retrieve.mockResolvedValue(pi({ amount: 5868, metadata: meta }));
    const out = await createBooking({ source: "webhook", stripePaymentIntentId: PI });
    expect(out.kind).toBe("created");
    expect(db.tables.bookings[0]).toMatchObject({ discount_amount: 4.98, promo_code: "WELCOME10" });
    expect(vi.mocked(sendBookingConfirmation).mock.calls[0][0].totalAmount).toBe(58.68);
  });

  it("a client payload for a direct payment is ignored (Sentry) and the staged row is booked (§9 H-A)", async () => {
    const out = await createBooking({
      source: "client",
      stripePaymentIntentId: PI,
      payload: {
        locationId: 9,
        costsToken: "x",
        fromDate: "2027-01-01 10:00:00",
        toDate: "2027-01-02 10:00:00",
        parkingTypeId: 1,
        customer: { firstName: "Eve", lastName: "X", email: "eve@example.com", phone: "1" },
        vehicle: { make: "a", model: "b", color: "c", licensePlate: "d", state: "NY" },
        protectionPlanCode: null,
      },
    });
    expect(out.kind).toBe("created");
    expect(db.tables.bookings[0]).toMatchObject({ check_in: FROM, vehicle_info: expect.objectContaining({ licensePlate: "ABC123" }) });
    expect(String(vi.mocked(capturePaymentError).mock.calls[0][0])).toMatch(/ignored a client payload/);
  });

  it("the checkout preview flag being off does not strand a staged booking (the engine never reads it)", async () => {
    vi.stubEnv("DIRECT_CHECKOUT_PREVIEW", "");
    expect((await createBooking({ source: "sweep", stripePaymentIntentId: PI })).kind).toBe("created");
  });
});

describe("direct fulfilment — resume (B4): no second number, no network", () => {
  it("crash after the number was recorded → resume captures with the SAME number", async () => {
    seed({ reslab_reservation_number: "TRP-AAAA1111", status: "processing", claimed_at: "2026-10-12T15:00:00.000Z" });
    numbers.queue = ["TRP-ZZZZ9999"]; // would be used if a second number were issued
    const out = await createBooking({ source: "sweep", stripePaymentIntentId: PI });
    expect(out).toMatchObject({ kind: "created", reservationNumber: "TRP-AAAA1111" });
    expect(capturePaymentIntent).toHaveBeenCalledTimes(1);
    expect(db.tables.cart_claims).toHaveLength(0); // a resume never re-claims the cart
    noReslab();
  });

  it("crash after capture → resume persists without capturing again", async () => {
    seed({ reslab_reservation_number: "TRP-AAAA1111" });
    stripeMock.paymentIntents.retrieve.mockResolvedValue(pi({ status: "succeeded", latest_charge: { amount_refunded: 0 } }));
    const out = await createBooking({ source: "webhook", stripePaymentIntentId: PI });
    expect(out).toMatchObject({ kind: "created", reservationNumber: "TRP-AAAA1111" });
    expect(capturePaymentIntent).not.toHaveBeenCalled();
    noReslab();
  });

  it("crash after the booking insert → a redelivery still tells the lot and the customer (§9 H-B)", async () => {
    seed({ reslab_reservation_number: "TRP-AAAA1111", status: "processing" });
    db.tables.bookings = [
      { id: "b1", stripe_payment_intent_id: PI, reslab_reservation_number: "TRP-AAAA1111", inventory_source: "direct", status: "confirmed", lot_notified_at: null, lot_notice_claimed_at: null, pg_sync_status: null },
    ];
    stripeMock.paymentIntents.retrieve.mockResolvedValue(pi({ status: "succeeded", latest_charge: { amount_refunded: 0 } }));
    const out = await createBooking({ source: "webhook", stripePaymentIntentId: PI });
    expect(out).toMatchObject({ kind: "already_exists", reservationNumber: "TRP-AAAA1111" });
    expect(resendSend).toHaveBeenCalledTimes(1);
    expect(db.tables.bookings[0].lot_notified_at).toBeTruthy();
    expect(sendBookingConfirmation).toHaveBeenCalledTimes(1);
    expect(db.tables.pending_bookings[0].email_sent).toBe(true);

    // A second redelivery sends nothing again.
    await createBooking({ source: "webhook", stripePaymentIntentId: PI });
    expect(resendSend).toHaveBeenCalledTimes(1);
    expect(sendBookingConfirmation).toHaveBeenCalledTimes(1);
  });

  it("a same-PaymentIntent replay of a finished booking → already_exists with THAT row's number, no sends", async () => {
    seed({ reslab_reservation_number: "TRP-AAAA1111", status: "completed", email_sent: true });
    db.tables.bookings = [
      { id: "b1", stripe_payment_intent_id: PI, reslab_reservation_number: "TRP-AAAA1111", inventory_source: "direct", status: "confirmed", lot_notified_at: "2026-10-12T15:00:00Z", pg_sync_status: null },
    ];
    stripeMock.paymentIntents.retrieve.mockResolvedValue(pi({ status: "succeeded", latest_charge: { amount_refunded: 0 } }));
    expect(await createBooking({ source: "client", stripePaymentIntentId: PI })).toEqual({ kind: "already_exists", reservationNumber: "TRP-AAAA1111" });
    expect(resendSend).not.toHaveBeenCalled();
    expect(sendBookingConfirmation).not.toHaveBeenCalled();
  });
});

describe("direct fulfilment — numbers and collisions (B7)", () => {
  it("a pending-row number collision regenerates (partial UNIQUE)", async () => {
    db.tables.pending_bookings.push(directRow({ stripe_payment_intent_id: "pi_other", reslab_reservation_number: "TRP-AAAA1111", status: "completed" }));
    numbers.queue = ["TRP-AAAA1111", "TRP-BBBB2222"];
    const out = await createBooking({ source: "webhook", stripePaymentIntentId: PI });
    expect(out).toMatchObject({ kind: "created", reservationNumber: "TRP-BBBB2222" });
  });

  it("three pending collisions in a row → released before capture, 'not charged'", async () => {
    db.tables.pending_bookings.push(directRow({ stripe_payment_intent_id: "pi_other", reslab_reservation_number: "TRP-AAAA1111", status: "completed" }));
    numbers.queue = ["TRP-AAAA1111", "TRP-AAAA1111", "TRP-AAAA1111"];
    const out = await createBooking({ source: "webhook", stripePaymentIntentId: PI });
    expect(out).toMatchObject({ kind: "failed" });
    expect(capturePaymentIntent).not.toHaveBeenCalled();
    expect(cancelPaymentIntent).toHaveBeenCalledWith(PI);
    expect(db.tables.pending_bookings[0].status).toBe("released_failed");
  });

  it("a BOOKINGS collision with another payment's booking → a fresh number, never already_exists", async () => {
    db.tables.bookings = [{ id: "b_other", stripe_payment_intent_id: "pi_other", reslab_reservation_number: "TRP-AAAA1111" }];
    numbers.queue = ["TRP-AAAA1111", "TRP-CCCC3333"];
    const out = await createBooking({ source: "webhook", stripePaymentIntentId: PI });
    expect(out).toMatchObject({ kind: "created", reservationNumber: "TRP-CCCC3333" });
    expect(db.tables.bookings).toHaveLength(2);
    expect(db.tables.pending_bookings[0].reslab_reservation_number).toBe("TRP-CCCC3333");
  });
});

describe("direct fulfilment — carts (B6)", () => {
  it("two direct lots, same email and dates → both booked", async () => {
    expect((await createBooking({ source: "webhook", stripePaymentIntentId: PI })).kind).toBe("created");
    db.tables.pending_bookings.push(directRow({ stripe_payment_intent_id: "pi_2", direct_lot_id: "2", lot_snapshot: snapshot(2) }));
    db.tables.direct_booking_terms.push(terms({ stripe_payment_intent_id: "pi_2", direct_lot_id: "2" }));
    stripeMock.paymentIntents.retrieve.mockResolvedValue(pi({ id: "pi_2", metadata: { ...META, lotId: "direct-2", directLotId: "2" } }));
    expect((await createBooking({ source: "webhook", stripePaymentIntentId: "pi_2" })).kind).toBe("created");
  });

  it("the same lot twice inside the cart window → the second is a suspected duplicate, released", async () => {
    db.tables.pending_bookings.push(directRow({ stripe_payment_intent_id: "pi_2" }));
    db.tables.direct_booking_terms.push(terms({ stripe_payment_intent_id: "pi_2" }));
    db.tables.cart_claims = [
      { id: "c1", cart_key: "test|ada@example.com|direct:1|2026-10-20 10:00:00|2026-10-25 10:00:00|direct", stripe_payment_intent_id: "pi_2", claimed_at: NOW.toISOString(), released_at: null },
    ];
    expect(await createBooking({ source: "webhook", stripePaymentIntentId: PI })).toEqual({ kind: "suspected_duplicate" });
    expect(cancelPaymentIntent).toHaveBeenCalledWith(PI);
    expect(capturePaymentIntent).not.toHaveBeenCalled();
  });
});

describe("direct fulfilment — blocked before capture", () => {
  it("metadata money ≠ pi.amount → released, 'not charged', nothing booked", async () => {
    stripeMock.paymentIntents.retrieve.mockResolvedValue(pi({ amount: 6367 }));
    const out = await createBooking({ source: "webhook", stripePaymentIntentId: PI });
    expect(out).toMatchObject({ kind: "failed" });
    expect(capturePaymentIntent).not.toHaveBeenCalled();
    expect(cancelPaymentIntent).toHaveBeenCalledWith(PI);
    expect(db.tables.bookings).toHaveLength(0);
    expect(db.tables.pending_bookings[0]).toMatchObject({ status: "released_failed", reslab_reservation_number: null });
  });

  it("a service-fee rule change mid-flight still books (arithmetic only, §9 H-E)", async () => {
    const meta = { ...META, directServiceFeeCents: "495", parkingOnlyChargeAmountCents: "6266" };
    stripeMock.paymentIntents.retrieve.mockResolvedValue(pi({ amount: 6266, metadata: meta }));
    expect((await createBooking({ source: "webhook", stripePaymentIntentId: PI })).kind).toBe("created");
    expect(db.tables.bookings[0].triply_service_fee).toBe(4.95);
  });

  it("no terms row → released before capture (the lot could never be paid or told, §9 M-C)", async () => {
    seed({}, null);
    const out = await createBooking({ source: "webhook", stripePaymentIntentId: PI });
    expect(out).toMatchObject({ kind: "failed" });
    expect(capturePaymentIntent).not.toHaveBeenCalled();
  });

  it("a terms row from the other Stripe mode → released before capture", async () => {
    seed({}, { livemode: true });
    expect((await createBooking({ source: "webhook", stripePaymentIntentId: PI })).kind).toBe("failed");
    expect(capturePaymentIntent).not.toHaveBeenCalled();
  });

  it("a corrupt row (snapshot names another lot) → released before capture, never held for ops (pass-1 B5)", async () => {
    seed({ lot_snapshot: snapshot(2) });
    const out = await createBooking({ source: "webhook", stripePaymentIntentId: PI });
    expect(out).toMatchObject({ kind: "failed", reason: expect.stringMatching(/not a valid direct booking/) });
    expect(capturePaymentIntent).not.toHaveBeenCalled();
    expect(cancelPaymentIntent).toHaveBeenCalledWith(PI);
    expect(db.tables.pending_bookings[0].status).toBe("released_failed");
  });
});

describe("direct fulfilment — staleness (§9 M-B)", () => {
  it("the stay has already ended → released, never booked", async () => {
    vi.setSystemTime(new Date("2026-10-26T12:00:00Z"));
    const out = await createBooking({ source: "sweep", stripePaymentIntentId: PI });
    expect(out).toMatchObject({ kind: "failed", reason: expect.stringMatching(/already ended/) });
    expect(capturePaymentIntent).not.toHaveBeenCalled();
    expect(cancelPaymentIntent).toHaveBeenCalledWith(PI);
  });

  it("authorized AFTER check-in → released", async () => {
    vi.setSystemTime(new Date("2026-10-21T12:00:00Z"));
    stripeMock.paymentIntents.retrieve.mockResolvedValue(pi({ created: Math.floor(Date.parse("2026-10-20T15:00:00Z") / 1000) }));
    expect((await createBooking({ source: "webhook", stripePaymentIntentId: PI })).kind).toBe("failed");
    expect(capturePaymentIntent).not.toHaveBeenCalled();
  });

  it("authorized before check-in, fulfilled after it → booked, and the lot notice is URGENT", async () => {
    vi.setSystemTime(new Date("2026-10-20T15:00:00Z")); // 11:00 AM in New York, an hour after drop-off
    const out = await createBooking({ source: "webhook", stripePaymentIntentId: PI });
    expect(out.kind).toBe("created");
    expect(lotSends()[0].subject).toMatch(/^\[TEST\] URGENT — late booking — /);
  });
});

describe("direct fulfilment — capture (§10 F-4)", () => {
  it("a card error on capture → released, 'not charged', nothing booked", async () => {
    capturePaymentIntent.mockRejectedValue(Object.assign(new Error("Your card was declined."), { type: "StripeCardError", statusCode: 402 }));
    stripeMock.paymentIntents.retrieve.mockResolvedValueOnce(pi()).mockResolvedValueOnce(pi());
    const out = await createBooking({ source: "webhook", stripePaymentIntentId: PI });
    expect(out).toMatchObject({ kind: "failed" });
    expect(cancelPaymentIntent).toHaveBeenCalledWith(PI);
    expect(db.tables.bookings).toHaveLength(0);
  });

  it("a transient capture error → retried (claim handed back, attempt counted)", async () => {
    capturePaymentIntent.mockRejectedValue(Object.assign(new Error("socket hang up"), { type: "StripeConnectionError" }));
    const out = await createBooking({ source: "webhook", stripePaymentIntentId: PI });
    expect(out).toMatchObject({ kind: "needs_reconciliation", retryable: true });
    expect(db.tables.pending_bookings[0]).toMatchObject({ status: "pending", capture_attempts: 1 });
    expect(db.tables.pending_bookings[0].reslab_reservation_number).toMatch(TRP);
    expect(cancelPaymentIntent).not.toHaveBeenCalled();
  });

  it("…the third transient failure stops retrying: capture_ambiguous, auth held, a loud alert", async () => {
    seed({ capture_attempts: 2, reslab_reservation_number: "TRP-AAAA1111" });
    capturePaymentIntent.mockRejectedValue(Object.assign(new Error("socket hang up"), { type: "StripeConnectionError" }));
    const out = await createBooking({ source: "sweep", stripePaymentIntentId: PI });
    expect(out).toMatchObject({ kind: "needs_reconciliation", retryable: false });
    expect(db.tables.pending_bookings[0].status).toBe("capture_ambiguous");
    expect(String(vi.mocked(capturePaymentError).mock.calls.at(-1)?.[0])).toMatch(/DIRECT CAPTURE FAILED 3 times/);
  });

  it("capture throws but the payment DID capture → carries on and books", async () => {
    capturePaymentIntent.mockRejectedValue(new Error("lost response"));
    stripeMock.paymentIntents.retrieve.mockResolvedValueOnce(pi()).mockResolvedValueOnce(pi({ status: "succeeded" }));
    expect((await createBooking({ source: "webhook", stripePaymentIntentId: PI })).kind).toBe("created");
  });
});

describe("direct fulfilment — notices and emails", () => {
  it("the customer email {success:false} hands the email_sent claim back; the booking stands", async () => {
    vi.mocked(sendBookingConfirmation).mockResolvedValue({ success: false, error: new Error("resend 500") });
    expect((await createBooking({ source: "webhook", stripePaymentIntentId: PI })).kind).toBe("created");
    expect(db.tables.pending_bookings[0].email_sent).toBe(false);
  });

  it("a failed lot notice leaves the booking un-notified (claim released) and alerts; the booking stands", async () => {
    // A DEFINITE refusal (4xx). An error with no statusCode / a 5xx is an
    // unknown outcome and keeps the claim (lot-notice.ts) — not this case.
    resendSend.mockResolvedValue({ data: null, error: { name: "rate_limit_exceeded", statusCode: 429, message: "rate limited" } });
    expect((await createBooking({ source: "webhook", stripePaymentIntentId: PI })).kind).toBe("created");
    const b = db.tables.bookings[0];
    expect(b.lot_notified_at ?? null).toBeNull();
    expect(b.lot_notice_claimed_at ?? null).toBeNull();
    expect(captureDirectLotNotice).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ kind: "booking", outcome: "failed" }));
    expect(sendBookingConfirmation).toHaveBeenCalledTimes(1); // the customer still gets theirs
  });

  it.each([
    ["no statusCode", { message: "lost response" }],
    ["a 5xx", { name: "internal_server_error", statusCode: 500, message: "boom" }],
    ["application_error", { name: "application_error", statusCode: 200, message: "unreadable" }],
  ])("an UNKNOWN lot-notice outcome (%s) keeps the claim (Resend may have delivered it), un-stamped; the booking stands", async (_label, error) => {
    resendSend.mockResolvedValue({ data: null, error });
    expect((await createBooking({ source: "webhook", stripePaymentIntentId: PI })).kind).toBe("created");
    const b = db.tables.bookings[0];
    expect(b.lot_notified_at ?? null).toBeNull();
    expect(b.lot_notice_claimed_at).toBeTruthy();
    expect(captureDirectLotNotice).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ kind: "booking", outcome: "failed" }));
    expect(sendBookingConfirmation).toHaveBeenCalledTimes(1);
  });

  it("no override inbox off production → no send, a warning, the booking stands un-notified", async () => {
    vi.stubEnv("DIRECT_LOT_NOTICE_OVERRIDE_TO", "");
    expect((await createBooking({ source: "webhook", stripePaymentIntentId: PI })).kind).toBe("created");
    expect(resendSend).not.toHaveBeenCalled();
    expect(captureDirectLotNotice).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ outcome: "skipped" }));
  });

  it("production + a live-mode booking → the lot's OWN inbox, no [TEST]", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "production");
    seed({ livemode: true }, { livemode: true });
    stripeMock.paymentIntents.retrieve.mockResolvedValue(pi({ livemode: true }));
    expect((await createBooking({ source: "webhook", stripePaymentIntentId: PI })).kind).toBe("created");
    expect(lotSends()[0].to).toEqual(["parkingpointjfk@gmail.com"]);
    expect(lotSends()[0].subject).not.toMatch(/\[TEST\]/);
  });

  it("production reading a TEST-mode booking still goes to the override inbox (B11)", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "production");
    expect((await createBooking({ source: "webhook", stripePaymentIntentId: PI })).kind).toBe("created");
    expect(lotSends()[0].to).toEqual(["tom@triplypro.com"]);
  });
});

// ---------------------------------------------------------------------------
// After capture: the booking insert, its 23505 rule, and the sends (B7, §3.3).
// Money has moved in every test below, so each one asserts the durable state a
// later caller (or ops) will act on — not just what this call returned.
// ---------------------------------------------------------------------------

const capturedPi = () => pi({ status: "succeeded", latest_charge: { amount_refunded: 0 } });
const stripeTransient = () => Object.assign(new Error("socket hang up"), { type: "StripeConnectionError" });
const alerts = () => vi.mocked(capturePaymentError).mock.calls.map((c) => String(c[0]));

describe("direct fulfilment — booking insert fails after capture", () => {
  it("a transient insert failure hands the row back; the retry books the SAME number without capturing again, and sends once", async () => {
    db.failOnce("bookings", "insert", "connection reset by peer");
    const first = await createBooking({ source: "webhook", stripePaymentIntentId: PI });
    expect(first).toMatchObject({ kind: "needs_reconciliation", retryable: true });
    expect(capturePaymentIntent).toHaveBeenCalledTimes(1);
    expect(capturePaymentIntent).toHaveBeenCalledWith(PI, 0);
    expect(db.tables.bookings).toHaveLength(0);
    const row = db.tables.pending_bookings[0];
    expect(row).toMatchObject({ status: "pending", claimed_at: null, email_sent: false });
    const recorded = row.reslab_reservation_number;
    expect(recorded).toMatch(TRP);
    // Nothing was sent for a booking that does not exist yet.
    expect(resendSend).not.toHaveBeenCalled();
    expect(sendBookingConfirmation).not.toHaveBeenCalled();

    // The retry: Stripe now reports the payment captured.
    stripeMock.paymentIntents.retrieve.mockResolvedValue(capturedPi());
    numbers.queue = ["TRP-ZZZZ9999"]; // would be used if a second number were issued
    const second = await createBooking({ source: "sweep", stripePaymentIntentId: PI });
    expect(second).toMatchObject({ kind: "created", reservationNumber: recorded });
    expect(capturePaymentIntent).toHaveBeenCalledTimes(1);
    expect(db.tables.bookings).toHaveLength(1);
    expect(db.tables.bookings[0]).toMatchObject({ reslab_reservation_number: recorded, stripe_payment_intent_id: PI, status: "confirmed" });
    expect(resendSend).toHaveBeenCalledTimes(1);
    expect(sendBookingConfirmation).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendBookingConfirmation).mock.calls[0][0].confirmationNumber).toBe(recorded);
    expect(db.tables.pending_bookings[0]).toMatchObject({ status: "completed", email_sent: true, reslab_reservation_number: recorded });
    noReslab();
  });

  it("a permanent insert rejection (23514) → needs_reconciliation, not retried, a CHARGED alert to create it by hand", async () => {
    db.failOnce("bookings", "insert", 'new row for relation "bookings" violates check constraint "x"', "23514");
    const out = await createBooking({ source: "webhook", stripePaymentIntentId: PI });
    expect(out).toMatchObject({ kind: "needs_reconciliation", retryable: false });
    expect(capturePaymentIntent).toHaveBeenCalledTimes(1);
    expect(db.tables.bookings).toHaveLength(0);
    expect(db.tables.pending_bookings[0].status).toBe("needs_reconciliation");
    expect(alerts().some((m) => /CHARGED/.test(m) && /create it by hand/i.test(m))).toBe(true);
    expect(resendSend).not.toHaveBeenCalled();
    expect(sendBookingConfirmation).not.toHaveBeenCalled();
  });

  it("number collisions that never clear → needs_reconciliation, not retried, a 'number collisions' alert", async () => {
    db.failAlways("bookings", "insert", 'duplicate key value violates unique constraint "bookings_reslab_reservation_number_key"', "23505");
    const out = await createBooking({ source: "webhook", stripePaymentIntentId: PI });
    expect(out).toMatchObject({ kind: "needs_reconciliation", retryable: false });
    expect(capturePaymentIntent).toHaveBeenCalledTimes(1);
    expect(db.tables.bookings).toHaveLength(0);
    expect(db.tables.pending_bookings[0].status).toBe("needs_reconciliation");
    expect(alerts().some((m) => /CHARGED/.test(m) && /number collisions/.test(m))).toBe(true);
    expect(resendSend).not.toHaveBeenCalled();
    expect(sendBookingConfirmation).not.toHaveBeenCalled();
  });

  it("a concurrent winner stored THIS payment's booking under another number → already_exists with ITS number, no sends from the loser", async () => {
    db.failWhen(
      "bookings",
      "insert",
      () => {
        db.tables.bookings.push({ id: "b_winner", stripe_payment_intent_id: PI, reslab_reservation_number: "TRP-WINNER00", inventory_source: "direct", status: "confirmed" });
        return true;
      },
      'duplicate key value violates unique constraint "bookings_stripe_payment_intent_id_key"',
      "23505"
    );
    const out = await createBooking({ source: "webhook", stripePaymentIntentId: PI });
    expect(out).toEqual({ kind: "already_exists", reservationNumber: "TRP-WINNER00" });
    expect(db.tables.bookings).toHaveLength(1);
    expect(db.tables.pending_bookings[0].status).toBe("completed");
    expect(resendSend).not.toHaveBeenCalled();
    expect(sendBookingConfirmation).not.toHaveBeenCalled();
    expect(sendAdminBookingNotification).not.toHaveBeenCalled();
    expect(db.tables.pending_bookings[0].email_sent).toBe(false);
  });
});

describe("direct fulfilment — the customer email is claimed before it is sent (§10 F-1)", () => {
  it("three concurrent re-drives of a crashed-after-insert booking → ONE confirmation, ONE lot notice", async () => {
    seed({ reslab_reservation_number: "TRP-AAAA1111", status: "processing" });
    db.tables.bookings = [
      { id: "b1", stripe_payment_intent_id: PI, reslab_reservation_number: "TRP-AAAA1111", inventory_source: "direct", status: "confirmed", lot_notified_at: null, lot_notice_claimed_at: null, pg_sync_status: null },
    ];
    stripeMock.paymentIntents.retrieve.mockResolvedValue(capturedPi());
    // A slow send keeps the first claim in flight while the others arrive.
    vi.mocked(sendBookingConfirmation).mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return { success: true, emailId: "em_customer" };
    });
    // Count claim ATTEMPTS (never fails): proves all three callers really raced
    // to the claim, so a single send is the claim's doing, not serialisation.
    let claimAttempts = 0;
    db.failWhen("pending_bookings", "update", (p) => (p?.email_sent === true && claimAttempts++, false), "never");
    const outs = await Promise.all(
      (["webhook", "complete", "sweep"] as const).map((source) => createBooking({ source, stripePaymentIntentId: PI }))
    );
    for (const out of outs) expect(out).toMatchObject({ kind: "already_exists", reservationNumber: "TRP-AAAA1111" });
    expect(claimAttempts).toBe(3);
    expect(sendBookingConfirmation).toHaveBeenCalledTimes(1);
    expect(resendSend).toHaveBeenCalledTimes(1);
    expect(db.tables.pending_bookings[0]).toMatchObject({ email_sent: true, status: "completed" });
    expect(db.tables.bookings[0].lot_notified_at).toBeTruthy();
  });

  it("the email claim itself fails (DB fault) → nothing sent, email_sent stays false, an alert; the booking stands", async () => {
    db.failWhen("pending_bookings", "update", (p) => p?.email_sent === true, "connection reset by peer");
    const out = await createBooking({ source: "webhook", stripePaymentIntentId: PI });
    expect(out.kind).toBe("created");
    expect(sendBookingConfirmation).not.toHaveBeenCalled();
    expect(db.tables.pending_bookings[0]).toMatchObject({ email_sent: false, status: "completed" });
    expect(db.tables.bookings).toHaveLength(1);
    expect(alerts().some((m) => /confirmation-email claim failed/.test(m))).toBe(true);
    // The lot is still told — its notice has its own claim.
    expect(resendSend).toHaveBeenCalledTimes(1);
  });

  it("an uncertain send (timeout) hands email_sent back; the send carried the PaymentIntent's idempotency key and a 5 s bound", async () => {
    vi.mocked(sendBookingConfirmation).mockResolvedValue({ success: false, error: new Error("timeout"), uncertain: true });
    const out = await createBooking({ source: "webhook", stripePaymentIntentId: PI });
    expect(out.kind).toBe("created");
    expect(sendBookingConfirmation).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendBookingConfirmation).mock.calls[0][0]).toMatchObject({ idempotencyKey: `direct-confirmation/${PI}`, timeoutMs: 5000 });
    expect(db.tables.pending_bookings[0].email_sent).toBe(false);
    expect(alerts().some((m) => /did not answer in time/.test(m))).toBe(true);
  });

  it("a send that throws also hands email_sent back", async () => {
    vi.mocked(sendBookingConfirmation).mockRejectedValue(new Error("resend exploded"));
    expect((await createBooking({ source: "webhook", stripePaymentIntentId: PI })).kind).toBe("created");
    expect(db.tables.pending_bookings[0].email_sent).toBe(false);
  });
});

describe("direct fulfilment — capture classification (§10 F-4)", () => {
  it("a bare 4xx (no Stripe type) with the auth still held → released, failed, nothing booked", async () => {
    capturePaymentIntent.mockRejectedValue(Object.assign(new Error("invalid request"), { statusCode: 400 }));
    stripeMock.paymentIntents.retrieve.mockResolvedValueOnce(pi()).mockResolvedValueOnce(pi());
    const out = await createBooking({ source: "webhook", stripePaymentIntentId: PI });
    expect(out).toMatchObject({ kind: "failed", userMessage: expect.stringMatching(/not been charged/) });
    expect(cancelPaymentIntent).toHaveBeenCalledWith(PI);
    expect(db.tables.bookings).toHaveLength(0);
    expect(db.tables.pending_bookings[0]).toMatchObject({ status: "released_failed", capture_attempts: 0 });
  });

  it("a 429 is transient → retryable, attempt counted, row handed back, auth held", async () => {
    capturePaymentIntent.mockRejectedValue(Object.assign(new Error("rate limited"), { statusCode: 429 }));
    const out = await createBooking({ source: "webhook", stripePaymentIntentId: PI });
    expect(out).toMatchObject({ kind: "needs_reconciliation", retryable: true });
    expect(db.tables.pending_bookings[0]).toMatchObject({ status: "pending", capture_attempts: 1, claimed_at: null });
    expect(cancelPaymentIntent).not.toHaveBeenCalled();
    expect(db.tables.bookings).toHaveLength(0);
  });

  it("the re-read finds the authorization cancelled → failed, released_failed, nothing booked", async () => {
    capturePaymentIntent.mockRejectedValue(stripeTransient());
    stripeMock.paymentIntents.retrieve.mockResolvedValueOnce(pi()).mockResolvedValueOnce(pi({ status: "canceled" }));
    const out = await createBooking({ source: "webhook", stripePaymentIntentId: PI });
    expect(out).toMatchObject({ kind: "failed" });
    expect(db.tables.pending_bookings[0].status).toBe("released_failed");
    expect(db.tables.bookings).toHaveLength(0);
    expect(cancelPaymentIntent).not.toHaveBeenCalled();
  });

  it("transient, transient, success across three calls → created with the SAME number; attempts 0, 1, 2 (fresh idempotency key each)", async () => {
    capturePaymentIntent
      .mockRejectedValueOnce(stripeTransient())
      .mockRejectedValueOnce(Object.assign(new Error("api error"), { statusCode: 500 }))
      .mockResolvedValueOnce({ status: "succeeded" });

    const first = await createBooking({ source: "webhook", stripePaymentIntentId: PI });
    expect(first).toMatchObject({ kind: "needs_reconciliation", retryable: true });
    const recorded = db.tables.pending_bookings[0].reslab_reservation_number;
    expect(recorded).toMatch(TRP);
    expect(db.tables.pending_bookings[0].capture_attempts).toBe(1);

    const second = await createBooking({ source: "sweep", stripePaymentIntentId: PI });
    expect(second).toMatchObject({ kind: "needs_reconciliation", retryable: true });
    expect(db.tables.pending_bookings[0]).toMatchObject({ capture_attempts: 2, reslab_reservation_number: recorded });

    const third = await createBooking({ source: "sweep", stripePaymentIntentId: PI });
    expect(third).toMatchObject({ kind: "created", reservationNumber: recorded });
    expect(capturePaymentIntent).toHaveBeenCalledTimes(3);
    expect(capturePaymentIntent.mock.calls.map((c) => c[1])).toEqual([0, 1, 2]);
    expect(db.tables.bookings).toHaveLength(1);
    expect(db.tables.bookings[0].reslab_reservation_number).toBe(recorded);
    expect(sendBookingConfirmation).toHaveBeenCalledTimes(1);
  });

  it("at the cap (2 attempts so far + another transient) → capture_ambiguous, not retried, auth NOT released", async () => {
    seed({ capture_attempts: 2, reslab_reservation_number: "TRP-AAAA1111" });
    capturePaymentIntent.mockRejectedValue(Object.assign(new Error("service unavailable"), { statusCode: 503 }));
    const out = await createBooking({ source: "sweep", stripePaymentIntentId: PI });
    expect(out).toMatchObject({ kind: "needs_reconciliation", retryable: false });
    expect(capturePaymentIntent).toHaveBeenCalledWith(PI, 2);
    expect(db.tables.pending_bookings[0]).toMatchObject({ status: "capture_ambiguous", capture_attempts: 3 });
    expect(cancelPaymentIntent).not.toHaveBeenCalled();
    expect(db.tables.bookings).toHaveLength(0);
  });
});

describe("direct fulfilment — releasing the payment", () => {
  it("a resume that finds the payment already captured and the stay over → REFUNDED, and told 'refunded', never 'not charged'", async () => {
    vi.setSystemTime(new Date("2026-10-26T12:00:00Z"));
    seed({ reslab_reservation_number: "TRP-AAAA1111" });
    stripeMock.paymentIntents.retrieve.mockResolvedValue(capturedPi());
    const out = await createBooking({ source: "sweep", stripePaymentIntentId: PI });
    expect(out).toMatchObject({ kind: "failed", reason: expect.stringMatching(/already ended/) });
    if (out.kind !== "failed") return;
    expect(out.userMessage).toMatch(/refunded/);
    expect(out.userMessage).not.toMatch(/not been charged/);
    expect(createRefund).toHaveBeenCalledWith(PI, undefined, `refund:${PI}`);
    expect(cancelPaymentIntent).not.toHaveBeenCalled();
    expect(capturePaymentIntent).not.toHaveBeenCalled();
    expect(db.tables.pending_bookings[0].status).toBe("refunded_failed");
    expect(db.tables.bookings).toHaveLength(0);
  });

  it("a block whose release THROWS → retryable, the row handed back to pending (never terminal with a live auth)", async () => {
    stripeMock.paymentIntents.retrieve.mockResolvedValue(pi({ amount: 6367 })); // money mismatch → blockDirect
    cancelPaymentIntent.mockRejectedValue(new Error("stripe 500"));
    const out = await createBooking({ source: "webhook", stripePaymentIntentId: PI });
    expect(out).toMatchObject({ kind: "needs_reconciliation", retryable: true });
    expect(cancelPaymentIntent).toHaveBeenCalledWith(PI);
    expect(db.tables.pending_bookings[0]).toMatchObject({ status: "pending", claimed_at: null });
    expect(alerts().some((m) => /could not be released/.test(m))).toBe(true);
    expect(capturePaymentIntent).not.toHaveBeenCalled();
  });

  it("authorized after check-in per the EXPANDED charge (the PaymentIntent itself is older) → released", async () => {
    vi.setSystemTime(new Date("2026-10-21T12:00:00Z"));
    // pi.created is Oct 12 (before check-in); the charge was authorized Oct 20 15:00Z,
    // after the 10:00 New York check-in. Reading pi.created alone would book it as "late".
    stripeMock.paymentIntents.retrieve.mockResolvedValue(
      pi({ latest_charge: { id: "ch_1", amount_refunded: 0, created: Math.floor(Date.parse("2026-10-20T15:00:00Z") / 1000) } })
    );
    const out = await createBooking({ source: "webhook", stripePaymentIntentId: PI });
    expect(out).toMatchObject({ kind: "failed", reason: expect.stringMatching(/authorized after check-in/) });
    expect(cancelPaymentIntent).toHaveBeenCalledWith(PI);
    expect(capturePaymentIntent).not.toHaveBeenCalled();
    expect(db.tables.pending_bookings[0].status).toBe("released_failed");
    expect(db.tables.bookings).toHaveLength(0);
  });
});

describe("direct fulfilment — a direct payment with NO staged row (Step 4, §9 H-A)", () => {
  beforeEach(() => {
    db.tables.pending_bookings = [];
  });

  it("authorized → cancelled, 'not charged', and the alert names the outcome AFTER the release", async () => {
    const out = await createBooking({ source: "webhook", stripePaymentIntentId: PI });
    expect(out).toMatchObject({ kind: "failed", userMessage: expect.stringMatching(/not been charged/) });
    expect(cancelPaymentIntent).toHaveBeenCalledWith(PI);
    expect(createRefund).not.toHaveBeenCalled();
    expect(capturePaymentIntent).not.toHaveBeenCalled();
    expect(alerts().some((m) => /No pending_bookings row/.test(m) && /payment cancelled$/.test(m))).toBe(true);
    // The alert is sent after the release, not before it.
    expect(vi.mocked(capturePaymentError).mock.invocationCallOrder.at(-1)).toBeGreaterThan(cancelPaymentIntent.mock.invocationCallOrder[0]);
    expect(db.tables.bookings).toHaveLength(0);
    expect(db.tables.pending_bookings).toHaveLength(0); // never self-created
    noReslab();
  });

  it("already captured → REFUNDED, told 'refunded', never 'not charged'", async () => {
    stripeMock.paymentIntents.retrieve.mockResolvedValue(capturedPi());
    const out = await createBooking({ source: "webhook", stripePaymentIntentId: PI });
    expect(out).toMatchObject({ kind: "failed" });
    if (out.kind !== "failed") return;
    expect(out.userMessage).toMatch(/refunded/);
    expect(out.userMessage).not.toMatch(/not been charged/);
    expect(createRefund).toHaveBeenCalledWith(PI, undefined, `refund:${PI}`);
    expect(cancelPaymentIntent).not.toHaveBeenCalled();
    expect(alerts().some((m) => /payment refunded$/.test(m))).toBe(true);
    expect(db.tables.pending_bookings).toHaveLength(0);
  });

  it("the release throws → needs_reconciliation, NOT retryable (nothing will ever look again), a by-hand alert", async () => {
    cancelPaymentIntent.mockRejectedValue(new Error("stripe 500"));
    const out = await createBooking({ source: "webhook", stripePaymentIntentId: PI });
    expect(out).toMatchObject({ kind: "needs_reconciliation", retryable: false });
    expect(cancelPaymentIntent).toHaveBeenCalledWith(PI);
    expect(alerts().some((m) => /could NOT be released/.test(m) && /by hand/.test(m))).toBe(true);
    // No "payment cancelled" claim when the release did not happen.
    expect(alerts().some((m) => /payment cancelled$/.test(m))).toBe(false);
    expect(db.tables.pending_bookings).toHaveLength(0);
  });
});

describe("direct fulfilment — lost cart claim whose release throws", () => {
  it("→ retryable, the row handed back to pending (claimed_at null), never suspected_duplicate with a live auth", async () => {
    db.tables.pending_bookings.push(directRow({ stripe_payment_intent_id: "pi_2" }));
    db.tables.direct_booking_terms.push(terms({ stripe_payment_intent_id: "pi_2" }));
    db.tables.cart_claims = [
      { id: "c1", cart_key: "test|ada@example.com|direct:1|2026-10-20 10:00:00|2026-10-25 10:00:00|direct", stripe_payment_intent_id: "pi_2", claimed_at: NOW.toISOString(), released_at: null },
    ];
    cancelPaymentIntent.mockRejectedValue(new Error("stripe 500"));
    const out = await createBooking({ source: "webhook", stripePaymentIntentId: PI });
    expect(out).toMatchObject({ kind: "needs_reconciliation", retryable: true });
    expect(cancelPaymentIntent).toHaveBeenCalledWith(PI);
    const row = db.tables.pending_bookings.find((r) => r.stripe_payment_intent_id === PI);
    expect(row).toMatchObject({ status: "pending", claimed_at: null });
    expect(db.tables.pending_bookings.some((r) => r.status === "suspected_duplicate")).toBe(false);
    expect(alerts().some((m) => /could not be released/.test(m))).toBe(true);
    expect(alerts().some((m) => /Duplicate direct cart detected/.test(m))).toBe(false);
    expect(capturePaymentIntent).not.toHaveBeenCalled();
    expect(db.tables.bookings).toHaveLength(0);
    // The other payment's cart claim is untouched.
    expect(db.tables.cart_claims).toEqual([expect.objectContaining({ stripe_payment_intent_id: "pi_2", released_at: null })]);
  });
});

describe("direct fulfilment — Step 3 (a booking already exists)", () => {
  const bookingRow = (over: Record<string, unknown> = {}) => ({
    id: "b1",
    stripe_payment_intent_id: PI,
    reslab_reservation_number: "TRP-AAAA1111",
    inventory_source: "direct",
    status: "confirmed",
    lot_notified_at: null,
    lot_notice_claimed_at: null,
    pg_sync_status: null,
    ...over,
  });

  it("while the main path holds a FRESH claim → in_progress; no sends, the row left processing", async () => {
    seed({ reslab_reservation_number: "TRP-AAAA1111", status: "processing", claimed_at: NOW.toISOString() });
    db.tables.bookings = [bookingRow()];
    stripeMock.paymentIntents.retrieve.mockResolvedValue(capturedPi());
    const out = await createBooking({ source: "webhook", stripePaymentIntentId: PI });
    expect(out).toEqual({ kind: "in_progress" });
    expect(resendSend).not.toHaveBeenCalled();
    expect(sendBookingConfirmation).not.toHaveBeenCalled();
    expect(db.tables.pending_bookings[0]).toMatchObject({ status: "processing", email_sent: false });
    expect(db.tables.bookings[0].lot_notified_at).toBeNull();
  });

  it("a booking cancelled since → no customer email and no lot notice", async () => {
    seed({ reslab_reservation_number: "TRP-AAAA1111", status: "pending" });
    db.tables.bookings = [bookingRow({ status: "cancelled" })];
    stripeMock.paymentIntents.retrieve.mockResolvedValue(capturedPi());
    const out = await createBooking({ source: "sweep", stripePaymentIntentId: PI });
    expect(out).toMatchObject({ kind: "already_exists", reservationNumber: "TRP-AAAA1111" });
    expect(resendSend).not.toHaveBeenCalled();
    expect(sendBookingConfirmation).not.toHaveBeenCalled();
    expect(db.tables.pending_bookings[0].email_sent).toBe(false);
    expect(db.tables.bookings[0]).toMatchObject({ status: "cancelled", lot_notified_at: null });
  });

  it("the booking status read fails → nothing sent, an alert that it could not read the booking", async () => {
    seed({ reslab_reservation_number: "TRP-AAAA1111", status: "pending" });
    db.tables.bookings = [bookingRow()];
    stripeMock.paymentIntents.retrieve.mockResolvedValue(capturedPi());
    // Fail ONLY the re-send's status read, not Step 3's idempotency read.
    db.failWhen("bookings", "select", () => db.selects.at(-1)?.select.startsWith("status, pg_sync_status") === true, "connection reset by peer");
    const out = await createBooking({ source: "sweep", stripePaymentIntentId: PI });
    expect(out).toMatchObject({ kind: "already_exists", reservationNumber: "TRP-AAAA1111" });
    expect(resendSend).not.toHaveBeenCalled();
    expect(sendBookingConfirmation).not.toHaveBeenCalled();
    expect(db.tables.pending_bookings[0].email_sent).toBe(false);
    expect(alerts().some((m) => /could not read the booking/.test(m))).toBe(true);
  });
});

describe("redriveDirectBookingSends — the sweep's direct send backstop", () => {
  const crashedRow = (over: Record<string, unknown> = {}) => ({
    id: "b1",
    stripe_payment_intent_id: PI,
    reslab_reservation_number: "TRP-AAAA1111",
    inventory_source: "direct",
    status: "confirmed",
    lot_notified_at: null,
    lot_notice_claimed_at: null,
    pg_sync_status: null,
    created_at: "2026-10-12T15:40:00.000Z",
    ...over,
  });
  // Captured, then partly refunded (e.g. a goodwill refund) — still a live booking.
  const partlyRefundedPi = () => pi({ status: "succeeded", latest_charge: { amount: 6366, amount_refunded: 1000 } });

  function seedCrashed(rowOver: Record<string, unknown> = {}, bookingOver: Record<string, unknown> = {}) {
    seed({ reslab_reservation_number: "TRP-AAAA1111", status: "completed", ...rowOver });
    db.tables.bookings = [crashedRow(bookingOver)];
  }

  it("a PARTIAL refund still gets the outstanding lot notice and customer email", async () => {
    seedCrashed();
    stripeMock.paymentIntents.retrieve.mockResolvedValue(partlyRefundedPi());
    await redriveDirectBookingSends(PI);
    expect(stripeMock.paymentIntents.retrieve).toHaveBeenCalledWith(PI, { expand: ["latest_charge"] });
    expect(resendSend).toHaveBeenCalledTimes(1);
    expect(db.tables.bookings[0].lot_notified_at).toBeTruthy();
    expect(sendBookingConfirmation).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendBookingConfirmation).mock.calls[0][0].confirmationNumber).toBe("TRP-AAAA1111");
    expect(db.tables.pending_bookings[0].email_sent).toBe(true);
    noReslab();
  });

  it("…the contrast: createBooking stops at its refund gate for the same payment and sends nothing", async () => {
    seedCrashed();
    stripeMock.paymentIntents.retrieve.mockResolvedValue(partlyRefundedPi());
    expect(await createBooking({ source: "sweep", stripePaymentIntentId: PI })).toEqual({ kind: "already_refunded" });
    expect(resendSend).not.toHaveBeenCalled();
    expect(sendBookingConfirmation).not.toHaveBeenCalled();
  });

  it("the customer email already went → only the lot notice is sent", async () => {
    seedCrashed({ email_sent: true });
    stripeMock.paymentIntents.retrieve.mockResolvedValue(capturedPi());
    await redriveDirectBookingSends(PI);
    expect(resendSend).toHaveBeenCalledTimes(1);
    expect(sendBookingConfirmation).not.toHaveBeenCalled();
  });

  it("a FULLY refunded charge → nothing sent, and the pending row is never read", async () => {
    seedCrashed();
    stripeMock.paymentIntents.retrieve.mockResolvedValue(pi({ status: "succeeded", latest_charge: { amount: 6366, amount_refunded: 6366 } }));
    await redriveDirectBookingSends(PI);
    expect(db.log.filter((q) => q.table === "pending_bookings")).toEqual([]);
    expect(db.log).toEqual([]);
    expect(resendSend).not.toHaveBeenCalled();
    expect(sendBookingConfirmation).not.toHaveBeenCalled();
    expect(db.tables.pending_bookings[0].email_sent).toBe(false);
    expect(db.tables.bookings[0].lot_notified_at).toBeNull();
  });

  describe("a cancellation in flight (or whose status write failed after the refund) still reads `confirmed`", () => {
    const cases = [
      ["cancel_state refund_issued", { cancel_state: "refund_issued" }],
      ["cancel_claimed_at set", { cancel_claimed_at: "2026-10-12T15:59:00.000Z" }],
    ] as const;

    it.each(cases)("%s → redriveDirectBookingSends sends nothing", async (_label, over) => {
      seedCrashed({}, over);
      stripeMock.paymentIntents.retrieve.mockResolvedValue(capturedPi());
      await redriveDirectBookingSends(PI);
      expect(resendSend).not.toHaveBeenCalled();
      expect(sendBookingConfirmation).not.toHaveBeenCalled();
      expect(db.tables.pending_bookings[0].email_sent).toBe(false);
      expect(db.tables.bookings[0]).toMatchObject({ lot_notified_at: null, lot_notice_claimed_at: null });
    });

    it.each(cases)("%s → a createBooking Step-3 re-drive sends nothing either", async (_label, over) => {
      seedCrashed({ status: "pending" }, over);
      stripeMock.paymentIntents.retrieve.mockResolvedValue(capturedPi());
      const out = await createBooking({ source: "webhook", stripePaymentIntentId: PI });
      expect(out).toMatchObject({ kind: "already_exists", reservationNumber: "TRP-AAAA1111" });
      expect(resendSend).not.toHaveBeenCalled();
      expect(sendBookingConfirmation).not.toHaveBeenCalled();
      expect(db.tables.pending_bookings[0].email_sent).toBe(false);
      expect(db.tables.bookings[0]).toMatchObject({ lot_notified_at: null, lot_notice_claimed_at: null });
    });
  });

  it("the main path holds a FRESH claim → nothing sent", async () => {
    seedCrashed({ status: "processing", claimed_at: NOW.toISOString() });
    stripeMock.paymentIntents.retrieve.mockResolvedValue(capturedPi());
    await redriveDirectBookingSends(PI);
    expect(resendSend).not.toHaveBeenCalled();
    expect(sendBookingConfirmation).not.toHaveBeenCalled();
    expect(db.tables.pending_bookings[0]).toMatchObject({ status: "processing", email_sent: false });
    expect(db.tables.bookings[0].lot_notified_at).toBeNull();
  });

  it("…a STALE claim (owner died) → the sends go", async () => {
    seedCrashed({ status: "processing", claimed_at: new Date(NOW.getTime() - 120_000).toISOString() });
    stripeMock.paymentIntents.retrieve.mockResolvedValue(capturedPi());
    await redriveDirectBookingSends(PI);
    expect(resendSend).toHaveBeenCalledTimes(1);
    expect(sendBookingConfirmation).toHaveBeenCalledTimes(1);
  });

  it("a ResLab PaymentIntent → nothing read, nothing sent", async () => {
    seedCrashed();
    stripeMock.paymentIntents.retrieve.mockResolvedValue(capturedPi());
    stripeMock.paymentIntents.retrieve.mockResolvedValue(pi({ status: "succeeded", latest_charge: { amount_refunded: 0 }, metadata: { lotId: "123" } }));
    await redriveDirectBookingSends(PI);
    expect(db.log).toEqual([]);
    expect(resendSend).not.toHaveBeenCalled();
    expect(sendBookingConfirmation).not.toHaveBeenCalled();
    noReslab();
  });

  it("the Stripe retrieve rejects → the promise REJECTS (the sweep counts it), nothing sent", async () => {
    seedCrashed();
    stripeMock.paymentIntents.retrieve.mockRejectedValue(new Error("stripe down"));
    await expect(redriveDirectBookingSends(PI)).rejects.toThrow(/stripe down/);
    expect(resendSend).not.toHaveBeenCalled();
    expect(sendBookingConfirmation).not.toHaveBeenCalled();
  });

  it("the pending-row read fails → the promise REJECTS, nothing sent", async () => {
    seedCrashed();
    stripeMock.paymentIntents.retrieve.mockResolvedValue(capturedPi());
    db.failOnce("pending_bookings", "select", "connection reset by peer");
    await expect(redriveDirectBookingSends(PI)).rejects.toThrow(/connection reset/);
    expect(resendSend).not.toHaveBeenCalled();
    expect(sendBookingConfirmation).not.toHaveBeenCalled();
  });

  describe("URGENT is judged as of the booking's created_at, not the re-send time", () => {
    // Check-in is 2026-10-20 10:00 New York = 14:00Z; the re-send runs at 16:00Z.
    beforeEach(() => {
      vi.setSystemTime(new Date("2026-10-20T16:00:00Z"));
    });

    it("stored BEFORE check-in, re-driven after it → a normal notice (no URGENT)", async () => {
      seedCrashed({}, { created_at: "2026-10-20T13:00:00.000Z" });
      stripeMock.paymentIntents.retrieve.mockResolvedValue(capturedPi());
      await redriveDirectBookingSends(PI);
      expect(resendSend).toHaveBeenCalledTimes(1);
      expect(lotSends()[0].subject).not.toMatch(/URGENT/);
      expect(lotSends()[0].subject).toMatch(/^\[TEST\] New Triply booking TRP-AAAA1111/);
    });

    it("stored AFTER check-in (within the stay) → URGENT", async () => {
      seedCrashed({}, { created_at: "2026-10-20T15:00:00.000Z" });
      stripeMock.paymentIntents.retrieve.mockResolvedValue(capturedPi());
      await redriveDirectBookingSends(PI);
      expect(resendSend).toHaveBeenCalledTimes(1);
      expect(lotSends()[0].subject).toMatch(/^\[TEST\] URGENT — late booking — /);
    });
  });
});

describe("direct fulfilment — the emails' cost breakdown (plan 2026-10-12)", () => {
  // Fixture: 5 days × $9.95 = 49.75, tax 16 % = 7.96, fee 5.95 → card 63.66;
  // Large SUV / truck $50.00 + $8.00 tax collected at the lot.
  it("both emails get an ok breakdown anchored to the charge, the at-lot surcharge outside it", async () => {
    const out = await createBooking({ source: "webhook", stripePaymentIntentId: PI });
    expect(out.kind).toBe("created");

    const b = vi.mocked(sendBookingConfirmation).mock.calls[0][0].breakdown;
    expect(b).toMatchObject({
      ok: true,
      source: "direct",
      totalLabel: "Charged to card",
      totalCents: 6366, // = pi.amount — the anchor
      atLot: { cents: 5800, surchargeCents: 5000, surchargeTaxCents: 800, vehicleSizeLabel: "Large SUV / truck" },
      tripTotalCents: 12166,
      tripTotalIsEstimate: true,
    });
    if (!b?.ok) return;
    expect(b.lines.map((l) => [l.label, l.cents])).toEqual([
      ["Parking — 5 days", 4975],
      ["Taxes", 796],
      ["Triply service fee", 595],
    ]);
    expect(vi.mocked(sendAdminBookingNotification).mock.calls[0][0].breakdown).toEqual(b);
    // An ok breakdown needs no anchored fallback.
    expect(vi.mocked(sendBookingConfirmation).mock.calls[0][0]).not.toHaveProperty("anchoredFallback");
    expect(vi.mocked(sendAdminBookingNotification).mock.calls[0][0]).not.toHaveProperty("anchoredFallback");
  });

  it("Park Guard: the plan line reads 'Plan A' and the charge includes it", async () => {
    const meta = { ...META, ...protectionMetadataPatch(getProtectionPlan("A")!) };
    seed({ has_protection_plan: true, protection_plan_code: "A" });
    stripeMock.paymentIntents.retrieve.mockResolvedValue(pi({ amount: 6366 + 1299, metadata: meta }));
    expect((await createBooking({ source: "webhook", stripePaymentIntentId: PI })).kind).toBe("created");
    const b = vi.mocked(sendBookingConfirmation).mock.calls[0][0].breakdown;
    expect(b).toMatchObject({ ok: true, totalCents: 7665 });
    expect(b?.ok && b.lines.find((l) => l.key === "protection")?.label).toBe("Parking Protection — Plan A");
  });

  it("a promo: the code from the payment (trimmed, upper-cased) labels the discount line", async () => {
    const meta = { ...META, discountPercent: "10", promoCode: " welcome10 ", directDiscountCents: "498", parkingOnlyChargeAmountCents: "5868" };
    stripeMock.paymentIntents.retrieve.mockResolvedValue(pi({ amount: 5868, metadata: meta }));
    expect((await createBooking({ source: "webhook", stripePaymentIntentId: PI })).kind).toBe("created");

    const b = vi.mocked(sendBookingConfirmation).mock.calls[0][0].breakdown;
    expect(b).toMatchObject({ ok: true, totalCents: 5868 });
    if (!b?.ok) return;
    expect(b.lines.find((l) => l.key === "promo")).toEqual({ key: "promo", label: "Promo discount (WELCOME10)", cents: 498, credit: true });
    const admin = vi.mocked(sendAdminBookingNotification).mock.calls[0][0].breakdown;
    expect(admin?.ok && admin.lines.find((l) => l.key === "promo")?.label).toBe("Promo discount (WELCOME10)");
  });

  it("the sweep's re-send carries the promo code too", async () => {
    seed({ reslab_reservation_number: "TRP-AAAA1111", status: "completed" });
    db.tables.bookings = [
      {
        id: "b1",
        stripe_payment_intent_id: PI,
        reslab_reservation_number: "TRP-AAAA1111",
        inventory_source: "direct",
        status: "confirmed",
        lot_notified_at: null,
        lot_notice_claimed_at: null,
        pg_sync_status: null,
        created_at: "2026-10-12T15:40:00.000Z",
      },
    ];
    const meta = { ...META, discountPercent: "10", promoCode: "welcome10", directDiscountCents: "498", parkingOnlyChargeAmountCents: "5868" };
    stripeMock.paymentIntents.retrieve.mockResolvedValue(pi({ status: "succeeded", amount: 5868, metadata: meta }));

    await redriveDirectBookingSends(PI);

    expect(sendBookingConfirmation).toHaveBeenCalledTimes(1);
    const b = vi.mocked(sendBookingConfirmation).mock.calls[0][0].breakdown;
    expect(b?.ok && b.lines.find((l) => l.key === "promo")?.label).toBe("Promo discount (WELCOME10)");
  });
});
