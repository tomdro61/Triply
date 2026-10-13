import { describe, it, expect } from "vitest";
import {
  atLotEstimateFromRow,
  buildDirectReservation,
  type DirectReservationCommon,
} from "../reservation-view";
import { directRow, directSnapshot } from "./reservation-view-fixtures";

/**
 * The confirmation view of a DIRECT booking (plan 4b §2.2): built from the
 * bookings row + lot_snapshot only, the at-lot vehicle estimate kept OUT of
 * every online figure, and anything that does not parse refused (the route
 * turns that into 500 + Sentry), never guessed.
 */

const common = (overrides: Partial<DirectReservationCommon> = {}): DirectReservationCommon => ({
  pgIdentifier: null,
  pgSyncStatus: null,
  fromDate: "2026-11-02 08:00:00",
  toDate: "2026-11-05 07:00:00", // 71 h → 3 billed days
  // What Stripe took: 29.85 + 4.78 + 5.95 (the at-lot surcharge is not charged online).
  payment: { ok: true, chargedCents: 4058, refundedCents: 0, discountPercent: null },
  guest: null,
  ...overrides,
});

describe("buildDirectReservation — the guest's contact", () => {
  it("shows the details typed at checkout (the address emailed), not the signed-in account's customers row", () => {
    const r = buildDirectReservation("TRP-7K3M9QXA", directRow(), common({
      guest: { firstName: "Pat", lastName: "Guest", email: "pat.guest@example.com", phone: "5559990000" },
    }));
    expect(r.ok && r.reservation.customer).toEqual({ firstName: "Pat", lastName: "Guest", email: "pat.guest@example.com", phone: "5559990000" });
  });
  it("falls back field by field to the customers row (no staged guest, or a blank field)", () => {
    const none = buildDirectReservation("TRP-7K3M9QXA", directRow(), common({ guest: null }));
    expect(none.ok && none.reservation.customer).toEqual({ firstName: "Dana", lastName: "Rivera", email: "dana@example.com", phone: "5551234567" });
    const partial = buildDirectReservation("TRP-7K3M9QXA", directRow(), common({ guest: { email: "pat.guest@example.com", phone: "  " } }));
    expect(partial.ok && partial.reservation.customer).toEqual({ firstName: "Dana", lastName: "Rivera", email: "pat.guest@example.com", phone: "5551234567" });
  });
});

