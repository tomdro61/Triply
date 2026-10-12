/**
 * /api/reservations/pending — DIRECT branch (4b plan §3.1; plan A-29 / B10;
 * vehicle-surcharge plan §1.5, R4, R5). Fails CLOSED before the card is
 * confirmed: every refusal leaves nothing written. A valid request writes the
 * service-role terms row FIRST, then the pending row, with every amount from
 * the PaymentIntent's metadata and the snapshot / size label / partner terms
 * from one bounded lot read. Cross-source both ways: a ResLab body cannot bind
 * to a direct PaymentIntent and vice versa.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";

const { db, stripeMock, quoteMock, identityMock } = await vi.hoisted(async () => {
  const { FakeSupabase } = await import("@/lib/booking/__tests__/supabase-fake");
  return {
    db: new FakeSupabase(),
    stripeMock: { paymentIntents: { retrieve: vi.fn() } },
    quoteMock: vi.fn(),
    identityMock: vi.fn(),
  };
});

vi.mock("@/lib/supabase/server", () => ({ createAdminClient: async () => db }));
vi.mock("@/lib/stripe/client", () => ({ stripe: stripeMock }));
vi.mock("@/lib/reslab/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/reslab/client")>()),
  reslab: { getLocation: vi.fn().mockResolvedValue({ id: 42, extra_fields: [] }) },
}));
vi.mock("@/lib/sentry", () => ({
  capturePaymentError: vi.fn(),
  captureBookingError: vi.fn(),
  captureRequiredFieldCheck: vi.fn(),
  captureAPIError: vi.fn(),
}));
vi.mock("@/lib/direct/checkout-quote", () => ({ quoteDirectCheckout: quoteMock }));
vi.mock("@/lib/booking/customer-link", () => ({ sessionIdentityFromRequest: identityMock }));

import { POST } from "../pending/route";
import { capturePaymentError, captureBookingError } from "@/lib/sentry";
import { getProtectionPlan, protectionMetadataPatch } from "@/lib/parkguard/plans";
import { encodeSurchargeRates } from "@/lib/direct/vehicle-surcharge-metadata";
import { directLotFromRow, type DirectLot } from "@/lib/direct/store";
import { directLotRow } from "@/lib/direct/__tests__/fixtures";
import { parseLotSnapshotV2 } from "@/lib/direct/lot-snapshot";

/** What Stripe stores: a key sent with an empty value is UNSET (also on create). */
const asStripeStores = (meta: Record<string, string | undefined>) =>
  Object.fromEntries(Object.entries(meta).filter(([, v]) => v !== "" && v !== undefined)) as Record<string, string>;

const PI = "pi_direct_pending";
/** Oct 10 10:00 AM → Oct 15 10:00 AM: 5 days × $9.95, 16 % tax, $5.95 fee = $63.66 before Park Guard. */
const DIRECT_META: Record<string, string | undefined> = {
  inventorySource: "direct",
  lotId: "direct-1",
  directLotId: "1",
  customerEmail: "ada@example.com",
  checkin: "2026-10-10",
  checkinTime: "10:00 AM",
  checkout: "2026-10-15",
  checkoutTime: "10:00 AM",
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
const PARKING_CENTS = 6366;

function lot(overrides: Record<string, unknown> = {}): DirectLot {
  const out = directLotFromRow(directLotRow({ tax_rate_percent: 16, ...overrides }));
  if (!out.lot) throw new Error(`fixture lot did not parse: ${"reason" in out ? out.reason : "?"}`);
  return out.lot;
}

function directBody(over: Record<string, unknown> = {}) {
  return {
    inventorySource: "direct",
    lotId: "direct-1",
    fromDate: "2026-10-10 10:00:00",
    toDate: "2026-10-15 10:00:00",
    customer: { firstName: "Ada", lastName: "L", email: "ada@example.com", phone: "555" },
    vehicle: { make: "Ford", model: "F-150", color: "Black", licensePlate: "ABC", state: "NY" },
    stripePaymentIntentId: PI,
    protectionPlanCode: null,
    vehicleSize: "large_suv_truck",
    vehicleSizeSource: "modal",
    confirmationParams: { lot: "direct-1", checkin: "2026-10-10" },
    ...over,
  };
}
const post = (body: unknown) =>
  POST(new NextRequest("http://localhost/api/reservations/pending", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }));

