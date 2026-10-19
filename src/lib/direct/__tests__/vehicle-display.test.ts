/**
 * Display math shared by the Reserve pop-up and the checkout selector
 * (vehicle-surcharge plan §1.4/§1.5, R6, R8, R10). Display only — the server
 * computes what is stored from the PaymentIntent.
 */
import { describe, it, expect } from "vitest";
import {
  atLotEstimate,
  directReserveQuote,
  initialVehicleChoice,
  refreshVehicleChoice,
  surchargeRangeText,
  vehicleSizeOptions,
} from "../vehicle-display";

const LOT1 = [
  { code: "small_suv", label: "Small SUV", dailyRateCents: 500 },
  { code: "midsize_suv", label: "Midsize SUV / minivan", dailyRateCents: 700 },
  { code: "large_suv_truck", label: "Large SUV / truck", dailyRateCents: 1000 },
];

describe("vehicleSizeOptions", () => {
  it("puts 'No oversized vehicle' (0) first, then the lot's sizes in order", () => {
    expect(vehicleSizeOptions(LOT1).map((o) => [o.code, o.dailyRateCents])).toEqual([
      ["none", 0],
      ["small_suv", 500],
      ["midsize_suv", 700],
      ["large_suv_truck", 1000],
    ]);
    expect(vehicleSizeOptions(LOT1)[0].label).toBe("No oversized vehicle");
  });
});

describe("directReserveQuote — from the dates/times ON SCREEN (R6)", () => {
  const base = { rateCents: 995, taxRatePercent: 16, checkIn: "2026-10-10", checkOut: "2026-10-15" };

  it("5 days at 10:00 AM both ends → $63.66 online", () => {
    expect(directReserveQuote({ ...base, checkInTime: "10:00 AM", checkOutTime: "10:00 AM" })).toEqual({ days: 5, onlineCents: 6366 });
  });

  it("a later pick-up time adds a billed day (7 AM → 7 PM = 6 days), so pop-up = checkout", () => {
    const q = directReserveQuote({ ...base, checkInTime: "7:00 AM", checkOutTime: "7:00 PM" });
    expect(q?.days).toBe(6);
    const large = vehicleSizeOptions(LOT1)[3];
    expect(atLotEstimate(large, q!.days, 16)).toEqual({ surchargeCents: 6000, surchargeTaxCents: 960, atLotCents: 6960 });
  });

  it("no total rather than a wrong one: missing time, reversed range, no rate", () => {
    expect(directReserveQuote({ ...base, checkInTime: "", checkOutTime: "10:00 AM" })).toBeNull();
    expect(directReserveQuote({ ...base, checkIn: "2026-10-16", checkInTime: "10:00 AM", checkOutTime: "10:00 AM" })).toBeNull();
    expect(directReserveQuote({ ...base, rateCents: 0, checkInTime: "10:00 AM", checkOutTime: "10:00 AM" })).toBeNull();
  });
});

describe("surchargeRangeText (R10)", () => {
  it("lot 1 → +$5–$10/day; one size → +$5/day; cents kept when present; none → null", () => {
    expect(surchargeRangeText(LOT1)).toBe("+$5–$10/day");
    expect(surchargeRangeText([LOT1[0]])).toBe("+$5/day");
    expect(surchargeRangeText([{ dailyRateCents: 750 }, { dailyRateCents: 1000 }])).toBe("+$7.50–$10/day");
    expect(surchargeRangeText([])).toBeNull();
    expect(surchargeRangeText(undefined)).toBeNull();
  });
});

describe("initialVehicleChoice (R8)", () => {
  const terms = { vehicleSurcharges: LOT1 };

  it("a size from the pop-up is kept, source 'modal'", () => {
    expect(initialVehicleChoice(terms, "large_suv_truck", null)).toEqual({ code: "large_suv_truck", source: "modal" });
    expect(initialVehicleChoice(terms, "none", null)).toEqual({ code: "none", source: "modal" });
  });

  it("a choice changed on the checkout page survives a refresh as source 'checkout'", () => {
    expect(initialVehicleChoice(terms, "small_suv", "checkout")).toEqual({ code: "small_suv", source: "checkout" });
  });

  it("missing or unknown (old link, recovery email, removed size) → null: Pay waits for a pick — never a silent 'none'", () => {
    expect(initialVehicleChoice(terms, null, null)).toBeNull();
    expect(initialVehicleChoice(terms, "bus", null)).toBeNull();
    expect(initialVehicleChoice(terms, "", null)).toBeNull();
  });

  it("a direct lot with no surcharges has nothing to ask: 'none'", () => {
    // Marked automatic: nobody chose it, so it must not survive the lot gaining sizes.
    expect(initialVehicleChoice({ vehicleSurcharges: [] }, null, null)).toEqual({ code: "none", source: "checkout", auto: true });
  });

  it("not a direct checkout → null (no question; ResLab Pay is never gated on it)", () => {
    expect(initialVehicleChoice(null, "large_suv_truck", null)).toBeNull();
    expect(initialVehicleChoice(undefined, null, null)).toBeNull();
  });
});

describe("refreshVehicleChoice — the lot's terms changed between the checkout GET and POST", () => {
  const sized = { vehicleSurcharges: [{ code: "small_suv" }, { code: "large_suv_truck" }] };
  const unsized = { vehicleSurcharges: [] };

  it("a real choice the lot still offers is kept", () => {
    expect(refreshVehicleChoice({ code: "large_suv_truck", source: "modal" }, sized)).toEqual({ code: "large_suv_truck", source: "modal" });
    expect(refreshVehicleChoice({ code: "none", source: "checkout" }, sized)).toEqual({ code: "none", source: "checkout" });
  });

  it("sizes ADDED after an automatic 'none' → null: the customer is asked, never a silent 'none'", () => {
    const auto = initialVehicleChoice(unsized, null, null);
    expect(refreshVehicleChoice(auto, sized)).toBeNull();
  });

  it("a size the lot no longer offers, or no choice yet → null", () => {
    expect(refreshVehicleChoice({ code: "midsize_suv", source: "modal" }, sized)).toBeNull();
    expect(refreshVehicleChoice(null, sized)).toBeNull();
  });

  it("sizes REMOVED → 'none' with nothing to ask, so Pay is never stuck behind a selector that is not shown", () => {
    expect(refreshVehicleChoice(null, unsized)).toEqual({ code: "none", source: "checkout", auto: true });
    expect(refreshVehicleChoice({ code: "large_suv_truck", source: "modal" }, unsized)).toEqual({ code: "none", source: "checkout", auto: true });
    // An explicit "none" stays the customer's own answer.
    expect(refreshVehicleChoice({ code: "none", source: "modal" }, unsized)).toEqual({ code: "none", source: "modal" });
  });
});