describe("buildDirectReservation", () => {
  it("builds the confirmation shape from the row + snapshot", () => {
    const r = buildDirectReservation("TRP-7K3M9QXA", directRow(), common());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.reservation).toEqual({
      id: "TRP-7K3M9QXA",
      reservationNumber: "TRP-7K3M9QXA",
      inventorySource: "direct",
      status: "confirmed",
      grandTotal: 40.58,
      subtotal: 29.85,
      taxTotal: 4.78,
      feesTotal: 0,
      serviceFee: 5.95,
      protectionPlan: null,
      protectionPlanPrice: 0,
      pgIdentifier: null,
      pgSyncStatus: null,
      dueNow: 40.58,
      dueAtLocation: 0,
      atLotEstimate: { vehicleSize: "suv", vehicleSizeLabel: "SUV / Van", surcharge: 30, surchargeTax: 4.8, total: 34.8 },
      costBreakdown: {
        ok: true,
        source: "direct",
        lines: [
          { key: "parking", label: "Parking — 3 days", cents: 2985, credit: false },
          { key: "taxes", label: "Taxes", cents: 478, credit: false },
          { key: "service_fee", label: "Triply service fee", cents: 595, credit: false },
        ],
        totalLabel: "Charged to card",
        totalCents: 4058,
        paidOnlineCents: 4058,
        dueAtLocationCents: 0,
        atLot: { cents: 3480, surchargeCents: 3000, surchargeTaxCents: 480, vehicleSizeLabel: "SUV / Van" },
        tripTotalCents: 7538,
        tripTotalIsEstimate: true,
        refundedCents: 0,
        netPaidCents: null,
        cancelled: false,
      },
      cardPayment: { status: "charged", chargedCents: 4058, refundedCents: 0, netPaidCents: null },
      fallbackDue: { kind: "amount", cents: 3480 },
      airportCode: "JFK",
      timezone: "America/New_York",
      customer: { firstName: "Dana", lastName: "Rivera", email: "dana@example.com", phone: "5551234567" },
      items: [
        { type: "parking", fromDate: "2026-11-02 08:00:00", toDate: "2026-11-05 07:00:00", numberOfDays: 3, numberOfSpots: 1 },
      ],
      location: {
        id: "1",
        name: "The Parking Point JFK",
        address: "150-10 Rockaway Blvd",
        city: "Jamaica",
        state: "NY",
        zipCode: "11434",
        phone: "(718) 555-0100",
        latitude: 40.6681,
        longitude: -73.7914,
        shuttleDetails: "Free shuttle every 10 minutes",
        specialConditions: "Keys stay with the attendant.\n\nPull up to the booth and show your QR code.",
      },
      vehicleInfo: { make: "Honda", model: "Pilot", color: "Black", licensePlate: "ABC1234", state: "NY" },
      extraFields: {},
    });
  });

  it("never folds the at-lot estimate into grandTotal / dueNow / dueAtLocation", () => {
    const withSurcharge = buildDirectReservation("TRP-7K3M9QXA", directRow(), common());
    const without = buildDirectReservation(
      "TRP-7K3M9QXA",
      directRow({ vehicle_size: "none", vehicle_size_label: "No oversized vehicle", vehicle_surcharge_cents: 0, vehicle_surcharge_tax_cents: 0 }),
      common()
    );
    if (!withSurcharge.ok || !without.ok) throw new Error("expected ok");
    expect(withSurcharge.reservation.grandTotal).toBe(without.reservation.grandTotal);
    expect(withSurcharge.reservation.dueNow).toBe(without.reservation.dueNow);
    expect(withSurcharge.reservation.dueAtLocation).toBe(0);
    expect(without.reservation.atLotEstimate).toBeNull();
  });

  it("dueNow is the online charge: grand + fee + premium − promo discount; grandTotal stays pre-discount like ResLab", () => {
    const r = buildDirectReservation(
      "TRP-7K3M9QXA",
      directRow({ discount_amount: "2.99", protection_plan: "Plan A", protection_plan_price: "12.99" }),
      common({ pgIdentifier: "PG-1", pgSyncStatus: "synced" })
    );
    if (!r.ok) throw new Error(r.detail);
    expect(r.reservation.grandTotal).toBe(53.57); // 34.63 + 5.95 + 12.99
    expect(r.reservation.dueNow).toBe(50.58); // − 2.99
    expect(r.reservation.serviceFee).toBe(5.95);
    expect(r.reservation.protectionPlan).toBe("Plan A");
    expect(r.reservation.protectionPlanPrice).toBe(12.99);
    expect(r.reservation.pgIdentifier).toBe("PG-1");
  });

  it("reads the service fee from the row (strictly), not from the caller", () => {
    const r = buildDirectReservation("TRP-7K3M9QXA", directRow({ triply_service_fee: "7.25" }), common());
    if (!r.ok) throw new Error(r.detail);
    expect(r.reservation.serviceFee).toBe(7.25);
    expect(r.reservation.grandTotal).toBe(41.88); // 34.63 + 7.25
    expect(r.reservation.dueNow).toBe(41.88);
  });

  it("a $0 service fee is a real value, not an error", () => {
    const r = buildDirectReservation("TRP-7K3M9QXA", directRow({ triply_service_fee: "0" }), common());
    if (!r.ok) throw new Error(r.detail);
    expect(r.reservation.serviceFee).toBe(0);
    expect(r.reservation.dueNow).toBe(34.63);
  });

  it("ignores a stray protection_plan_price when no plan is set (same rule as reconcile)", () => {
    const r = buildDirectReservation("TRP-7K3M9QXA", directRow({ protection_plan: null, protection_plan_price: "12.99" }), common());
    if (!r.ok) throw new Error(r.detail);
    expect(r.reservation.protectionPlan).toBeNull();
    expect(r.reservation.protectionPlanPrice).toBe(0);
    expect(r.reservation.grandTotal).toBe(40.58);
    expect(r.reservation.dueNow).toBe(40.58);
  });

  it.each([
    ["confirmed", "confirmed"],
    ["completed", "confirmed"],
    ["disputed", "confirmed"],
    ["cancelled", "cancelled"],
    ["refunded", "cancelled"],
  ])("maps status %s → %s", (status, expected) => {
    const r = buildDirectReservation("TRP-7K3M9QXA", directRow({ status }), common());
    if (!r.ok) throw new Error(r.detail);
    expect(r.reservation.status).toBe(expected);
  });

  it.each(["payment_failed", "pending", "CONFIRMED", "something_new"])(
    "status %s is not on the allow-list → refused, never shown as confirmed",
    (status) => {
      const r = buildDirectReservation("TRP-7K3M9QXA", directRow({ status }), common());
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.detail).toContain("unexpected status");
      expect(r.detail).toContain(status);
    }
  );

  it("accepts a v1 snapshot but never echoes partner/contact/terms keys into the response", () => {
    const v1 = { ...directSnapshot, v: 1, notificationEmails: ["ops@lot.example"] };
    const r = buildDirectReservation("TRP-7K3M9QXA", directRow({ lot_snapshot: v1 }), common());
    if (!r.ok) throw new Error(r.detail);
    const json = JSON.stringify(r.reservation);
    for (const key of ["notificationEmails", "ops@lot.example", "rateCents", "taxRatePercent", "taxCollectedBy", "partner", "visibility", "minLeadHours"]) {
      expect(json).not.toContain(key);
    }
  });

  it.each([
    ["snapshot missing", { lot_snapshot: null }],
    ["snapshot unknown version", { lot_snapshot: { ...directSnapshot, v: 3 } }],
    ["snapshot for another lot", { lot_snapshot: { ...directSnapshot, directLotId: "2" } }],
    ["not a direct row", { inventory_source: "reslab" }],
    ["grand_total null", { grand_total: null }],
    ["grand_total garbage", { grand_total: "abc" }],
    ["due_at_location null", { due_at_location: null }],
    ["vehicle columns null", { vehicle_size: null, vehicle_surcharge_cents: null }],
    ["fractional cents", { vehicle_surcharge_cents: 12.5 }],
    ["no customer", { customers: null }],
    ["service fee null", { triply_service_fee: null }],
    ["service fee missing", { triply_service_fee: undefined }],
    ["service fee garbage", { triply_service_fee: "5.95abc" }],
    ["service fee negative (string)", { triply_service_fee: "-5.95" }],
    ["service fee negative (number)", { triply_service_fee: -5.95 }],
    ["grand_total negative (string)", { grand_total: "-34.63" }],
    ["grand_total negative (number)", { grand_total: -34.63 }],
    ["discount negative", { discount_amount: "-2.99" }],
    ["due_at_location negative", { due_at_location: -1 }],
    ["protection plan with null price", { protection_plan: "Plan A", protection_plan_price: null }],
    ["protection plan with $0 price", { protection_plan: "Plan A", protection_plan_price: "0" }],
    ["protection plan with garbage price", { protection_plan: "Plan A", protection_plan_price: "abc" }],
    ["protection plan with negative price", { protection_plan: "Plan A", protection_plan_price: "-12.99" }],
    ["protection plan empty string", { protection_plan: "", protection_plan_price: "12.99" }],
  ])("%s → refused, never guessed", (_label, overrides) => {
    const r = buildDirectReservation("TRP-7K3M9QXA", directRow(overrides), common());
    expect(r.ok).toBe(false);
  });

  it("refuses missing or non-pricing check-in/out (no ResLab fallback, no default time)", () => {
    expect(buildDirectReservation("TRP-7K3M9QXA", directRow(), common({ fromDate: null })).ok).toBe(false);
    expect(
      buildDirectReservation("TRP-7K3M9QXA", directRow(), common({ fromDate: "2026-11-05 08:00:00", toDate: "2026-11-02 08:00:00" })).ok
    ).toBe(false);
  });
});

