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
  serviceFee: 5.95,
  protectionPlan: null,
  protectionPlanPrice: 0,
  pgIdentifier: null,
  pgSyncStatus: null,
  fromDate: "2026-11-02 08:00:00",
  toDate: "2026-11-05 07:00:00", // 71 h → 3 billed days
  ...overrides,
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
      directRow({ discount_amount: "2.99" }),
      common({ protectionPlan: "Plan A", protectionPlanPrice: 12.99, pgIdentifier: "PG-1", pgSyncStatus: "synced" })
    );
    if (!r.ok) throw new Error(r.detail);
    expect(r.reservation.grandTotal).toBe(53.57); // 34.63 + 5.95 + 12.99
    expect(r.reservation.dueNow).toBe(50.58); // − 2.99
    expect(r.reservation.protectionPlan).toBe("Plan A");
    expect(r.reservation.pgIdentifier).toBe("PG-1");
  });

  it("maps cancelled and refunded rows to the route's 'cancelled' vocabulary", () => {
    for (const status of ["cancelled", "refunded"]) {
      const r = buildDirectReservation("TRP-7K3M9QXA", directRow({ status }), common());
      if (!r.ok) throw new Error(r.detail);
      expect(r.reservation.status).toBe("cancelled");
    }
  });

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
