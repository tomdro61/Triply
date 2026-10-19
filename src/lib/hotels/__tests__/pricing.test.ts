import { describe, it, expect } from "vitest";
import {
  ORDER_FLOOR_RATES,
  dollarsToCents,
  orderFloorCents,
  orderSurplusBp,
  packagePrice,
  parkingCommission,
  percentToBp,
  priceRoom,
  type OrderInputs,
} from "../pricing";
import { checkParkingQuote } from "../parking-quote";
import { minPrice } from "./fixtures";

describe("dollarsToCents / percentToBp", () => {
  it("rounds once, half-up, on supplier decimal amounts", () => {
    expect(dollarsToCents(232.97)).toBe(23297);
    expect(dollarsToCents(3.5)).toBe(350);
    expect(() => dollarsToCents(Number.NaN)).toThrow(/finite/);
  });
  it("converts the plan's percentages exactly", () => {
    expect(percentToBp(2.9)).toBe(290);
    expect(percentToBp(4)).toBe(400);
    expect(percentToBp(0)).toBe(0);
    expect(() => percentToBp(2.905)).toThrow();
    expect(() => percentToBp(100)).toThrow();
  });
  it("the shipped constants are the plan's (§5.1)", () => {
    expect(ORDER_FLOOR_RATES).toEqual({ stripeFeeBp: 290, stripeFixedCents: 30, liteApiFeeBp: 400, marginBp: 0, roomTaxOnMarkupBp: 0 });
  });
});

// The §5.1 worked example: DoubleTree JFK, net $216.00, P $100.00 (base $100.00), F $6.00, lot share 85 %.
const example: OrderInputs = { roomNetCents: 21_600, parkingGrandTotalCents: 10_000, serviceFeeCents: 600, commissionCents: 1_000 };

describe("parking commission C (§5.1)", () => {
  const base = { baseCents: 10_000, commissionType: "percentage" };
  it.each([
    [80, 2_000 - 500],
    [83, 1_700 - 500],
    [85, 1_500 - 500],
  ])("lot keeps %i %% → C = %i cents", (pc, cents) => {
    const r = parkingCommission({ ...base, lotSharePercent: pc, quoteLocationCommissionCents: Math.round((10_000 * pc) / 100) });
    expect(r).toEqual({ known: true, cents, lotSharePercent: pc });
  });

  it("unknown → C = 0: wrong type, out of range, cross-check mismatch, or no quote figure", () => {
    expect(parkingCommission({ ...base, commissionType: "flat", lotSharePercent: 85, quoteLocationCommissionCents: 8_500 })).toEqual({ known: false, cents: 0, reason: "type" });
    expect(parkingCommission({ ...base, lotSharePercent: 0, quoteLocationCommissionCents: 0 })).toMatchObject({ known: false, reason: "range" });
    expect(parkingCommission({ ...base, lotSharePercent: 100, quoteLocationCommissionCents: 10_000 })).toMatchObject({ known: false, reason: "range" });
    expect(parkingCommission({ ...base, lotSharePercent: null, quoteLocationCommissionCents: 8_500 })).toMatchObject({ known: false, reason: "range" });
    expect(parkingCommission({ ...base, lotSharePercent: 85, quoteLocationCommissionCents: 8_000 })).toMatchObject({ known: false, reason: "cross_check" });
    expect(parkingCommission({ ...base, lotSharePercent: 85, quoteLocationCommissionCents: null })).toMatchObject({ known: false, reason: "cross_check" });
    // within 1¢ is agreement
    expect(parkingCommission({ ...base, lotSharePercent: 85, quoteLocationCommissionCents: 8_501 }).known).toBe(true);
  });
});

describe("the order floor at m = 0 (§5.1, D1)", () => {
  it("reproduces the worked example to the cent: $218.45", () => {
    expect(orderFloorCents(example)).toBe(21_845);
  });

  it("is the LEAST room price at which the whole order breaks even", () => {
    expect(orderSurplusBp(21_845, example)).toBeGreaterThanOrEqual(0);
    expect(orderSurplusBp(21_844, example)).toBeLessThan(0);
  });

  it("includes the Stripe fixed 30¢ term", () => {
    expect(orderFloorCents(example, { ...ORDER_FLOOR_RATES, stripeFixedCents: 0 })).toBe(21_813);
  });

  it("a higher commission lowers the floor; C = 0 (unknown) raises it", () => {
    const at = (C: number) => orderFloorCents({ ...example, commissionCents: C });
    expect(at(1_500)).toBeLessThan(at(1_000));
    expect(at(0)).toBeGreaterThan(at(1_000));
  });

  it("t > 0: tax on the markup raises the floor, and the result still breaks even exactly", () => {
    const k = { ...ORDER_FLOOR_RATES, roomTaxOnMarkupBp: 1_000 };
    const f = orderFloorCents(example, k);
    expect(f).toBe(21_875);
    expect(orderSurplusBp(f, example, k)).toBeGreaterThanOrEqual(0);
    expect(orderSurplusBp(f - 1, example, k)).toBeLessThan(0);
  });

  it("t > 0 with a floor below net: no markup, so no markup tax", () => {
    const rich = { ...example, commissionCents: 10_000 };
    const k = { ...ORDER_FLOOR_RATES, roomTaxOnMarkupBp: 1_000 };
    const f = orderFloorCents(rich, k);
    expect(f).toBeLessThan(rich.roomNetCents);
    expect(f).toBe(orderFloorCents(rich));
    expect(orderSurplusBp(f - 1, rich, k)).toBeLessThan(0);
  });

  it("m > 0 is defined on the whole charge (R + P + F)", () => {
    const k = { ...ORDER_FLOOR_RATES, marginBp: 300 };
    const f = orderFloorCents(example, k);
    expect(orderSurplusBp(f, example, k)).toBeGreaterThanOrEqual(0);
    expect(orderSurplusBp(f - 1, example, k)).toBeLessThan(0);
  });
});

