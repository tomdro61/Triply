import { describe, it, expect } from "vitest";
import { priceViewFromCost, priceViewFromPricing } from "../price-view";
import type { CheckoutCostData } from "@/types/checkout";

const cost = (over: Partial<CheckoutCostData> = {}): CheckoutCostData => ({
  costsToken: "tok",
  grandTotal: 70.15,
  subtotal: 59.85,
  taxTotal: 6.31,
  feesTotal: 3.99,
  serviceFee: 5.95,
  dueAtLocation: 54.95,
  dueNow: 21.15,
  numberOfDays: 4,
  soldOut: false,
  parkingTypeId: 1,
  ...over,
});

describe("priceViewFromCost — the figures checkout shows", () => {
  it("total = grand total + service fee; per-day over the billed days; lines add up", () => {
    // PARK AC JFK, Oct 30 10 AM → Nov 2 2 PM, as checkout showed it ($76.10).
    const v = priceViewFromCost(cost())!;
    expect(v.total).toBeCloseTo(76.1, 10);
    expect(v.perDay).toBeCloseTo(76.1 / 4, 10);
    expect(v.days).toBe(4);
    expect(v.parking).toBeCloseTo(63.84, 10);
    expect(v.discount).toBe(0);
    expect(v.dueAtLocation).toBe(54.95);
    expect(v.parking - v.discount + v.taxes + v.serviceFee).toBeCloseTo(v.total, 2);
  });

  it("shows ResLab's long-stay discount so the lines still add up to the total", () => {
    // sub 100 + fees 0 − 10 discount + 8 tax = 98 grand total
    const v = priceViewFromCost(cost({ subtotal: 100, feesTotal: 0, taxTotal: 8, grandTotal: 98, serviceFee: 6 }))!;
    expect(v.discount).toBe(10);
    expect(v.parking - v.discount + v.taxes + v.serviceFee).toBeCloseTo(v.total, 10);
  });

  it("no per-day figure without a day count; no view without a total", () => {
    expect(priceViewFromCost(cost({ numberOfDays: undefined }))!.perDay).toBeNull();
    expect(priceViewFromCost(cost({ grandTotal: 0 }))).toBeNull();
    expect(priceViewFromCost(cost({ serviceFee: Number.NaN }))).toBeNull();
  });
});

describe("priceViewFromPricing — the price the page was loaded with", () => {
  it("matches the search card's total and per-day figure", () => {
    const v = priceViewFromPricing({ grandTotal: 88.4, subtotal: 74.85, feesTotal: 3, taxTotal: 10.55, numberOfDays: 3 }, 20)!;
    expect(v.total).toBeCloseTo(94.35, 10);
    expect(v.perDay).toBeCloseTo(31.45, 10);
    expect(v.serviceFee).toBe(5.95);
    expect(v.dueAtLocation).toBe(20);
  });

  it("null without a total — never a fee-less figure", () => {
    expect(priceViewFromPricing({ subtotal: 50, numberOfDays: 2 }, undefined)).toBeNull();
    expect(priceViewFromPricing(undefined, undefined)).toBeNull();
  });
});