/** The PaymentIntent Stripe returns; the amount follows the metadata unless overridden. */
function withPi(meta: Record<string, string | undefined>, over: { amount?: number; status?: string } = {}) {
  const premiumCents = meta.protectionPlanPrice ? Math.round(parseFloat(meta.protectionPlanPrice) * 100) : 0;
  stripeMock.paymentIntents.retrieve.mockResolvedValue({
    id: PI,
    amount: over.amount ?? PARKING_CENTS + premiumCents,
    livemode: false,
    status: over.status ?? "requires_payment_method",
    metadata: asStripeStores(meta),
  });
}
const withMeta = (meta: Record<string, string | undefined>) => withPi(meta);

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("DIRECT_CHECKOUT_PREVIEW", "true");
  vi.stubEnv("NEXT_PUBLIC_APP_ENV", "staging"); // the flag is honoured on an allowlist only
  db.tables = { pending_bookings: [], bookings: [], direct_booking_terms: [] };
  db.clearFailures();
  db.log = [];
  withMeta(DIRECT_META);
  quoteMock.mockImplementation(async () => ({ ok: true, lot: lot(), days: 5, quote: {} }));
  identityMock.mockResolvedValue({ identity: null, reason: "guest" });
});
afterEach(() => vi.unstubAllEnvs());

const nothingWritten = () => {
  expect(db.tables.pending_bookings).toHaveLength(0);
  expect(db.tables.direct_booking_terms).toHaveLength(0);
};

describe("POST /api/reservations/pending — direct, staged", () => {
  it("a valid large-SUV booking writes the terms row, then the pending row, all money from the PaymentIntent", async () => {
    const res = await post(directBody());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ staged: true });
    expect(capturePaymentError).not.toHaveBeenCalled();

    // Terms first (F-7), then the row.
    const writes = db.log.filter((l) => l.op === "insert").map((l) => l.table);
    expect(writes).toEqual(["direct_booking_terms", "pending_bookings"]);

    expect(db.tables.direct_booking_terms[0]).toMatchObject({
      stripe_payment_intent_id: PI,
      direct_lot_id: "1",
      livemode: false,
      partner_share_percent: 80,
      tax_rate_percent: 16, // the PaymentIntent's rate (B8)
      tax_collected_by: "lot",
      lot_recipients: ["tom@triplypro.com"],
    });

    const row = db.tables.pending_bookings[0];
    expect(row).toMatchObject({
      stripe_payment_intent_id: PI,
      status: "pending",
      inventory_source: "direct",
      direct_lot_id: "1",
      location_id: null,
      parking_type_id: null,
      costs_token: null,
      from_date: "2026-10-10 10:00:00",
      to_date: "2026-10-15 10:00:00",
      location_name: "The Parking Point JFK",
      location_address: "150-57 183rd St, Springfield Gardens, NY 11413",
      airport_code: "JFK",
      subtotal: 49.75,
      tax_total: 7.96,
      fees_total: 0,
      grand_total: 57.71,
      triply_service_fee: 5.95,
      has_protection_plan: false,
      protection_plan_code: null,
      livemode: false,
      user_id: null,
      vehicle_size: "large_suv_truck",
      vehicle_size_label: "Large SUV / truck",
      vehicle_surcharge_cents: 5000, // 5 days × $10
      vehicle_surcharge_tax_cents: 800, // 16 %
      vehicle_size_source: "modal",
      confirmation_params: { lot: "direct-1", checkin: "2026-10-10" },
    });
    // The customer-safe v2 snapshot: no notice recipients (038 CHECK).
    const snap = parseLotSnapshotV2(row.lot_snapshot);
    expect(snap).not.toBeNull();
    expect(snap?.v).toBe(2);
    expect(row.lot_snapshot).not.toHaveProperty("notificationEmails");
  });

  it("'none' stores the 'No oversized vehicle' label and a zero estimate", async () => {
    expect((await post(directBody({ vehicleSize: "none" }))).status).toBe(200);
    expect(db.tables.pending_bookings[0]).toMatchObject({
      vehicle_size: "none",
      vehicle_size_label: "No oversized vehicle",
      vehicle_surcharge_cents: 0,
      vehicle_surcharge_tax_cents: 0,
    });
  });

  it.each(["A", "B", "C"] as const)("Plan %s on the payment + the same in the body stages that tier", async (code) => {
    withMeta({ ...DIRECT_META, ...protectionMetadataPatch(getProtectionPlan(code)!) });
    const res = await post(directBody({ protectionPlanCode: code }));
    expect(res.status).toBe(200);
    expect(db.tables.pending_bookings[0]).toMatchObject({ has_protection_plan: true, protection_plan_code: code });
    expect(capturePaymentError).not.toHaveBeenCalled();
  });

  it("the signed-in session user is staged (never the body's userId)", async () => {
    identityMock.mockResolvedValue({ identity: { userId: "u_session", email: "ada@example.com" }, reason: "ok" });
    await post(directBody({ userId: "u_body" }));
    expect(db.tables.pending_bookings[0].user_id).toBe("u_session");
    expect(captureBookingError).toHaveBeenCalled(); // the body disagreed
  });

  it("a lot with NO surcharges survives Stripe: 'none' is stored, binds, stages", async () => {
    withMeta({ ...DIRECT_META, directSurcharges: encodeSurchargeRates([]) });
    quoteMock.mockResolvedValue({ ok: true, lot: lot({ vehicle_surcharges: [] }), days: 5, quote: {} });
    expect((await post(directBody({ vehicleSize: "none" }))).status).toBe(200);
    expect(capturePaymentError).not.toHaveBeenCalled();
  });

  it("…and the old '' marker WOULD have been dropped by Stripe and refused (why it is not used)", async () => {
    withMeta({ ...DIRECT_META, directSurcharges: "" });
    expect((await post(directBody({ vehicleSize: "none" }))).status).toBe(400);
    nothingWritten();
  });

  it("email binds case-insensitively", async () => {
    const res = await post(directBody({ customer: { firstName: "Ada", lastName: "L", email: "Ada@Example.COM", phone: "555" } }));
    expect(res.status).toBe(200);
  });

  // Pick-up moves with drop-off so the stay stays exactly 5 billed days and the
  // stamped money stays consistent — only the wall-clock compare is under test.
  it.each([
    ["12:30 AM", "2026-10-10 00:30:00", "2026-10-15 00:30:00", 200],
    ["12:00 PM", "2026-10-10 12:00:00", "2026-10-15 12:00:00", 200],
    ["12:30 AM", "2026-10-10 12:30:00", "2026-10-15 00:30:00", 400],
  ])("meta %s vs body %s → %s (literal wall-clock compare)", async (metaTime, fromDate, toDate, status) => {
    withMeta({ ...DIRECT_META, checkinTime: metaTime, checkoutTime: metaTime });
    expect((await post(directBody({ fromDate, toDate }))).status).toBe(status);
  });
});

