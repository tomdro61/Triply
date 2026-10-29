/**
 * The booking emails take the promo discount from the PaymentIntent, not from
 * persistBooking's result (cost-breakdown plan v2 §3, review High): a
 * persistence result that lost the discount must not zero it in a permanent
 * email. persistBooking is wrapped here to report `discountAmount: 0`, as a
 * persistence that failed before deriving it would.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { FakeSupabase } from "./supabase-fake";

const db = new FakeSupabase();

const stripeMock = { paymentIntents: { retrieve: vi.fn(), capture: vi.fn(), cancel: vi.fn() } };
const capturePaymentIntent = vi.fn();
const cancelPaymentIntent = vi.fn();
const createRefund = vi.fn();
const reslabMock = { createReservation: vi.fn(), getReservation: vi.fn(), getCost: vi.fn(), getLocation: vi.fn() };

vi.mock("@/lib/booking/reconciliation-alert", () => ({
  RECONCILIATION_ALERT_COLUMNS: "stripe_payment_intent_id, livemode, customer, location_name, airport_code, from_date, to_date, reslab_reservation_number, inventory_source",
  alertNeedsReconciliation: vi.fn(async () => ({ team: "discord", customer: "sent" })),
  scheduleReconciliationAlert: vi.fn(async () => undefined),
}));
vi.mock("@/lib/supabase/server", () => ({ createAdminClient: async () => db }));
vi.mock("@/lib/stripe/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/stripe/client")>("@/lib/stripe/client");
  return { stripe: stripeMock, capturePaymentIntent, cancelPaymentIntent, createRefund, paymentIntentRefundState: actual.paymentIntentRefundState };
});
vi.mock("@/lib/reslab/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/reslab/client")>("@/lib/reslab/client");
  return { reslab: reslabMock, ReslabError: actual.ReslabError, stripHtml: actual.stripHtml };
});
vi.mock("@/lib/resend/send-booking-confirmation", () => ({
  sendBookingConfirmation: vi.fn(async () => ({ success: true, emailId: "em_1" })),
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
vi.mock("../fulfill", async () => {
  const actual = await vi.importActual<typeof import("../fulfill")>("../fulfill");
  return {
    ...actual,
    persistBooking: vi.fn(async (...args: Parameters<typeof actual.persistBooking>) => ({
      ...(await actual.persistBooking(...args)),
      discountAmount: 0,
    })),
  };
});

const { createBooking } = await import("../create-booking");
const { persistBooking } = await import("../fulfill");
const { sendBookingConfirmation } = await import("@/lib/resend/send-booking-confirmation");
const { sendAdminBookingNotification } = await import("@/lib/resend/send-admin-booking-notification");

const PI = "pi_email_discount";

function pendingRow() {
  return {
    stripe_payment_intent_id: PI,
    status: "pending",
    reslab_reservation_number: null,
    claimed_at: null,
    email_sent: false,
    livemode: false,
    location_id: 42,
    costs_token: "tok_1",
    from_date: "2026-08-14 10:00:00",
    to_date: "2026-08-18 14:00:00",
    parking_type_id: 7,
    customer: { firstName: "Ada", lastName: "Lovelace", email: "ada@example.com", phone: "555-0100" },
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
  };
}

function reservation(num: string) {
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

beforeEach(() => {
  vi.clearAllMocks();
  db.tables = { pending_bookings: [pendingRow()], bookings: [], cart_claims: [], customers: [] };
  db.log = [];
  reslabMock.getCost.mockResolvedValue({
    costs_token: "tok_2",
    reservation: { sold_out: false, sub_total: 80, fees_total: 3, tax_total: 5, grand_total: 88, due_at_location: 20 },
  });
  reslabMock.createReservation.mockResolvedValue(reservation("RTL999"));
  reslabMock.getLocation.mockResolvedValue(undefined);
  reslabMock.getReservation.mockImplementation(async (num: string) => reservation(num));
  capturePaymentIntent.mockResolvedValue({ status: "succeeded" });
  // online before the promo = 88 + 6 − 20 = 74.00; charged 66.00 → discount 8.00
  stripeMock.paymentIntents.retrieve.mockResolvedValue({
    id: PI,
    status: "requires_capture",
    amount: 6600,
    livemode: false,
    metadata: { customerEmail: "ada@example.com", discountPercent: "10", promoCode: "save10" },
    latest_charge: null,
  });
});

describe("the emails' promo discount does not depend on persistence", () => {
  it("persistBooking reporting no discount leaves the email's discount, code, total and breakdown intact", async () => {
    const out = await createBooking({ source: "client", stripePaymentIntentId: PI });

    expect(out.kind).toBe("created");
    // The wrapper really did hand back a zeroed discount.
    const persisted = await vi.mocked(persistBooking).mock.results[0].value;
    expect(persisted.discountAmount).toBe(0);

    const customer = vi.mocked(sendBookingConfirmation).mock.calls[0][0];
    // Fallback total net of the discount: 94 − 8 = 86, i.e. 66 online + 20 at the location.
    expect(customer.totalAmount).toBe(86);
    expect(customer.breakdown).toMatchObject({ ok: true, paidOnlineCents: 6600, totalCents: 8600 });
    if (!customer.breakdown?.ok) return;
    expect(customer.breakdown.lines.find((l) => l.key === "promo")).toEqual({
      key: "promo",
      label: "Promo discount (SAVE10)",
      cents: 800,
      credit: true,
    });
    const admin = vi.mocked(sendAdminBookingNotification).mock.calls[0][0];
    expect(admin.totalAmount).toBe(86);
    expect(admin.breakdown).toEqual(customer.breakdown);
  });
});
