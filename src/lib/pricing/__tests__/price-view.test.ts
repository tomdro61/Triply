import { describe, it, expect } from "vitest";
import { formatMoney, priceViewFromPricing, priceViewFromQuote, type LotQuote } from "../price-view";

const quote = (over: Partial<LotQuote> = {}): LotQuote => ({
  grandTotal: 70.15,
  subtotal: 59.85,
  taxTotal: 6.31,
  feesTotal: 3.99,
  serviceFee: 5.95,
  dueAtLocation: 54.95,
  numberOfDays: 4,
  soldOut: false,
  ...over,
});

const addsUp = (v: { parking: number; discount: number; taxes: number; serviceFee: number; total: number }) =>
  expect(v.parking - v.discount + v.taxes + v.serviceFee).toBeCloseTo(v.total, 2);

describe("priceViewFromQuote", () => {
  it("total = grand total + service fee; per-day over the billed days; lines add up", () => {
    // PARK AC JFK, Oct 30 10 AM → Nov 2 2 PM, as checkout showed it ($76.10).
    const v = priceViewFromQuote(quote())!;
    expect(v.total).toBeCloseTo(76.1, 10);
    expect(v.perDay).toBeCloseTo(76.1 / 4, 10);
    expect(v.days).toBe(4);
    expect(v.parking).toBeCloseTo(63.84, 10);
    expect(v.discount).toBe(0);
    expect(v.dueAtLocation).toBe(54.95);
    addsUp(v);
  });

  it("shows ResLab's long-stay discount so the lines still add up to the total", () => {
    // sub 100 + fees 0 − 10 discount + 8 tax = 98 grand total
    const v = priceViewFromQuote(quote({ subtotal: 100, feesTotal: 0, taxTotal: 8, grandTotal: 98, serviceFee: 6 }))!;
    expect(v.discount).toBe(10);
    addsUp(v);
  });

  it("no figure at all when the parts don't add up, or one is missing", () => {
    // parts (59.85 + 3.99 + 6.31 = 70.15) short of a 80.00 grand total
    expect(priceViewFromQuote(quote({ grandTotal: 80 }))).toBeNull();
    expect(priceViewFromQuote(quote({ grandTotal: 0 }))).toBeNull();
    expect(priceViewFromQuote(quote({ serviceFee: Number.NaN }))).toBeNull();
    expect(priceViewFromQuote(quote({ taxTotal: undefined as unknown as number }))).toBeNull();
  });

  it("no per-day figure without a day count", () => {
    expect(priceViewFromQuote(quote({ numberOfDays: undefined }))!.perDay).toBeNull();
    expect(priceViewFromQuote(quote({ numberOfDays: 0 }))!.days).toBeNull();
  });
});

describe("priceViewFromPricing — the price the page was loaded with", () => {
  it("matches the search card's total and per-day figure", () => {
    const v = priceViewFromPricing({ grandTotal: 88.4, subtotal: 74.85, feesTotal: 3, taxTotal: 10.55, numberOfDays: 3 }, 20)!;
    expect(v.total).toBeCloseTo(94.35, 10);
    expect(v.perDay).toBeCloseTo(31.45, 10);
    expect(v.serviceFee).toBe(5.95);
    expect(v.dueAtLocation).toBe(20);
    addsUp(v);
  });

  it("null without a total, a subtotal or the tax — never a made-up $0.00 line", () => {
    expect(priceViewFromPricing({ subtotal: 50, numberOfDays: 2 }, undefined)).toBeNull();
    expect(priceViewFromPricing({ grandTotal: 88.4, taxTotal: 10.55 }, undefined)).toBeNull();
    expect(priceViewFromPricing({ grandTotal: 88.4, subtotal: 74.85, feesTotal: 3 }, undefined)).toBeNull();
    expect(priceViewFromPricing(undefined, undefined)).toBeNull();
  });
});

it("formatMoney", () => {
  expect(formatMoney(61.15)).toBe("$61.15");
  expect(formatMoney(5.949999)).toBe("$5.95");
});