describe("POST /api/reservations/pending — direct, refused before any write", () => {
  it("closed checkout: 503, nothing written (the PaymentIntent is read first only for its state)", async () => {
    vi.stubEnv("DIRECT_CHECKOUT_PREVIEW", "");
    expect((await post(directBody())).status).toBe(503);
    nothingWritten();
  });

  it.each([{ VERCEL_ENV: "production" }, { NEXT_PUBLIC_APP_ENV: "production" }])(
    "production (%o) with the preview flag on → 503, nothing written",
    async (envs) => {
      for (const [k, v] of Object.entries(envs)) vi.stubEnv(k, v);
      const res = await post(directBody());
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ code: "direct_not_bookable_yet" });
      nothingWritten();
    }
  );

  it("a size this payment was not priced with → 400 'choose your vehicle size again'", async () => {
    const res = await post(directBody({ vehicleSize: "bus" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "unknown_vehicle_size" });
    nothingWritten();
  });

  it("a size the lot no longer offers (priced, but gone from today's lot read) → 400", async () => {
    quoteMock.mockResolvedValue({ ok: true, lot: lot({ vehicle_surcharges: [{ code: "small_suv", label: "Small SUV", dailyRate: 5 }] }), days: 5, quote: {} });
    const res = await post(directBody({ vehicleSize: "large_suv_truck" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "unknown_vehicle_size" });
    nothingWritten();
  });

  it("missing surcharge terms on the PaymentIntent → 400 + Sentry, never 'no surcharge'", async () => {
    withMeta({ ...DIRECT_META, directSurcharges: undefined });
    const res = await post(directBody({ vehicleSize: "none" }));
    expect(res.status).toBe(400);
    expect(capturePaymentError).toHaveBeenCalledTimes(1);
    nothingWritten();
  });

  it("client cents / money / location fields are refused (.strict, B10)", async () => {
    for (const extra of [{ vehicleSurchargeCents: 0 }, { subtotal: 1 }, { locationId: 42 }, { grandTotal: 1 }]) {
      expect((await post(directBody(extra))).status).toBe(400);
    }
    expect((await post(directBody({ vehicleSize: undefined }))).status).toBe(400);
    expect((await post(directBody({ vehicleSizeSource: "url" }))).status).toBe(400);
    nothingWritten();
  });

  it.each([
    ["another lot", { lotId: "direct-2" }],
    ["another email", { customer: { firstName: "A", lastName: "L", email: "eve@example.com", phone: "5" } }],
    ["a different drop-off time", { fromDate: "2026-10-10 22:00:00" }],
    ["a different pick-up date", { toDate: "2026-10-16 10:00:00" }],
  ])("a body for %s does not bind to this payment → 400", async (_n, over) => {
    expect((await post(directBody(over))).status).toBe(400);
    expect(capturePaymentError).toHaveBeenCalled();
    nothingWritten();
  });

  it.each([
    ["directLotId disagrees", { directLotId: "2" }],
    ["a ResLab locationId rides on the direct payment", { locationId: "42" }],
    ["a ResLab parkingTypeId rides on the direct payment", { parkingTypeId: "7" }],
  ])("payment metadata %s → 400 + Sentry", async (_n, over) => {
    withMeta({ ...DIRECT_META, ...over });
    expect((await post(directBody())).status).toBe(400);
    expect(capturePaymentError).toHaveBeenCalled();
    nothingWritten();
  });

  it("protection must match what the payment holds", async () => {
    expect((await post(directBody({ protectionPlanCode: "A" }))).status).toBe(400);
    nothingWritten();
  });

  it("half a protection pair on the payment → 400 + Sentry", async () => {
    withMeta({ ...DIRECT_META, protectionPlanCode: "A" });
    expect((await post(directBody({ protectionPlanCode: "A" }))).status).toBe(400);
    expect(capturePaymentError).toHaveBeenCalled();
  });

  it.each(["customerEmail", "checkinTime", "checkoutTime", "checkin", "checkout", "lotId"])("a payment missing %s → 400", async (key) => {
    withMeta({ ...DIRECT_META, [key]: undefined });
    expect((await post(directBody())).status).toBe(400);
    nothingWritten();
  });

  it("pi.amount that disagrees with the stamped money → 400 + Sentry (arithmetic only, §9 H-E)", async () => {
    withPi(DIRECT_META, { amount: PARKING_CENTS + 1 });
    expect((await post(directBody())).status).toBe(400);
    expect(String(vi.mocked(capturePaymentError).mock.calls[0][0])).toMatch(/money metadata: pi\.amount/);
    nothingWritten();
  });

  it.each(["requires_capture", "processing", "succeeded"])(
    "an already-authorized payment (%s) → 409 already_authorized, never 'not charged' (§9 M-A)",
    async (status) => {
      withPi(DIRECT_META, { status });
      const res = await post(directBody());
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body).toMatchObject({ code: "already_authorized", paymentIntentId: PI });
      expect(body.error).not.toMatch(/not been charged/);
      nothingWritten();
    }
  );

  it("a cancelled payment → 400 payment_not_stageable", async () => {
    withPi(DIRECT_META, { status: "canceled" });
    const res = await post(directBody());
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "payment_not_stageable" });
    nothingWritten();
  });

  it("a PaymentIntent read that throws → 503 'not charged' + Sentry", async () => {
    stripeMock.paymentIntents.retrieve.mockRejectedValue(new Error("timeout"));
    const res = await post(directBody());
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/not been charged/);
    nothingWritten();
  });

  it.each([
    [503, 503, undefined],
    [404, 400, "direct_not_found"],
    [400, 400, "inside_notice_period"],
  ])("lot read answering %s → %s (%s), nothing written", async (quoteStatus, status, code) => {
    quoteMock.mockResolvedValue({ ok: false, status: quoteStatus, error: "This lot needs at least 2 hours notice.", code: code ?? "direct_unavailable" });
    const res = await post(directBody());
    expect(res.status).toBe(status);
    const body = await res.json();
    expect(body.error).toMatch(/not been charged/);
    if (code) expect(body.code).toBe(code);
    nothingWritten();
  });

  it("the stay bills a different number of days today than the payment was priced for → 400 + Sentry", async () => {
    quoteMock.mockResolvedValue({ ok: true, lot: lot(), days: 6, quote: {} });
    expect((await post(directBody())).status).toBe(400);
    expect(capturePaymentError).toHaveBeenCalled();
    nothingWritten();
  });

  it("a lot with no valid notice address is refused (503) — the lot could never be told", async () => {
    quoteMock.mockResolvedValue({ ok: true, lot: { ...lot(), notificationEmails: [] }, days: 5, quote: {} });
    expect((await post(directBody())).status).toBe(503);
    expect(captureBookingError).toHaveBeenCalled();
    nothingWritten();
  });

  it("a lot whose address cannot be snapshotted (state not 2 letters) is refused (503)", async () => {
    quoteMock.mockResolvedValue({ ok: true, lot: { ...lot(), address: { street: "1 Rd", city: "X", state: "New York", zip: "1" } }, days: 5, quote: {} });
    expect((await post(directBody())).status).toBe(503);
    nothingWritten();
  });

  it("a terms write failure → 503 and NO pending row (the engine could never pay the lot)", async () => {
    db.failOnce("direct_booking_terms", "insert", "connection reset");
    expect((await post(directBody())).status).toBe(503);
    expect(db.tables.pending_bookings).toHaveLength(0);
  });

  it("a pending insert failure (not 23505) → 503 + Sentry", async () => {
    db.failOnce("pending_bookings", "insert", "connection reset");
    expect((await post(directBody())).status).toBe(503);
    expect(capturePaymentError).toHaveBeenCalled();
  });

  it("an existing-booking read failure → 503, nothing written (never 'no booking')", async () => {
    db.failOnce("bookings", "select", "connection reset");
    expect((await post(directBody())).status).toBe(503);
    nothingWritten();
  });
});

