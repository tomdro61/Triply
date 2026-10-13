/**
 * buildDirectResendView (6b plan §6) — what "Re-send customer confirmation"
 * rebuilds the email from. The Stripe mode is checked from the staged row
 * BEFORE the PaymentIntent is retrieved; nothing here sends or touches the
 * `email_sent` claim. Plus sendDirectCustomerConfirmation's optional key: the
 * default is the booking's one confirmation key (unchanged), a re-send passes
 * its own.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { FakeSupabase } from "@/lib/booking/__tests__/supabase-fake";

const db = new FakeSupabase();
const stripeMock = { paymentIntents: { retrieve: vi.fn() } };
vi.mock("@/lib/supabase/server", () => ({ createAdminClient: async () => db }));
vi.mock("@/lib/stripe/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/stripe/client")>("@/lib/stripe/client");
  return { ...actual, stripe: stripeMock };
});
vi.mock("@/lib/resend/client", () => ({ resend: { emails: { send: vi.fn() } }, FROM_EMAIL: "Triply <bookings@triplypro.com>" }));
vi.mock("@/lib/resend/send-booking-confirmation", () => ({
  sendBookingConfirmation: vi.fn(async () => ({ success: true, emailId: "em_customer" })),
}));
vi.mock("@/lib/sentry", () => ({
  capturePaymentError: vi.fn(),
  captureBookingError: vi.fn(),
  captureParkGuardError: vi.fn(),
  captureAPIError: vi.fn(),
  captureDirectLotNotice: vi.fn(),
}));

const { buildDirectResendView } = await import("@/lib/booking/create-booking");
const { sendDirectCustomerConfirmation } = await import("@/lib/booking/fulfill");
const { sendBookingConfirmation } = await import("@/lib/resend/send-booking-confirmation");
const { buildLotSnapshotV2 } = await import("@/lib/direct/lot-snapshot-build");
const { directLotFromRow } = await import("@/lib/direct/store");
const { directLotRow } = await import("@/lib/direct/__tests__/fixtures");

const PI = "pi_direct_1";
const TRP = "TRP-AAAA1111";

function snapshot() {
  const out = directLotFromRow(directLotRow({ id: 1, tax_rate_percent: 16 }));
  if (!out.lot) throw new Error("fixture lot did not parse");
  const s = buildLotSnapshotV2(out.lot);
  if (!s) throw new Error("fixture snapshot did not build");
  return s;
}

/** A completed direct pending row (as create-booking-direct.test.ts stages it). */
function directRow(over: Record<string, unknown> = {}) {
  return {
    stripe_payment_intent_id: PI,
    status: "completed",
    inventory_source: "direct",
    direct_lot_id: "1",
    lot_snapshot: snapshot(),
    location_id: null,
    parking_type_id: null,
    costs_token: null,
    reslab_reservation_number: TRP,
    claimed_at: null,
    email_sent: true,
    livemode: false,
    from_date: "2026-10-20 10:00:00",
    to_date: "2026-10-25 10:00:00",
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

const pi = (over: Record<string, unknown> = {}) => ({
  id: PI,
  status: "succeeded",
  amount: 6366,
  livemode: false,
  created: Math.floor(Date.parse("2026-10-12T15:30:00Z") / 1000),
  metadata: { ...META },
  latest_charge: { amount: 6366, amount_refunded: 0, created: Math.floor(Date.parse("2026-10-12T15:31:00Z") / 1000) },
  ...over,
});

const bookingRow = (over: Record<string, unknown> = {}) => ({
  id: "b1",
  stripe_payment_intent_id: PI,
  reslab_reservation_number: TRP,
  inventory_source: "direct",
  status: "confirmed",
  pg_sync_status: "not_applicable",
  cancel_state: null,
  cancel_claimed_at: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  db.clearFailures();
  db.tables = { pending_bookings: [directRow()], bookings: [bookingRow()], customers: [], cart_claims: [], direct_booking_terms: [] };
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
  stripeMock.paymentIntents.retrieve.mockResolvedValue(pi());
});
afterEach(() => vi.unstubAllEnvs());

describe("buildDirectResendView", () => {
  it("builds the confirmation view from the staged row + PaymentIntent, never touching email_sent", async () => {
    const view = await buildDirectResendView(PI);
    expect(view.ok).toBe(true);
    if (!view.ok) return;
    expect(view.dp.customer.email).toBe("ada@example.com");
    expect(view.fr.number).toBe(TRP);
    expect(view.charged).toBeNull();
    expect(view.pgSyncStatus).toBe("not_applicable");
    expect(stripeMock.paymentIntents.retrieve).toHaveBeenCalledWith(PI, { expand: ["latest_charge"] });
    expect(db.tables.pending_bookings[0].email_sent).toBe(true);
    expect(db.log.filter((l) => l.op !== "select")).toEqual([]);
  });

  it("the other Stripe mode is refused BEFORE the PaymentIntent is retrieved", async () => {
    db.tables.pending_bookings = [directRow({ livemode: true })];
    expect(await buildDirectResendView(PI)).toEqual({ ok: false, reason: "other_mode" });
    expect(stripeMock.paymentIntents.retrieve).not.toHaveBeenCalled();
  });

  it("no staged row / no number — refused before Stripe", async () => {
    db.tables.pending_bookings = [];
    expect(await buildDirectResendView(PI)).toEqual({ ok: false, reason: "no_row" });
    db.tables.pending_bookings = [directRow({ reslab_reservation_number: null })];
    expect(await buildDirectResendView(PI)).toEqual({ ok: false, reason: "no_number" });
    expect(stripeMock.paymentIntents.retrieve).not.toHaveBeenCalled();
  });

  it.each([
    ["not_direct", () => stripeMock.paymentIntents.retrieve.mockResolvedValue(pi({ metadata: { ...META, inventorySource: "reslab" } }))],
    ["refunded", () => stripeMock.paymentIntents.retrieve.mockResolvedValue(pi({ latest_charge: { amount: 6366, amount_refunded: 6366, created: 1 } }))],
    ["not_confirmed", () => (db.tables.bookings = [bookingRow({ status: "refunded" })])],
    ["mid_cancel", () => (db.tables.bookings = [bookingRow({ cancel_claimed_at: "2026-10-12T15:00:00Z" })])],
    ["unreadable", () => stripeMock.paymentIntents.retrieve.mockResolvedValue(pi({ metadata: { ...META, directGrandTotalCents: "x" } }))],
  ] as const)("refuses: %s", async (reason, arrange) => {
    arrange();
    expect(await buildDirectResendView(PI)).toEqual({ ok: false, reason });
  });

  it("a database read failure throws (the caller answers 5xx, never 'nothing to send')", async () => {
    db.failOnce("bookings", "select", "boom");
    await expect(buildDirectResendView(PI)).rejects.toThrow(/boom/);
  });
});

describe("sendDirectCustomerConfirmation idempotency key", () => {
  it("defaults to the booking's one confirmation key; a re-send passes its own", async () => {
    const view = await buildDirectResendView(PI);
    if (!view.ok) throw new Error("view did not build");
    expect(await sendDirectCustomerConfirmation(view.dp, view.fr, view.pgSyncStatus, view.charged, view.promo)).toBe(true);
    expect(
      await sendDirectCustomerConfirmation(view.dp, view.fr, view.pgSyncStatus, view.charged, view.promo, "direct-confirmation/resend/b1/1")
    ).toBe(true);
    const keys = vi.mocked(sendBookingConfirmation).mock.calls.map((c) => c[0].idempotencyKey);
    expect(keys).toEqual([`direct-confirmation/${PI}`, "direct-confirmation/resend/b1/1"]);
    expect(vi.mocked(sendBookingConfirmation).mock.calls[1][0].to).toBe("ada@example.com");
  });
});
