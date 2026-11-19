/**
 * The report-only payment comparison (payment-compare.ts) at its four engine
 * call sites. Two things are proven here: each site reports what it should,
 * and NOTHING the comparison does can change a booking: the result, the
 * supplier call, the capture and every other report are identical when the
 * comparison throws at its entry or its reporter throws.
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
  // persistBooking's single fallback fetch for timezone + coordinates. Absent
  // from the mock it threw "not a function" (swallowed) and every airport test
  // would have passed with NULL, proving nothing.
  getLocation: vi.fn(),
};

vi.mock("@/lib/booking/reconciliation-alert", () => ({
  RECONCILIATION_ALERT_COLUMNS: "stripe_payment_intent_id, livemode, customer, location_name, airport_code, from_date, to_date, reslab_reservation_number, inventory_source",
  alertNeedsReconciliation: vi.fn(async () => ({ team: "discord", customer: "sent" })),
  scheduleReconciliationAlert: vi.fn(async () => undefined),
}));
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
  // The real sender resolves { success, emailId } and never throws on a Resend
  // error; fulfilment only counts an accepted send as sent.
  sendBookingConfirmation: vi.fn(async () => ({ success: true, emailId: "em_1" })),
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

const shadow = vi.hoisted(() => ({ explode: "none" as "none" | "entry" | "reporter" }));
vi.mock("../payment-compare", async () => {
  const actual = await vi.importActual<typeof import("../payment-compare")>("../payment-compare");
  const guarded = <A extends unknown[]>(fn: (...args: A) => void) => (...args: A) => {
    if (shadow.explode === "entry") throw new Error("comparison entry blew up");
    fn(...args);
  };
  return {
    ...actual,
    compareRequestWithPayment: guarded(actual.compareRequestWithPayment),
    comparePriceCheck: guarded(actual.comparePriceCheck),
    compareReservationWithPayment: guarded(actual.compareReservationWithPayment),
    noteUnstagedPayment: guarded(actual.noteUnstagedPayment),
  };
});
vi.mock("@/lib/sentry", () => ({
  capturePaymentError: vi.fn(),
  captureBookingError: vi.fn(),
  captureParkGuardError: vi.fn(),
  captureAPIError: vi.fn(),
  capturePaymentCompare: vi.fn(),
}));

const { createBooking } = await import("../create-booking");


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
    inventory_source: "reslab",
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

const sentry = await import("@/lib/sentry");
const { capturePaymentCompare } = sentry;
const { sendBookingConfirmation } = await import("@/lib/resend/send-booking-confirmation");
const { sendAdminBookingNotification } = await import("@/lib/resend/send-admin-booking-notification");
const { parkGuard } = await import("@/lib/parkguard/client");
const { scheduleReconciliationAlert } = await import("@/lib/booking/reconciliation-alert");

/** Everything checkout records that the comparison reads, agreeing with pendingRow(). */
const META = {
  customerEmail: "Ada.Lovelace@Example.com",
  inventorySource: "reslab",
  locationId: "42",
  parkingTypeId: "7",
  checkin: "2026-08-14",
  checkout: "2026-08-18",
  checkinTime: "10:00 AM",
  checkoutTime: "2:00 PM",
  serviceFee: "6",
};
/** grand 88 − due at the lot 20 + service fee 6, in cents. */
const AMOUNT = 7400;
/** A $5 discount stamp on the same booking, as checkout writes it. */
const STAMPED = { ...META, promoCode: "JFK5", discountCents: "500", onlineParkingCents: "6800", preDiscountOnlineCents: "7400", parkingOnlyChargeAmountCents: "6900" };

function requestPayload(over: Record<string, unknown> = {}) {
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
    airportCode: "JFK",
    subtotal: 80,
    taxTotal: 5,
    feesTotal: 3,
    grandTotal: 88,
    triplyServiceFee: 6,
    userId: null,
    stripePaymentIntentId: PI,
    protectionPlanCode: null,
    ...over,
  };
}

/** The supplier's reservation with its dates, as a real one carries them. */
function datedReservation(dates = [{ from_date: FROM, to_date: TO }]) {
  const reservation = reslabReservation();
  Object.assign(reservation.history[0], { dates });
  return reservation;
}