describe("POST /api/reservations/pending — direct, re-stage and races", () => {
  it("Pay again after a declined card with a NEW size refreshes vehicle_* while the row is pending (R4)", async () => {
    expect((await post(directBody({ vehicleSize: "small_suv" }))).status).toBe(200);
    const res = await post(directBody({ vehicleSize: "large_suv_truck", vehicleSizeSource: "checkout" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ staged: true, reason: "already_staged" });
    expect(db.tables.pending_bookings).toHaveLength(1);
    expect(db.tables.pending_bookings[0]).toMatchObject({
      vehicle_size: "large_suv_truck",
      vehicle_size_label: "Large SUV / truck",
      vehicle_surcharge_cents: 5000,
      vehicle_size_source: "checkout",
    });
    expect(db.tables.direct_booking_terms).toHaveLength(1);
  });

  describe("Pay again with corrected details (review pass 2): the row is the lot's only source", () => {
    const CORRECTED_CUSTOMER = { firstName: "Ada", lastName: "Lovelace", email: "ada@example.com", phone: "212-555-0199" };
    const CORRECTED_VEHICLE = { make: "Chevrolet", model: "Tahoe", color: "White", licensePlate: "XYZ987", state: "NJ" };
    const corrected = () =>
      directBody({
        customer: CORRECTED_CUSTOMER, // same email — the email is bound to the PaymentIntent
        vehicle: CORRECTED_VEHICLE,
        confirmationParams: { lot: "direct-1", checkin: "2026-10-10", ref: "retry" },
      });

    it("a still-pending row takes the corrected plate, make and phone (and the session user) → 200 already_staged", async () => {
      expect((await post(directBody())).status).toBe(200);
      expect(db.tables.pending_bookings[0].user_id).toBeNull();
      identityMock.mockResolvedValue({ identity: { userId: "u_session", email: "ada@example.com" }, reason: "ok" });

      const res = await post(corrected());
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ staged: true, reason: "already_staged" });
      expect(db.tables.pending_bookings).toHaveLength(1);
      expect(db.tables.pending_bookings[0]).toMatchObject({
        status: "pending",
        customer: CORRECTED_CUSTOMER,
        vehicle: CORRECTED_VEHICLE,
        confirmation_params: { lot: "direct-1", checkin: "2026-10-10", ref: "retry" },
        user_id: "u_session",
      });
      expect(capturePaymentError).not.toHaveBeenCalled();
    });

    it.each([
      ["no session cookie", { identity: null, reason: "guest" }],
      ["a session read error", { identity: null, reason: "auth_error" }],
    ])("a lapsed session on the second Pay (%s) never overwrites the staged user with NULL; details still refresh", async (_n, lapsed) => {
      identityMock.mockResolvedValue({ identity: { userId: "u_session", email: "ada@example.com" }, reason: "ok" });
      expect((await post(directBody())).status).toBe(200);
      expect(db.tables.pending_bookings[0].user_id).toBe("u_session");

      identityMock.mockResolvedValue(lapsed);
      const res = await post(corrected());
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ staged: true, reason: "already_staged" });
      expect(db.tables.pending_bookings[0]).toMatchObject({
        user_id: "u_session",
        customer: CORRECTED_CUSTOMER,
        vehicle: CORRECTED_VEHICLE,
      });
    });

    it("a DIFFERENT signed-in user on the second Pay → the session wins (user_id becomes u_other)", async () => {
      identityMock.mockResolvedValue({ identity: { userId: "u_session", email: "ada@example.com" }, reason: "ok" });
      expect((await post(directBody())).status).toBe(200);

      identityMock.mockResolvedValue({ identity: { userId: "u_other", email: "other@example.com" }, reason: "ok" });
      const res = await post(corrected());
      expect(res.status).toBe(200);
      expect(db.tables.pending_bookings[0]).toMatchObject({
        user_id: "u_other",
        customer: CORRECTED_CUSTOMER,
        vehicle: CORRECTED_VEHICLE,
      });
    });

    it("after a decline (row `failed`, never claimed) the row is reopened AND refreshed", async () => {
      expect((await post(directBody({ vehicleSize: "small_suv" }))).status).toBe(200);
      Object.assign(db.tables.pending_bookings[0], {
        status: "failed",
        last_error: "PaymentIntent failed: Your card was declined.",
        claimed_at: null,
        reslab_reservation_number: null,
      });

      const res = await post({ ...corrected(), vehicleSize: "large_suv_truck" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ staged: true, reason: "already_staged" });
      expect(db.tables.pending_bookings).toHaveLength(1);
      expect(db.tables.pending_bookings[0]).toMatchObject({
        status: "pending",
        customer: CORRECTED_CUSTOMER,
        vehicle: CORRECTED_VEHICLE,
        vehicle_size: "large_suv_truck",
      });
      expect(String(db.tables.pending_bookings[0].last_error)).toMatch(/reopened/);
    });

    it("a pending row that already carries a reservation number is NOT refreshed (customer / vehicle / size stand)", async () => {
      const original = directBody();
      expect((await post(original)).status).toBe(200);
      db.tables.pending_bookings[0].reslab_reservation_number = "TRP-AB12CD34";
      const before = { ...db.tables.pending_bookings[0] };

      const res = await post({ ...corrected(), vehicleSize: "small_suv" });
      // Zero rows matched: the stored row stands (a fulfilment holds it).
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ staged: true, reason: "already_staged" });
      expect(db.tables.pending_bookings[0]).toMatchObject({
        status: "pending",
        reslab_reservation_number: "TRP-AB12CD34",
        customer: original.customer,
        vehicle: original.vehicle,
        confirmation_params: original.confirmationParams,
        vehicle_size: before.vehicle_size,
        vehicle_surcharge_cents: before.vehicle_surcharge_cents,
      });
    });
  });

  it("a non-pending row under a stageable payment is never rewritten nor called staged — start again (pass-1 review)", async () => {
    expect((await post(directBody({ vehicleSize: "small_suv" }))).status).toBe(200);
    db.tables.pending_bookings[0].status = "processing";
    db.log = [];
    const res = await post(directBody({ vehicleSize: "large_suv_truck" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "payment_not_stageable", error: expect.stringMatching(/not been charged/) });
    expect(db.tables.pending_bookings[0].vehicle_size).toBe("small_suv");
    expect(db.log.some((l) => l.op === "insert" || l.op === "update" || l.op === "upsert")).toBe(false);
  });

  it("a payment that already has a booking → already_booked, nothing written", async () => {
    db.seed("bookings", [{ stripe_payment_intent_id: PI, reslab_reservation_number: "TRP-AB12CD34" }]);
    const res = await post(directBody());
    expect(await res.json()).toEqual({ staged: false, reason: "already_booked" });
    nothingWritten();
  });
});