describe("atLotEstimateFromRow", () => {
  it("'none' with no surcharge → null (nothing due at the lot)", () => {
    expect(
      atLotEstimateFromRow({ vehicle_size: "none", vehicle_size_label: "No oversized vehicle", vehicle_surcharge_cents: 0, vehicle_surcharge_tax_cents: 0 })
    ).toEqual({ ok: true, estimate: null });
  });

  it("'none' carrying a surcharge is an integrity error", () => {
    expect(
      atLotEstimateFromRow({ vehicle_size: "none", vehicle_size_label: "No oversized vehicle", vehicle_surcharge_cents: 500, vehicle_surcharge_tax_cents: 0 }).ok
    ).toBe(false);
  });

  it("a size with no surcharge is an integrity error, not $0", () => {
    expect(
      atLotEstimateFromRow({ vehicle_size: "suv", vehicle_size_label: "SUV", vehicle_surcharge_cents: 0, vehicle_surcharge_tax_cents: 0 }).ok
    ).toBe(false);
  });

  it("sums surcharge + tax in cents", () => {
    expect(
      atLotEstimateFromRow({ vehicle_size: "oversized", vehicle_size_label: "Oversized", vehicle_surcharge_cents: 1999, vehicle_surcharge_tax_cents: 320 })
    ).toEqual({
      ok: true,
      estimate: { vehicleSize: "oversized", vehicleSizeLabel: "Oversized", surcharge: 19.99, surchargeTax: 3.2, total: 23.19 },
    });
  });
});