type Site = "request" | "unstaged" | "price_check" | "reservation";
const reports = (site: Site) => vi.mocked(capturePaymentCompare).mock.calls.filter(([s]) => s === site);
const outcomes = (site: Site) => reports(site).map(([, outcome]) => outcome);
const sitesReached = () => [...new Set(vi.mocked(capturePaymentCompare).mock.calls.map(([site]) => site))].sort();

function seed(meta: Record<string, string> = META, amount = AMOUNT, row: Record<string, unknown> = {}) {
  db.seed("pending_bookings", [pendingRow(row)]);
  stripeMock.paymentIntents.retrieve.mockResolvedValue(paymentIntent({ amount, metadata: meta }));
}

const calls = (fn: unknown) => [...vi.mocked(fn as (...args: unknown[]) => unknown).mock.calls];
const withoutClock = (rows: unknown[]) =>
  (rows as Record<string, unknown>[]).map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => !/_at$/.test(key))));

/** Everything a fulfilment leaves behind, apart from the comparison's own reports and the clock. */
function footprint(out: unknown) {
  return {
    out,
    reslab: {
      createReservation: calls(reslabMock.createReservation),
      getCost: calls(reslabMock.getCost),
      getReservation: calls(reslabMock.getReservation),
      getLocation: calls(reslabMock.getLocation),
    },
    stripe: { capture: calls(capturePaymentIntent), cancel: calls(cancelPaymentIntent), refund: calls(createRefund) },
    parkGuard: { capture: calls(parkGuard.captureReservation), update: calls(parkGuard.updateReservation) },
    emails: { customer: calls(sendBookingConfirmation), admin: calls(sendAdminBookingNotification) },
    alerts: calls(scheduleReconciliationAlert),
    tables: {
      bookings: withoutClock(db.tables.bookings),
      pending: withoutClock(db.tables.pending_bookings),
      cartClaims: withoutClock(db.tables.cart_claims),
      customers: withoutClock(db.tables.customers),
    },
    sentry: {
      payment: calls(sentry.capturePaymentError).map(([error]) => (error as Error).message),
      booking: calls(sentry.captureBookingError).map(([error]) => (error as Error).message),
      parkGuard: calls(sentry.captureParkGuardError).length,
      api: calls(sentry.captureAPIError).length,
    },
  };
}

beforeEach(() => {
  shadow.explode = "none";
  vi.mocked(capturePaymentCompare).mockReset();
  reslabMock.createReservation.mockResolvedValue(datedReservation());
});

