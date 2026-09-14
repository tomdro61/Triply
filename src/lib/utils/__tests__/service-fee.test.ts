import { describe, it, expect } from "vitest";
import { calculateServiceFee, customerTotalFromPricing } from "../service-fee";

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
});