describe("POST /api/reservations/pending — direct, PaymentIntent state is checked FIRST (§9 M-A, §10 F-9)", () => {
  const PLAN_A_META = () => ({ ...DIRECT_META, ...protectionMetadataPatch(getProtectionPlan("A")!) });
  const PLAN_B_META = () => ({ ...DIRECT_META, ...protectionMetadataPatch(getProtectionPlan("B")!) });

  /** The 409 hand-off: never "not charged", nothing read or written past the PaymentIntent. */
  async function expectAlreadyAuthorized(res: Response) {
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({ code: "already_authorized", paymentIntentId: PI });
    expect(body.error).not.toMatch(/not been charged/);
    expect(quoteMock).not.toHaveBeenCalled();
    expect(db.log).toEqual([]);
    nothingWritten();
  }

  it.each(["requires_capture", "processing", "succeeded"])(
    "%s + a body whose protection plan no longer matches the payment → still 409 already_authorized",
    async (status) => {
      withPi(DIRECT_META, { status });
      await expectAlreadyAuthorized(await post(directBody({ protectionPlanCode: "A" })));
    }
  );

  it.each(["requires_capture", "processing", "succeeded"])(
    "%s + a body with a DIFFERENT email → still 409 already_authorized (binding never runs)",
    async (status) => {
      withPi(DIRECT_META, { status });
      await expectAlreadyAuthorized(
        await post(directBody({ customer: { firstName: "Eve", lastName: "X", email: "eve@example.com", phone: "5" } }))
      );
    }
  );

  it.each(["requires_capture", "processing", "succeeded"])(
    "%s while checkout is CLOSED (DIRECT_CHECKOUT_PREVIEW unset) → still 409, never the 503 'not open'",
    async (status) => {
      vi.stubEnv("DIRECT_CHECKOUT_PREVIEW", "");
      withPi(DIRECT_META, { status });
      await expectAlreadyAuthorized(await post(directBody()));
    }
  );

  it("an authorized payment + a body that would fail Zod (.strict extra key) → still 409", async () => {
    withPi(DIRECT_META, { status: "requires_capture" });
    await expectAlreadyAuthorized(await post(directBody({ subtotal: 1 })));
  });

  it("canceled → 400 payment_not_stageable, before the gate (closed checkout does not change it)", async () => {
    vi.stubEnv("DIRECT_CHECKOUT_PREVIEW", "");
    withPi(DIRECT_META, { status: "canceled" });
    const res = await post(directBody());
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toMatchObject({ code: "payment_not_stageable" });
    expect(body.error).toMatch(/not been charged/);
    expect(quoteMock).not.toHaveBeenCalled();
    nothingWritten();
  });

  it("declined-card retry: a `failed` row (never claimed) is reopened and takes the NEW vehicle size and tier", async () => {
    // First Pay: small SUV, Plan A.
    withMeta(PLAN_A_META());
    expect((await post(directBody({ vehicleSize: "small_suv", protectionPlanCode: "A" }))).status).toBe(200);
    expect(db.tables.pending_bookings[0]).toMatchObject({ vehicle_size: "small_suv", protection_plan_code: "A" });

    // The payment_failed webhook marks the row failed (no claim, no number).
    Object.assign(db.tables.pending_bookings[0], {
      status: "failed",
      last_error: "PaymentIntent failed: Your card was declined.",
      claimed_at: null,
      reslab_reservation_number: null,
    });

    // The customer changes the size and the tier (/update-pi restamps Plan B), then pays again.
    withMeta(PLAN_B_META());
    const res = await post(directBody({ vehicleSize: "large_suv_truck", protectionPlanCode: "B" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ staged: true, reason: "already_staged" });
    expect(db.tables.pending_bookings).toHaveLength(1);
    expect(db.tables.pending_bookings[0]).toMatchObject({
      status: "pending",
      vehicle_size: "large_suv_truck",
      vehicle_size_label: "Large SUV / truck",
      vehicle_surcharge_cents: 5000,
      protection_plan_code: "B",
      has_protection_plan: true,
    });
    expect(String(db.tables.pending_bookings[0].last_error)).toMatch(/reopened/);
    expect(db.tables.direct_booking_terms).toHaveLength(1);
  });

  it("a `failed` row that WAS claimed (claimed_at set) → 400 payment_not_stageable, row untouched, no terms write", async () => {
    withMeta(PLAN_A_META());
    expect((await post(directBody({ vehicleSize: "small_suv", protectionPlanCode: "A" }))).status).toBe(200);
    const claimedAt = new Date().toISOString();
    Object.assign(db.tables.pending_bookings[0], { status: "failed", claimed_at: claimedAt, reslab_reservation_number: null });
    const termsBefore = { ...db.tables.direct_booking_terms[0] };
    db.log = [];

    withMeta(PLAN_B_META());
    const res = await post(directBody({ vehicleSize: "large_suv_truck", protectionPlanCode: "B" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toMatchObject({ code: "payment_not_stageable" });
    expect(body.error).toMatch(/not been charged/);
    expect(db.tables.pending_bookings).toHaveLength(1);
    expect(db.tables.pending_bookings[0]).toMatchObject({
      status: "failed",
      claimed_at: claimedAt,
      vehicle_size: "small_suv",
      protection_plan_code: "A",
    });
    expect(db.log.some((l) => l.table === "direct_booking_terms")).toBe(false);
    expect(db.log.some((l) => l.table === "pending_bookings" && l.op === "insert")).toBe(false);
    expect(db.tables.direct_booking_terms[0]).toEqual(termsBefore);
  });

  it("a reopen UPDATE that errors → 503 'not charged', nothing else written", async () => {
    withMeta(PLAN_A_META());
    expect((await post(directBody({ vehicleSize: "small_suv", protectionPlanCode: "A" }))).status).toBe(200);
    Object.assign(db.tables.pending_bookings[0], { status: "failed", claimed_at: null, reslab_reservation_number: null });
    db.log = [];
    db.failOnce("pending_bookings", "update", "connection reset");

    withMeta(PLAN_B_META());
    const res = await post(directBody({ vehicleSize: "large_suv_truck", protectionPlanCode: "B" }));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/not been charged/);
    expect(capturePaymentError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/declined-row reopen failed/) }),
      expect.anything()
    );
    expect(db.tables.pending_bookings[0]).toMatchObject({ status: "failed", vehicle_size: "small_suv", protection_plan_code: "A" });
    expect(db.log.some((l) => l.table === "direct_booking_terms")).toBe(false);
    expect(db.log.filter((l) => l.table === "pending_bookings" && (l.op === "insert" || l.op === "update"))).toHaveLength(1);
  });
});