describe("priceRoom — max(SSP, floor)", () => {
  const room = (ssp: number | null) => priceRoom({ ...example, sspCents: ssp, propertyFeesDueAtHotelCents: 1_845 });

  it("SSP above the floor: sold at SSP", () => {
    expect(room(23_000)).toMatchObject({ roomSellCents: 23_000, priceBasis: "ssp", floorCents: 21_845 });
  });
  it("SSP below the floor: sold at the floor (pricing above SSP is always allowed)", () => {
    expect(room(21_600)).toMatchObject({ roomSellCents: 21_845, priceBasis: "floor" });
  });
  it("SSP equal to the floor counts as SSP", () => {
    expect(room(21_845).priceBasis).toBe("ssp");
  });
  it("no SSP: sold at the floor", () => {
    expect(room(null)).toMatchObject({ roomSellCents: 21_845, priceBasis: "floor", sspCents: null });
  });
  it("room tax stays 0 until M16", () => {
    expect(room(23_000).roomTaxCents).toBe(0);
  });
  it("rejects non-integer cents", () => {
    expect(() => priceRoom({ ...example, roomNetCents: 100.5, sspCents: null, propertyFeesDueAtHotelCents: 0 })).toThrow(/integer/);
  });
});

describe("packagePrice (§5.2)", () => {
  const room = priceRoom({ ...example, sspCents: 23_000, propertyFeesDueAtHotelCents: 1_845 });
  it("due now = parking + fee + room; the headline adds what is paid at the hotel", () => {
    const p = packagePrice({ room, parkingOnlineCents: 10_000, serviceFeeCents: 600, promoDiscountCents: 0, protectionPremiumCents: 0 });
    expect(p.dueNowCents).toBe(10_000 + 600 + 23_000);
    expect(p.headlineTotalCents).toBe(p.dueNowCents + 1_845);
  });
});

describe("quote checks (§5.2)", () => {
  it("passes a clean quote and derives both bases", () => {
    const r = checkParkingQuote(minPrice({ grand: 108.5, sub: 100, fees: 2, ltd: 1, tax: 7.5, lc: 85 }));
    expect(r).toEqual({
      kind: "priced",
      quote: {
        grandTotalCents: 10_850,
        subTotalCents: 10_000,
        feesTotalCents: 200,
        longTermDiscountCents: 100,
        taxTotalCents: 750,
        locationCommissionCents: 8_500,
        commissionBaseCents: 10_100,
        serviceFeeBaseCents: 10_200,
      },
    });
  });
  it("hides a quote with anything due at the lot", () => {
    expect(checkParkingQuote(minPrice({ grand: 100, sub: 100, due: 5 }))).toMatchObject({ kind: "failed", reason: "due_at_location" });
  });
  it("hides a quote whose discount is not 0", () => {
    expect(checkParkingQuote(minPrice({ grand: 95, sub: 100, discount: 5 }))).toMatchObject({ kind: "failed", reason: "discount" });
  });
  it("hides a quote whose totals don't add up (beyond 1¢)", () => {
    expect(checkParkingQuote(minPrice({ grand: 100.02, sub: 100 }))).toMatchObject({ kind: "failed", reason: "identity" });
    expect(checkParkingQuote(minPrice({ grand: 100.01, sub: 100 })).kind).toBe("priced");
  });
  it("sold out, unpriced and malformed are distinct", () => {
    expect(checkParkingQuote(minPrice({ grand: 100, sub: 100, soldOut: true }))).toEqual({ kind: "sold_out" });
    expect(checkParkingQuote(minPrice({ grand: 0, sub: 0 }))).toMatchObject({ kind: "failed", reason: "unpriced" });
    expect(checkParkingQuote({ reservation: { grand_total: "100" } })).toMatchObject({ kind: "failed", reason: "malformed" });
    expect(checkParkingQuote(null)).toMatchObject({ kind: "failed", reason: "malformed" });
  });
});