describe("what each site reports", () => {
  it("a booking that agrees with its payment record reports a match at every site", async () => {
    seed();
    const out = await createBooking({ source: "client", stripePaymentIntentId: PI, payload: requestPayload() });

    expect(out.kind).toBe("created");
    expect(outcomes("request")).toEqual(["match"]);
    expect(reports("request")[0][2].tags).toEqual({
      "check.payload_source": "request",
      "check.attempt": "first",
      "check.discount_stamp": "no",
      "check.row_vs_request": "same",
      "check.fee": "same",
    });
    expect(outcomes("price_check")).toEqual(["match"]);
    expect(outcomes("reservation")).toEqual(["match"]);
    expect(reports("reservation")[0][2].tags).toEqual({
      "check.amount": "0",
      "check.amount_direction": "exact",
      "check.lot": "match",
      "check.dates": "match",
      "check.times": "match",
    });
    expect(outcomes("unstaged")).toEqual([]);
  });

  it("reservation dates returned as midnight still match on the days", async () => {
    seed();
    reslabMock.createReservation.mockResolvedValue(datedReservation([{ from_date: "2026-08-14 00:00:00", to_date: "2026-08-18 00:00:00" }]));
    await createBooking({ source: "webhook", stripePaymentIntentId: PI });
    expect(outcomes("reservation")).toEqual(["match"]);
    expect(reports("reservation")[0][2].tags).toMatchObject({ "check.dates": "match", "check.times": "midnight_only" });
  });

  it("a fulfilment from the staged row says so", async () => {
    seed();
    await createBooking({ source: "webhook", stripePaymentIntentId: PI });
    expect(reports("request")[0][2].tags).toMatchObject({ "check.payload_source": "row", "check.fee": "same" });
    expect(reports("request")[0][2].tags).not.toHaveProperty("check.row_vs_request");
  });

  it("reports a lot that differs from the payment record", async () => {
    seed({ ...META, locationId: "43" });
    await createBooking({ source: "webhook", stripePaymentIntentId: PI });
    expect(outcomes("request")).toEqual(["differs"]);
    expect(reports("request")[0][2].detail).toMatchObject({ fields: ["lot"], paymentLot: 43, usedLot: 42 });
  });

  it("reports a request that differs from its staged row under its own outcome", async () => {
    seed();
    await createBooking({
      source: "client",
      stripePaymentIntentId: PI,
      payload: requestPayload({ customer: { ...pendingRow().customer, phone: "555-0199" }, parkingTypeId: 8 }),
    });
    expect(outcomes("request")).toEqual(["differs"]);
    expect(reports("request")[0][2]).toMatchObject({
      tags: { "check.row_vs_request": "differs" },
      detail: { fields: ["parkingType"], rowVsRequestFields: ["parkingType"] },
    });
  });

  it("reports a time that differs on the same day", async () => {
    seed({ ...META, checkoutTime: "11:30 PM" });
    await createBooking({ source: "webhook", stripePaymentIntentId: PI });
    expect(reports("request")[0][2].detail).toMatchObject({ fields: ["to"] });
  });

  it("reports which keys of the payment record are unusable", async () => {
    seed({ customerEmail: META.customerEmail });
    const out = await createBooking({ source: "webhook", stripePaymentIntentId: PI });
    expect(out.kind).toBe("created");
    expect(outcomes("request")).toEqual(["payment_record_unusable"]);
    expect(reports("request")[0][2].detail).toMatchObject({
      unusableKeys: ["locationId", "parkingTypeId", "checkin", "checkout", "checkinTime", "checkoutTime"],
    });
  });

  it("a service fee that differs from the payment record is its own outcome, never a match", async () => {
    seed(META, AMOUNT, { triply_service_fee: "5.95" });
    await createBooking({ source: "webhook", stripePaymentIntentId: PI });
    expect(outcomes("request")).toEqual(["fee_differs"]);
    expect(reports("request")[0][2]).toMatchObject({ tags: { "check.fee": "differs" }, detail: { incomingFeeCents: 595, paymentFeeCents: 600 } });
  });

  it("a service fee that cannot be read is its own outcome, never a match", async () => {
    seed({ ...META, serviceFee: "six" });
    await createBooking({ source: "webhook", stripePaymentIntentId: PI });
    expect(outcomes("request")).toEqual(["fee_unknown"]);
    expect(outcomes("price_check")).toEqual(["fee_unreadable"]);
  });

  it("on a payment with a discount stamp the fee compared is the one that came in", async () => {
    seed(STAMPED, 6900, { triply_service_fee: "5.95" });
    const out = await createBooking({ source: "webhook", stripePaymentIntentId: PI });
    expect(out.kind).toBe("created");
    expect(reports("request")[0][2]).toMatchObject({
      tags: { "check.discount_stamp": "yes", "check.fee": "differs" },
      detail: { incomingFeeCents: 595, paymentFeeCents: 600 },
    });
    // The price-check site belongs to payments with no stamp.
    expect(outcomes("price_check")).toEqual([]);
    expect(reports("reservation")[0][2].tags).toMatchObject({ "check.amount": "0" });
  });

  it("reports a payment that reaches fulfilment with no staged row", async () => {
    stripeMock.paymentIntents.retrieve.mockResolvedValue(paymentIntent({ amount: AMOUNT, metadata: META }));
    await createBooking({ source: "client", stripePaymentIntentId: PI, payload: requestPayload() });
    expect(outcomes("unstaged")).toEqual(["no_staged_row"]);
    expect(reports("unstaged")[0][2].tags).toEqual({ "check.source_stamped": "yes" });
  });

  it("price check: reports each way the payment's fee would change the result", async () => {
    seed(META, AMOUNT, { triply_service_fee: "10.00" });
    await createBooking({ source: "webhook", stripePaymentIntentId: PI });
    expect(outcomes("price_check")).toEqual(["payment_fee_within"]);
    expect(reports("price_check")[0][2].detail).toEqual({ freshCents: 7800, withPaymentFeeCents: 7400, authorisedCents: 7400 });

    vi.mocked(capturePaymentCompare).mockReset();
    db.tables = { pending_bookings: [], bookings: [], cart_claims: [], customers: [] };
    seed(META, 7000, { triply_service_fee: "2.00" });
    await createBooking({ source: "webhook", stripePaymentIntentId: PI });
    expect(outcomes("price_check")).toEqual(["payment_fee_over"]);
  });

  it("reservation: a different amount and lot are reported in their own tags", async () => {
    seed();
    const other = datedReservation();
    other.history[0].grand_total = 90.5;
    other.history[0].location.id = 77;
    reslabMock.createReservation.mockResolvedValue(other);
    await createBooking({ source: "webhook", stripePaymentIntentId: PI });
    expect(outcomes("reservation")).toEqual(["differs"]);
    expect(reports("reservation")[0][2]).toMatchObject({
      tags: { "check.amount": "over_100c", "check.amount_direction": "charged_less", "check.lot": "mismatch" },
      detail: { differenceCents: -250 },
    });
  });

  it("reservation: a missing figure is unknown, never 0 and never a match", async () => {
    seed();
    const partial = datedReservation();
    Reflect.deleteProperty(partial.history[0], "due_at_location_total");
    reslabMock.createReservation.mockResolvedValue(partial);
    await createBooking({ source: "webhook", stripePaymentIntentId: PI });
    expect(outcomes("reservation")).toEqual(["differs"]);
    expect(reports("reservation")[0][2]).toMatchObject({
      tags: { "check.amount": "unknown", "check.amount_direction": "unknown" },
      detail: { differenceCents: "unknown", unknownFigures: ["due"] },
    });
  });

  it("a resume adopts the reservation: the request is reported again as a resume, the rest is not", async () => {
    seed(META, AMOUNT, { reslab_reservation_number: "RTL555" });
    const out = await createBooking({ source: "webhook", stripePaymentIntentId: PI });
    expect(out.kind).toBe("created");
    expect(reslabMock.getReservation).toHaveBeenCalledWith("RTL555");
    expect(reslabMock.createReservation).not.toHaveBeenCalled();
    expect(outcomes("request")).toEqual(["match"]);
    expect(reports("request")[0][2].tags).toMatchObject({ "check.attempt": "resume" });
    expect(outcomes("reservation")).toEqual([]);
    expect(outcomes("price_check")).toEqual([]);
  });

  it("no report carries the customer's details or the price lock", async () => {
    seed({ ...META, checkoutTime: "11:30 PM" }, AMOUNT, { triply_service_fee: "5.95" });
    await createBooking({ source: "client", stripePaymentIntentId: PI, payload: requestPayload({ locationId: 43 }) });
    expect(sitesReached()).toEqual(["price_check", "request", "reservation"]);
    const sent = JSON.stringify(vi.mocked(capturePaymentCompare).mock.calls).toLowerCase();
    for (const secret of ["ada", "lovelace", "example.com", "555-0100", "abc123", "tok_1", "tok_2", "volvo"]) {
      expect(sent).not.toContain(secret);
    }
  });
});