describe("cross-source", () => {
  it("a DIRECT body cannot bind to a ResLab PaymentIntent", async () => {
    withMeta({ customerEmail: "ada@example.com", locationId: "42", inventorySource: "reslab" });
    expect((await post(directBody())).status).toBe(400);
    withMeta({ customerEmail: "ada@example.com", locationId: "42" }); // pre-release ResLab PI, no source key
    expect((await post(directBody())).status).toBe(400);
    nothingWritten();
  });

  it("a RESLAB body cannot bind to a direct PaymentIntent (none of its keys would be checked)", async () => {
    const res = await post({
      locationId: 42,
      costsToken: "tok",
      fromDate: "2026-10-10 10:00:00",
      toDate: "2026-10-15 10:00:00",
      parkingTypeId: 7,
      customer: { firstName: "Ada", lastName: "L", email: "ada@example.com", phone: "555" },
      vehicle: { make: "Ford", model: "F-150", color: "Black", licensePlate: "ABC", state: "NY" },
      stripePaymentIntentId: PI,
      protectionPlanCode: null,
    });
    expect(res.status).toBe(400);
    nothingWritten();
  });

  it("cross-source is refused on inventorySource ALONE (every other key matches)", async () => {
    withMeta({ ...DIRECT_META, inventorySource: "reslab" });
    expect((await post(directBody())).status).toBe(400);
    expect(String(vi.mocked(capturePaymentError).mock.calls[0][0])).toMatch(/: inventorySource$/);
    vi.clearAllMocks();
    withMeta({ ...DIRECT_META, inventorySource: undefined });
    expect((await post(directBody())).status).toBe(400);
    expect(String(vi.mocked(capturePaymentError).mock.calls[0][0])).toMatch(/: inventorySource$/);
  });
});
