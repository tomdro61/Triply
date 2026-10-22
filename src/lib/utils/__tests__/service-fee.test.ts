import { describe, it, expect } from "vitest";
import { calculateServiceFee, customerPerDayFromPricing, customerTotalFromPricing } from "../service-fee";
import { computeDirectQuote } from "@/lib/direct/pricing";

/**
 * Pins the service-fee formula: max($5.95, 6% of the parking base), rounded to
 * cents. The minimum was raised from $4.95 on 2026-09-14; the 6% side is
 * unchanged. (These assume the TRIPLY_SERVICE_FEE_* env overrides are unset,
 * which is the case under vitest.)
 */
describe("calculateServiceFee", () => {
  it("charges the $5.95 floor when 6% would be less", () => {
    expect(calculateServiceFee(50)).toBe(5.95); // 6% = 3.00
    expect(calculateServiceFee(90)).toBe(5.95); // 6% = 5.40 — was 5.40 under the $4.95 floor
    expect(calculateServiceFee(0)).toBe(5.95);
  });

  it("charges 6% once that exceeds the floor", () => {
    expect(calculateServiceFee(120)).toBe(7.2);
    expect(calculateServiceFee(200)).toBe(12);
  });

  it("crosses over at a $99.17 base (6% × 99.17 ≈ 5.95)", () => {
    expect(calculateServiceFee(99.16)).toBe(5.95);
    expect(calculateServiceFee(99.5)).toBe(5.97);
  });

  it("rounds to cents", () => {
    expect(calculateServiceFee(101.234)).toBe(6.07); // 6.07404
  });

  it("customerTotalFromPricing adds the fee to the grand total using subtotal + fees as the base", () => {
    expect(
      customerTotalFromPricing({ grandTotal: 64.71, subtotal: 51.39, feesTotal: 3, taxTotal: 5.37 })
    ).toBe(64.71 + 5.95);
    expect(customerTotalFromPricing({ grandTotal: 300, subtotal: 280, feesTotal: 0 })).toBe(300 + 16.8);
    expect(customerTotalFromPricing(undefined)).toBeNull();
  });

  it("customerPerDayFromPricing spreads the fee-inclusive total over the billed days", () => {
    expect(
      customerPerDayFromPricing({ grandTotal: 64.71, subtotal: 51.39, feesTotal: 3, taxTotal: 5.37, numberOfDays: 3 })
    ).toBeCloseTo((64.71 + 5.95) / 3, 10);
  });

  it("a direct lot's card total equals what its checkout charges (before protection, no promo)", () => {
    // The Parking Point JFK: $9.95/day, 16 % tax. 3 days stays on the $5.95 floor; 20 days uses 6 %.
    for (const days of [3, 20]) {
      const q = computeDirectQuote({ rateCents: 995, days, taxRatePercent: 16 });
      // Mapped as src/lib/direct/adapter.ts maps a quote onto lot.pricing.
      const card = customerTotalFromPricing({
        grandTotal: q.grandTotalCents / 100,
        subtotal: q.subtotalCents / 100,
        feesTotal: 0,
        taxTotal: q.taxTotalCents / 100,
      });
      expect(Math.round(card! * 100)).toBe(q.chargeCents);
    }
  });

  it("customerPerDayFromPricing is null without a total or a day count, never a fee-less rate", () => {
    expect(customerPerDayFromPricing({ subtotal: 50, numberOfDays: 3 })).toBeNull();
    expect(customerPerDayFromPricing({ grandTotal: 64.71, subtotal: 51.39 })).toBeNull();
    expect(customerPerDayFromPricing({ grandTotal: 64.71, subtotal: 51.39, numberOfDays: 0 })).toBeNull();
    expect(customerPerDayFromPricing(undefined)).toBeNull();
  });
});
