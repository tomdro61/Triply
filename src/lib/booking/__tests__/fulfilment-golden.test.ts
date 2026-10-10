/**
 * GOLDEN OUTPUT for the fulfilment engine (direct-lots Phase 4a plan,
 * notes/2026-10-09-direct-lots-phase4a-plan.md §4 + §6).
 *
 * Records EVERYTHING the engine produces for a set of ResLab reservation
 * shapes and failure paths: every table's final rows, the query log, every
 * ResLab / Stripe / Park Guard / email / Sentry call, and the result (also as
 * a JSON string — the pretty-printer sorts keys and keeps `undefined`, JSON
 * keeps order and drops `undefined`; both are observable).
 *
 * It exists to gate a behaviour-neutral refactor: this file and its .snap must
 * be byte-identical before and after. A snapshot change means the refactor
 * changed behaviour — stop; never "update the snapshot" to get past it.
 *
 * Fixture values are deliberately DISTINCT (ResLab name ≠ payload name,
 * location.id ≠ locationId, tax ≠ fees …): most ResLab reads sit behind a
 * payload-first `||`, and identical values would hide a mis-mapped field.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { FakeSupabase } from "./supabase-fake";

// ---------------------------------------------------------------------------
// Mocks — same boundaries as create-booking.test.ts (vi.mock is per file).
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
  getLocation: vi.fn(),
};

vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: async () => db,
}));

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
const { parkGuard, ParkGuardError } = await import("@/lib/parkguard/client");
const sentry = await import("@/lib/sentry");
const { sendBookingConfirmation } = await import("@/lib/resend/send-booking-confirmation");
const { sendAdminBookingNotification } = await import("@/lib/resend/send-admin-booking-notification");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PI = "pi_golden_1";
const FROM = "2026-08-14 10:00:00";
const TO = "2026-08-18 14:00:00";
const NOW = new Date("2026-08-01T12:00:00.000Z"); // mid-day UTC: same local date in every US zone

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
    location_name: "Payload Lot Name",
    location_address: "1 Payload Road",
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
    metadata: { customerEmail: "Ada.Lovelace@Example.com" } as Record<string, string>,
    latest_charge: null,
    ...over,
  };
}

/** A reservation as ResLab actually returns it: `cancelled` is 0/1, lat/lng are
 *  strings, shuttle/special text is HTML. Every value differs from the payload. */
function fullLocation(over: Record<string, unknown> = {}) {
  return {
    id: 4242,
    name: "ResLab Lot Name",
    address: "99 ResLab Avenue",
    city: "Jamaica",
    state: { code: "NY" },
    zip_code: "11430",
    phone: "+17185550199",
    latitude: "40.6675",
    longitude: "-73.7845",
    timezone: { code: "America/New_York" },
    shuttle_info_details: "<p>Shuttle every <b>15</b> minutes &amp; on request</p>",
    special_conditions: "<ul><li>No oversized vans</li></ul>",
    ...over,
  };
}

function fullHistory(over: Record<string, unknown> = {}) {
  return {
    id: 777,
    grand_total: 89.75,
    due_at_location_total: 21.5,
    subtotal: 81,
    total_tax: 6.5,
    total_fees: 2.25,
    location: fullLocation(),
    dates: [
      { id: 1, from_date: "2026-08-14 10:00:00", to_date: "2026-08-18 14:00:00", check_in: false, check_out: false },
    ],
    ...over,
  };
}

function wireReservation(num = "RTL900", over: Record<string, unknown> = {}) {
  return { reservation_number: num, cancelled: 0, history: [fullHistory()], ...over };
}

/** Plan A on the PaymentIntent (the metadata pair fulfilment books from). */
const PLAN_A_META = { protectionPlanCode: "A", protectionPlanPrice: "12.99" };

/** The default cost refresh: matches pendingRow, so the drift guard passes. */
function defaultCost() {
  return {
    costs_token: "tok_2",
    reservation: { sold_out: false, sub_total: 80, fees_total: 3, tax_total: 5, grand_total: 88, due_at_location: 20 },
  };
}

// ---------------------------------------------------------------------------
// Observation
// ---------------------------------------------------------------------------

function calls(fn: unknown) {
  return (fn as { mock: { calls: unknown[][] } }).mock.calls;
}

/** Errors are reduced to name + message (+ status), so Node versions can't
 *  change a snapshot through stack traces. */
function plain(value: unknown): unknown {
  if (value instanceof Error) {
    const status = (value as { status?: unknown }).status;
    return { error: value.name, message: value.message, ...(status !== undefined && { status }) };
  }
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]));
  }
  return value;
}