describe("the comparison never changes a fulfilment", () => {
  const scenarios: Array<{ name: string; kind: string; sites: Site[]; run: () => Promise<{ kind: string }> }> = [
    {
      name: "browser request",
      kind: "created",
      sites: ["price_check", "request", "reservation"],
      run: () => {
        seed();
        return createBooking({ source: "client", stripePaymentIntentId: PI, payload: requestPayload() });
      },
    },
    {
      name: "webhook from the staged row",
      kind: "created",
      sites: ["price_check", "request", "reservation"],
      run: () => {
        seed();
        return createBooking({ source: "webhook", stripePaymentIntentId: PI });
      },
    },
    {
      name: "no staged row",
      kind: "created",
      sites: ["price_check", "request", "reservation", "unstaged"],
      run: () => {
        stripeMock.paymentIntents.retrieve.mockResolvedValue(paymentIntent({ amount: AMOUNT, metadata: META }));
        return createBooking({ source: "client", stripePaymentIntentId: PI, payload: requestPayload() });
      },
    },
    {
      name: "price above the authorised amount",
      kind: "failed",
      sites: ["price_check", "request"],
      run: () => {
        seed(META, 7000);
        return createBooking({ source: "webhook", stripePaymentIntentId: PI });
      },
    },
    {
      name: "a payment record that disagrees and will not fully read",
      kind: "created",
      sites: ["price_check", "request", "reservation"],
      run: () => {
        seed({ ...META, locationId: "99", serviceFee: "nope" });
        return createBooking({ source: "client", stripePaymentIntentId: PI, payload: requestPayload() });
      },
    },
    {
      name: "a payment with a discount stamp",
      kind: "created",
      sites: ["request", "reservation"],
      run: () => {
        seed(STAMPED, 6900);
        return createBooking({ source: "webhook", stripePaymentIntentId: PI });
      },
    },
    {
      name: "a resume",
      kind: "created",
      sites: ["request"],
      run: () => {
        seed(META, AMOUNT, { reslab_reservation_number: "RTL555" });
        return createBooking({ source: "webhook", stripePaymentIntentId: PI });
      },
    },
  ];

  async function runFresh(run: () => Promise<{ kind: string }>, explode: typeof shadow.explode) {
    vi.clearAllMocks();
    db.tables = { pending_bookings: [], bookings: [], cart_claims: [], customers: [] };
    db.log = [];
    reslabMock.getCost.mockResolvedValue({
      costs_token: "tok_2",
      reservation: { sold_out: false, sub_total: 80, fees_total: 3, tax_total: 5, grand_total: 88, due_at_location: 20 },
    });
    reslabMock.createReservation.mockResolvedValue(datedReservation());
    reslabMock.getLocation.mockResolvedValue(undefined);
    reslabMock.getReservation.mockImplementation(async (num: string) => reslabReservation(num));
    capturePaymentIntent.mockResolvedValue({ status: "succeeded" });
    cancelPaymentIntent.mockResolvedValue({ status: "canceled" });
    createRefund.mockResolvedValue({ id: "re_1" });
    shadow.explode = explode;
    vi.mocked(capturePaymentCompare).mockReset();
    if (explode === "reporter") {
      vi.mocked(capturePaymentCompare).mockImplementation(() => {
        throw new Error("reporter blew up");
      });
    }
    const out = await run();
    return { footprint: footprint(out), kind: out.kind, sites: sitesReached(), reportCalls: vi.mocked(capturePaymentCompare).mock.calls.length };
  }

  for (const { name, kind, sites, run } of scenarios) {
    it(`${name}: identical when every comparison throws at its entry`, async () => {
      const baseline = await runFresh(run, "none");
      // The scenario really is what it says, and really passes through the sites.
      expect(baseline.kind).toBe(kind);
      expect(baseline.sites).toEqual(sites);

      const thrown = await runFresh(run, "entry");
      expect(thrown.reportCalls).toBe(0);
      expect(thrown.footprint).toEqual(baseline.footprint);
    });

    it(`${name}: identical when the reporter throws`, async () => {
      const baseline = await runFresh(run, "none");
      const thrown = await runFresh(run, "reporter");
      expect(thrown.reportCalls).toBeGreaterThanOrEqual(sites.length);
      expect(thrown.footprint).toEqual(baseline.footprint);
    });
  }

  it("the price check still refuses when the comparison throws inside it", async () => {
    const refused = await runFresh(scenarios[3].run, "entry");
    expect(refused.kind).toBe("failed");
    expect(refused.footprint.reslab.createReservation).toEqual([]);
    expect(refused.footprint.stripe.cancel).toHaveLength(1);
  });
});
