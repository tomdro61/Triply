/**
 * The daily payment monitor's classification rules. The case that paged on
 * Oct 2–3 2026: a customer with one real booking who then paid a $4.74 Payment
 * Link for a date change was reported as "1 double-charge" every day for the
 * 14-day window. A non-checkout charge is an UNMATCHED charge (48 h), never a
 * double charge; a real second checkout charge with no booking still is.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const { db, pis } = await vi.hoisted(async () => {
  const { FakeSupabase } = await import("@/lib/booking/__tests__/supabase-fake");
  return { db: new FakeSupabase(), pis: [] as Array<Record<string, unknown>> };
});

vi.mock("@/lib/supabase/server", () => ({ createAdminClient: async () => db }));
vi.mock("@/lib/stripe/client", () => ({
  stripe: {
    paymentIntents: {
      // The detector consumes `for await (const pi of stripe.paymentIntents.list(...))`.
      list: () => ({
        async *[Symbol.asyncIterator]() {
          for (const pi of pis) yield pi;
        },
      }),
    },
  },
}));

import { detectPaymentAnomalies } from "../detect-payment-anomalies";

const nowSec = Math.floor(Date.now() / 1000);
const charge = (amount: number, email: string) => ({
  amount_refunded: 0,
  disputed: false,
  billing_details: { email },
  payment_method_details: { type: "card", card: { brand: "visa", fingerprint: "fp_1" } },
});
const checkoutPI = (id: string, amount: number, email: string, createdAgoSec = 3600) => ({
  id,
  status: "succeeded",
  amount,
  created: nowSec - createdAgoSec,
  livemode: true,
  metadata: { lotId: "reslab-277", locationId: "277", customerEmail: email },
  latest_charge: charge(amount, email),
});
const paymentLinkPI = (id: string, amount: number, email: string, createdAgoSec = 3600) => ({
  id,
  status: "succeeded",
  amount,
  created: nowSec - createdAgoSec,
  livemode: true,
  metadata: {},
  receipt_email: email,
  latest_charge: charge(amount, email),
});

beforeEach(() => {
  db.clearFailures();
  pis.length = 0;
  db.tables.customers = [{ id: "c1", email: "v@example.com" }];
  db.tables.bookings = [];
});

describe("detectPaymentAnomalies — non-checkout payments", () => {
  it("a booking plus a Payment Link for the same email is an unmatched charge, NOT a double charge", async () => {
    pis.push(checkoutPI("pi_book", 1791, "v@example.com"), paymentLinkPI("pi_link", 474, "v@example.com"));
    db.tables.bookings = [
      { id: "b1", customer_id: "c1", stripe_payment_intent_id: "pi_book", status: "confirmed", reslab_location_id: 277, reslab_reservation_number: "RTL1", check_in: "2026-10-02T11:30:00", check_out: "2026-10-05T19:00:00", created_at: new Date().toISOString(), vehicle_info: null },
    ];
    const r = await detectPaymentAnomalies(14);
    expect(r.doubleCharges).toEqual([]);
    expect(r.orphans).toEqual([]);
    expect(r.possibleManualCharges.map((c) => c.paymentIntentId)).toEqual(["pi_link"]);
    expect(r.possibleManualCharges[0]).toMatchObject({ amount: 4.74, fromCheckout: false });
  });

  it("a Payment Link alone (no booking for that email) is still just an unmatched charge", async () => {
    pis.push(paymentLinkPI("pi_link", 474, "someone@example.com"));
    const r = await detectPaymentAnomalies(14);
    expect(r.doubleCharges).toEqual([]);
    expect(r.orphans).toEqual([]);
    expect(r.possibleManualCharges).toHaveLength(1);
  });

  it("two CHECKOUT charges for one email with one booking IS a double charge (and an orphan)", async () => {
    pis.push(checkoutPI("pi_1", 10000, "v@example.com", 7200), checkoutPI("pi_2", 10000, "v@example.com", 3600));
    db.tables.bookings = [
      { id: "b1", customer_id: "c1", stripe_payment_intent_id: "pi_1", status: "confirmed", reslab_location_id: 277, reslab_reservation_number: "RTL1", check_in: "2026-10-02T11:30:00", check_out: "2026-10-05T19:00:00", created_at: new Date().toISOString(), vehicle_info: null },
    ];
    const r = await detectPaymentAnomalies(14);
    expect(r.doubleCharges).toHaveLength(1);
    expect(r.doubleCharges[0]).toMatchObject({ charges: 2, bookings: 1, paymentIntentIds: ["pi_1", "pi_2"] });
    expect(r.orphans.map((o) => o.paymentIntentId)).toEqual(["pi_2"]);
    expect(r.possibleManualCharges).toEqual([]);
  });

  it("a fully refunded first attempt followed by a rebook is nothing (the self-cancel + rebook case)", async () => {
    const first = checkoutPI("pi_a", 12239, "v@example.com", 7200);
    (first.latest_charge as { amount_refunded: number }).amount_refunded = 12239;
    pis.push(first, checkoutPI("pi_b", 12239, "v@example.com", 3600));
    db.tables.bookings = [
      { id: "b1", customer_id: "c1", stripe_payment_intent_id: "pi_a", status: "refunded", reslab_location_id: 277, reslab_reservation_number: "RTL1", check_in: "2026-09-25T02:30:00", check_out: "2026-10-02T21:00:00", created_at: new Date().toISOString(), vehicle_info: null },
      { id: "b2", customer_id: "c1", stripe_payment_intent_id: "pi_b", status: "confirmed", reslab_location_id: 277, reslab_reservation_number: "RTL2", check_in: "2026-09-25T14:30:00", check_out: "2026-10-02T21:00:00", created_at: new Date().toISOString(), vehicle_info: null },
    ];
    const r = await detectPaymentAnomalies(14);
    expect(r.doubleCharges).toEqual([]);
    expect(r.orphans).toEqual([]);
    expect(r.duplicateBookings).toEqual([]);
    expect(r.possibleManualCharges).toEqual([]);
  });
});