describe("buildDirectReservation — Payment summary (plan 2026-10-12)", () => {
  // 10 % of the 29.85 subtotal = 2.985 → 2.99 (the direct quote's rounding).
  const promoRow = () => directRow({ discount_amount: "2.99", promo_code: "SAVE10" });
  const charged = (chargedCents: number, extra: { refundedCents?: number; discountPercent?: number | null } = {}) => ({
    payment: {
      ok: true as const,
      chargedCents,
      refundedCents: extra.refundedCents ?? 0,
      discountPercent: extra.discountPercent ?? null,
    },
  });

  it("promo: a credit line with the code, checked against the code's percent; the card line is net of it", () => {
    const r = buildDirectReservation("TRP-7K3M9QXA", promoRow(), common(charged(3759, { discountPercent: 10 })));
    if (!r.ok) throw new Error(r.detail);
    const b = r.reservation.costBreakdown;
    if (!b.ok) throw new Error(b.reason);
    expect(b.lines.find((l) => l.key === "promo")).toEqual({ key: "promo", label: "Promo discount (SAVE10)", cents: 299, credit: true });
    expect(b.totalCents).toBe(3759);
  });

  it("promo whose percent is not on the PaymentIntent → refused (cannot be checked)", () => {
    const r = buildDirectReservation("TRP-7K3M9QXA", promoRow(), common(charged(3759)));
    if (!r.ok) throw new Error(r.detail);
    expect(r.reservation.costBreakdown).toEqual({ ok: false, reason: "promo discount cannot be checked against the code's percent" });
  });

  it("promo that disagrees with the code's percent → refused", () => {
    const r = buildDirectReservation("TRP-7K3M9QXA", promoRow(), common(charged(3759, { discountPercent: 20 })));
    if (!r.ok) throw new Error(r.detail);
    expect(r.reservation.costBreakdown).toEqual({ ok: false, reason: "promo discount does not match the code's percent" });
  });

  it("the protection line is named from protection_plan_code", () => {
    const r = buildDirectReservation(
      "TRP-7K3M9QXA",
      directRow({ protection_plan: "Plan B — $500", protection_plan_code: "B", protection_plan_price: "7.99" }),
      common(charged(4857))
    );
    if (!r.ok) throw new Error(r.detail);
    const b = r.reservation.costBreakdown;
    if (!b.ok) throw new Error(b.reason);
    expect(b.lines.find((l) => l.key === "protection")?.label).toBe("Parking Protection — Plan B");
  });

  it("Stripe unknown → refused with Stripe's reason; the card side is unknown (no row-computed 'charged')", () => {
    const r = buildDirectReservation(
      "TRP-7K3M9QXA",
      promoRow(),
      common({
        payment: {
          ok: false,
          reasonClass: "stripe_read_failed",
          reason: "Stripe PaymentIntent read failed (StripeConnectionError)",
          status: null,
          amountReceived: null,
          discountPercent: null,
        },
      })
    );
    if (!r.ok) throw new Error(r.detail);
    expect(r.reservation.costBreakdown).toEqual({ ok: false, reason: "Stripe PaymentIntent read failed (StripeConnectionError)" });
    expect(r.reservation.cardPayment).toEqual({ status: "unknown" });
  });

  it("a released hold on a cancelled booking → 'released', no amount", () => {
    const r = buildDirectReservation(
      "TRP-7K3M9QXA",
      directRow({ status: "cancelled" }),
      common({
        payment: {
          ok: false,
          reasonClass: "released",
          reason: "PaymentIntent is canceled (hold released)",
          status: "canceled",
          amountReceived: 0,
          discountPercent: null,
        },
      })
    );
    if (!r.ok) throw new Error(r.detail);
    expect(r.reservation.costBreakdown.ok).toBe(false);
    expect(r.reservation.cardPayment).toEqual({ status: "released" });
  });

  it("the parts do not match what Stripe took → refused; the card side is Stripe's amount", () => {
    const r = buildDirectReservation("TRP-7K3M9QXA", directRow(), common(charged(4100)));
    if (!r.ok) throw new Error(r.detail);
    expect(r.reservation.costBreakdown.ok).toBe(false);
    expect(r.reservation.cardPayment).toEqual({ status: "charged", chargedCents: 4100, refundedCents: 0, netPaidCents: null });
  });

  it("a cancelled, refunded booking keeps the record and shows the refund, nothing due at the lot", () => {
    const r = buildDirectReservation("TRP-7K3M9QXA", directRow({ status: "refunded" }), common(charged(4058, { refundedCents: 3463 })));
    if (!r.ok) throw new Error(r.detail);
    const b = r.reservation.costBreakdown;
    if (!b.ok) throw new Error(b.reason);
    expect(b.cancelled).toBe(true);
    expect(b.atLot).toBeNull();
    expect(b.refundedCents).toBe(3463);
    expect(b.netPaidCents).toBe(595);
    expect(r.reservation.cardPayment).toEqual({ status: "charged", chargedCents: 4058, refundedCents: 3463, netPaidCents: 595 });
  });

  it.each(["promo_code", "protection_plan_code"])("a row without %s (column not selected) does not parse", (col) => {
    const row = directRow();
    delete row[col];
    expect(buildDirectReservation("TRP-7K3M9QXA", row, common()).ok).toBe(false);
  });

  it("fallbackDue: none without an oversized vehicle; the at-lot surcharge (outside the charge) still shown after an anchor mismatch", () => {
    const none = buildDirectReservation(
      "TRP-7K3M9QXA",
      directRow({ vehicle_size: "none", vehicle_size_label: "None", vehicle_surcharge_cents: 0, vehicle_surcharge_tax_cents: 0 }),
      common()
    );
    if (!none.ok) throw new Error(none.detail);
    expect(none.reservation.fallbackDue).toEqual({ kind: "none" });
    const drift = buildDirectReservation("TRP-7K3M9QXA", directRow(), common(charged(4100)));
    if (!drift.ok) throw new Error(drift.detail);
    expect(drift.reservation.costBreakdown).toEqual({ ok: false, reason: "the parts do not add up to what the card was charged" });
    expect(drift.reservation.fallbackDue).toEqual({ kind: "amount", cents: 3480 });
  });

  it("a promo percent on the PaymentIntent with NO recorded discount → refused (checked whenever either side has one)", () => {
    const r = buildDirectReservation("TRP-7K3M9QXA", directRow(), common(charged(4058, { discountPercent: 10 })));
    if (!r.ok) throw new Error(r.detail);
    expect(r.reservation.costBreakdown).toEqual({ ok: false, reason: "promo discount does not match the code's percent" });
  });

  it("a requires_capture PaymentIntent on a cancelled booking is a live hold → unknown, not 'released'", () => {
    const r = buildDirectReservation(
      "TRP-7K3M9QXA",
      directRow({ status: "cancelled" }),
      common({
        payment: {
          ok: false,
          reasonClass: "not_settled",
          reason: "PaymentIntent is requires_capture, not succeeded",
          status: "requires_capture",
          amountReceived: 0,
          discountPercent: null,
        },
      })
    );
    if (!r.ok) throw new Error(r.detail);
    expect(r.reservation.cardPayment).toEqual({ status: "unknown" });
    expect(r.reservation.costBreakdown).toEqual({
      ok: false,
      reason: "PaymentIntent is requires_capture, not succeeded on a cancelled booking — a live hold remains",
    });
  });
});