function observe(out: unknown) {
  return plain({
    outcome: out,
    outcomeJson: JSON.stringify(out),
    tables: structuredClone(db.tables),
    dbLog: [...db.log],
    reslab: {
      createReservation: calls(reslabMock.createReservation),
      getReservation: calls(reslabMock.getReservation),
      getCost: calls(reslabMock.getCost),
      getLocation: calls(reslabMock.getLocation),
    },
    stripe: {
      retrieve: calls(stripeMock.paymentIntents.retrieve),
      capturePaymentIntent: calls(capturePaymentIntent),
      cancelPaymentIntent: calls(cancelPaymentIntent),
      createRefund: calls(createRefund),
    },
    parkGuard: {
      captureReservation: calls(parkGuard.captureReservation),
      updateReservation: calls(parkGuard.updateReservation),
    },
    emails: {
      customer: calls(sendBookingConfirmation),
      admin: calls(sendAdminBookingNotification),
    },
    sentry: {
      capturePaymentError: calls(sentry.capturePaymentError),
      captureBookingError: calls(sentry.captureBookingError),
      captureParkGuardError: calls(sentry.captureParkGuardError),
      captureAPIError: calls(sentry.captureAPIError),
    },
  });
}

/** The client payload for the dev (`fulfilOnly`) path. */
function devPayload() {
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
    protectionPlanCode: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Only Date is faked: customer-link races a REAL setTimeout.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://golden.example");
  db.tables = { pending_bookings: [], bookings: [], cart_claims: [], customers: [] };
  db.log = [];
  db.clearFailures();
  reslabMock.getCost.mockReset().mockResolvedValue(defaultCost());
  reslabMock.createReservation.mockReset().mockResolvedValue(wireReservation());
  reslabMock.getLocation.mockReset().mockResolvedValue(undefined);
  reslabMock.getReservation.mockReset().mockImplementation(async (num: string) => wireReservation(num));
  stripeMock.paymentIntents.retrieve.mockReset();
  capturePaymentIntent.mockReset().mockResolvedValue({ status: "succeeded" });
  cancelPaymentIntent.mockReset().mockResolvedValue({ status: "canceled" });
  createRefund.mockReset().mockResolvedValue({ id: "re_1" });
  vi.mocked(parkGuard.captureReservation).mockReset().mockResolvedValue({ pg_identifier: "PG-GOLD-1", message: "ok" });
  vi.mocked(parkGuard.updateReservation).mockReset().mockResolvedValue({ pg_identifier: "PG-GOLD-1", message: "ok" });
  vi.mocked(sendBookingConfirmation).mockReset().mockResolvedValue({ success: true, emailId: "em_customer" });
  vi.mocked(sendAdminBookingNotification).mockReset().mockResolvedValue({ success: true, emailId: "em_admin" });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

/** Run a fulfilment from a staged row and return the observation. */
async function run(
  opts: {
    row?: Record<string, unknown>;
    pi?: Record<string, unknown>;
    source?: "client" | "complete" | "webhook" | "sweep";
    expectKind?: string;
  } = {}
) {
  db.seed("pending_bookings", [pendingRow(opts.row)]);
  stripeMock.paymentIntents.retrieve.mockResolvedValue(paymentIntent(opts.pi));
  const out = await createBooking({ source: opts.source ?? "webhook", stripePaymentIntentId: PI });
  expect(out.kind).toBe(opts.expectKind ?? "created");
  return observe(out);
}

const withPlanA = {
  row: { has_protection_plan: true, protection_plan_code: "A" },
  pi: { metadata: { customerEmail: "Ada.Lovelace@Example.com", ...PLAN_A_META } },
};

// ---------------------------------------------------------------------------
// Reservation shapes
// ---------------------------------------------------------------------------

describe("golden — reservation shapes", () => {
  it("full reservation, Plan A, webhook", async () => {
    expect(await run(withPlanA)).toMatchSnapshot();
  });

  it("full reservation, no protection, client", async () => {
    expect(await run({ source: "client" })).toMatchSnapshot();
  });

  it("zero money from ResLab (exercises ?? vs ||)", async () => {
    reslabMock.createReservation.mockResolvedValue(
      wireReservation("RTL901", { history: [fullHistory({ grand_total: 0, subtotal: 0, due_at_location_total: 0, total_tax: 0, total_fees: 0 })] })
    );
    expect(await run(withPlanA)).toMatchSnapshot();
  });

  it("grand_total absent (falls back to the payload), distinct from zero", async () => {
    const h = fullHistory();
    delete (h as Record<string, unknown>).grand_total;
    reslabMock.createReservation.mockResolvedValue(wireReservation("RTL902", { history: [h] }));
    expect(await run()).toMatchSnapshot();
  });

  it("payload money and name fields empty — every ResLab fallback is read", async () => {
    expect(
      await run({
        row: { subtotal: null, tax_total: null, fees_total: null, grand_total: null, location_name: null, location_address: null },
        ...{ pi: withPlanA.pi },
      })
    ).toMatchSnapshot();
  });

  it("location missing city and zip — Park Guard skipped for missing data", async () => {
    reslabMock.createReservation.mockResolvedValue(
      wireReservation("RTL903", { history: [fullHistory({ location: fullLocation({ city: undefined, zip_code: null }) })] })
    );
    expect(await run(withPlanA)).toMatchSnapshot();
  });

  it("location sparse — no phone, no state, no shuttle/special text", async () => {
    const loc = fullLocation({ state: null, shuttle_info_details: null });
    delete (loc as Record<string, unknown>).phone;
    delete (loc as Record<string, unknown>).special_conditions;
    reslabMock.createReservation.mockResolvedValue(wireReservation("RTL904", { history: [fullHistory({ location: loc })] }));
    expect(await run()).toMatchSnapshot();
  });

  it("no timezone or coordinates — the getLocation fallback supplies them", async () => {
    reslabMock.createReservation.mockResolvedValue(
      wireReservation("RTL905", {
        history: [fullHistory({ location: fullLocation({ timezone: null, latitude: null, longitude: undefined }) })],
      })
    );
    reslabMock.getLocation.mockResolvedValue({
      id: 4242,
      latitude: "40.6413",
      longitude: "-73.7781",
      timezone: { code: "America/New_York" },
    });
    expect(await run()).toMatchSnapshot();
  });

  it("no timezone or coordinates and getLocation rejects", async () => {
    reslabMock.createReservation.mockResolvedValue(
      wireReservation("RTL906", { history: [fullHistory({ location: fullLocation({ timezone: undefined, latitude: undefined, longitude: undefined }) })] })
    );
    reslabMock.getLocation.mockRejectedValue(new Error("location lookup 502"));
    expect(await run()).toMatchSnapshot();
  });

  it("history is an empty array (all fallbacks)", async () => {
    reslabMock.createReservation.mockResolvedValue(wireReservation("RTL907", { history: [] }));
    expect(await run(withPlanA)).toMatchSnapshot();
  });

  it("history key absent", async () => {
    const r = wireReservation("RTL908");
    delete (r as Record<string, unknown>).history;
    reslabMock.createReservation.mockResolvedValue(r);
    expect(await run()).toMatchSnapshot();
  });

  it("history is null", async () => {
    reslabMock.createReservation.mockResolvedValue(wireReservation("RTL909", { history: null }));
    expect(await run()).toMatchSnapshot();
  });

  it("history[0].location absent", async () => {
    const h = fullHistory();
    delete (h as Record<string, unknown>).location;
    reslabMock.createReservation.mockResolvedValue(wireReservation("RTL910", { history: [h] }));
    expect(await run(withPlanA)).toMatchSnapshot();
  });

  it("history[0].id is 0 (the response id falls through to the number)", async () => {
    reslabMock.createReservation.mockResolvedValue(wireReservation("RTL911", { history: [fullHistory({ id: 0 })] }));
    expect(await run()).toMatchSnapshot();
  });

  it("cancelled: 1 (ResLab sends a number)", async () => {
    reslabMock.createReservation.mockResolvedValue(wireReservation("RTL912", { cancelled: 1 }));
    expect(await run()).toMatchSnapshot();
  });

  it("dates absent", async () => {
    const h = fullHistory();
    delete (h as Record<string, unknown>).dates;
    reslabMock.createReservation.mockResolvedValue(wireReservation("RTL913", { history: [h] }));
    expect(await run()).toMatchSnapshot();
  });

  it("promo applied, money due at the lot", async () => {
    expect(
      await run({
        // online = 88 + 6 − 20 − 8 = 66
        pi: { amount: 6600, metadata: { customerEmail: "Ada.Lovelace@Example.com", promoCode: " save10 ", discountPercent: "10" } },
      })
    ).toMatchSnapshot();
  });

  it("wallet auto-capture (PI already succeeded)", async () => {
    expect(await run({ pi: { status: "succeeded", latest_charge: { amount_refunded: 0 } } })).toMatchSnapshot();
  });
});

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

describe("golden — sources", () => {
  for (const source of ["complete", "sweep"] as const) {
    it(`full reservation via ${source}`, async () => {
      expect(await run({ source })).toMatchSnapshot();
    });
  }

  it("dev path (fulfilOnly, no PaymentIntent)", async () => {
    const out = await createBooking({ source: "dev", stripePaymentIntentId: null, payload: devPayload() });
    expect(out.kind).toBe("created");
    expect(observe(out)).toMatchSnapshot();
  });
});

// ---------------------------------------------------------------------------
// Resume
// ---------------------------------------------------------------------------

describe("golden — resume", () => {
  it("adopts the recorded reservation (full body)", async () => {
    expect(await run({ ...withPlanA, row: { ...withPlanA.row, reslab_reservation_number: "RTL555" } })).toMatchSnapshot();
  });

  it("adopts a reservation whose re-read has no history", async () => {
    reslabMock.getReservation.mockImplementation(async (num: string) => wireReservation(num, { history: [] }));
    expect(await run({ row: { reslab_reservation_number: "RTL556" } })).toMatchSnapshot();
  });

  it("does not re-send emails when the row already recorded them", async () => {
    expect(
      await run({ row: { reslab_reservation_number: "RTL557", email_sent: true }, pi: { status: "succeeded", latest_charge: { amount_refunded: 0 } } })
    ).toMatchSnapshot();
  });

  it("insert fails after capture, then a re-drive resumes and completes", async () => {
    db.seed("pending_bookings", [pendingRow()]);
    stripeMock.paymentIntents.retrieve.mockResolvedValue(paymentIntent());
    db.failOnce("bookings", "insert", "connection reset");
    const first = await createBooking({ source: "webhook", stripePaymentIntentId: PI });
    expect(first.kind).toBe("needs_reconciliation");
    const firstObs = observe(first);

    stripeMock.paymentIntents.retrieve.mockResolvedValue(
      paymentIntent({ status: "succeeded", latest_charge: { amount_refunded: 0 } })
    );
    const second = await createBooking({ source: "webhook", stripePaymentIntentId: PI });
    expect(second.kind).toBe("created");
    expect({ first: firstObs, second: observe(second) }).toMatchSnapshot();
  });
});

// ---------------------------------------------------------------------------
// Failure paths that carry the reservation number
// ---------------------------------------------------------------------------

describe("golden — failure paths", () => {
  it("capture fails and the re-retrieve says it did not happen", async () => {
    db.seed("pending_bookings", [pendingRow()]);
    stripeMock.paymentIntents.retrieve
      .mockResolvedValueOnce(paymentIntent())
      .mockResolvedValueOnce(paymentIntent());
    capturePaymentIntent.mockRejectedValue(new Error("capture network error"));
    const out = await createBooking({ source: "webhook", stripePaymentIntentId: PI });
    expect(out.kind).toBe("needs_reconciliation");
    expect(observe(out)).toMatchSnapshot();
  });

  it("capture result unknown (re-retrieve throws)", async () => {
    db.seed("pending_bookings", [pendingRow()]);
    stripeMock.paymentIntents.retrieve
      .mockResolvedValueOnce(paymentIntent())
      .mockRejectedValueOnce(new Error("stripe unreachable"));
    capturePaymentIntent.mockRejectedValue(new Error("capture network error"));
    const out = await createBooking({ source: "webhook", stripePaymentIntentId: PI });
    expect(out.kind).toBe("needs_reconciliation");
    expect(observe(out)).toMatchSnapshot();
  });

  it("bookings insert rejected permanently (23514)", async () => {
    db.failOnce("bookings", "insert", "check constraint violated", "23514");
    expect(await run({ expectKind: "needs_reconciliation" })).toMatchSnapshot();
  });

  it("bookings insert duplicate PaymentIntent (23505) → already_exists", async () => {
    db.failOnce("bookings", "insert", "duplicate key value", "23505");
    expect(await run({ expectKind: "already_exists" })).toMatchSnapshot();
  });

  it("customers insert fails with Park Guard opted in", async () => {
    db.failOnce("customers", "insert", "customers insert exploded");
    expect(await run({ ...withPlanA, expectKind: "needs_reconciliation" })).toMatchSnapshot();
  });

  it("customer confirmation email rejects", async () => {
    vi.mocked(sendBookingConfirmation).mockRejectedValue(new Error("resend 500"));
    expect(await run()).toMatchSnapshot();
  });

  it("admin notification email rejects", async () => {
    vi.mocked(sendAdminBookingNotification).mockRejectedValue(new Error("resend 429"));
    expect(await run()).toMatchSnapshot();
  });

  it("Park Guard capture throws a ParkGuardError", async () => {
    vi.mocked(parkGuard.captureReservation).mockRejectedValue(new ParkGuardError(503, "PG down"));
    expect(await run(withPlanA)).toMatchSnapshot();
  });

  it("Park Guard captured but the local pg_identifier update is a duplicate (23505)", async () => {
    db.failWhen("bookings", "update", (p) => !!p && "pg_identifier" in p, "duplicate pg_identifier", "23505");
    expect(await run(withPlanA)).toMatchSnapshot();
  });

  it("Park Guard skipped for missing data and the skip-status update fails", async () => {
    reslabMock.createReservation.mockResolvedValue(
      wireReservation("RTL914", { history: [fullHistory({ location: fullLocation({ zip_code: "" }) })] })
    );
    db.failWhen("bookings", "update", (p) => !!p && p.pg_sync_status === "skipped_missing_data", "update timed out");
    expect(await run(withPlanA)).toMatchSnapshot();
  });
});
