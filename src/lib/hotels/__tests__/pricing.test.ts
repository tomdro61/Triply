import { describe, it, expect } from "vitest";
import { priceRoom, packagePrice, dollarsToCents } from "../pricing";

describe("dollarsToCents", () => {
  it("rounds once, half-up, on LiteAPI's decimal amounts", () => {
    expect(dollarsToCents(232.97)).toBe(23297);
    expect(dollarsToCents(3.5)).toBe(350);
    expect(dollarsToCents(0.005)).toBe(1);
    expect(dollarsToCents(1.005)).toBe(100); // FP artefact — documents the behaviour, not a promise
  });
  it("refuses non-finite amounts", () => {
    expect(() => dollarsToCents(Number.NaN)).toThrow(/finite/);
  });
});

describe("priceRoom — max(margin, SSP floor), integer cents", () => {
  it("margin binds when it exceeds the SSP (the measured sandbox case: SSP ≈ net × 1.01)", () => {
    const p = priceRoom({ roomNetCents: 23297, sspCents: 23507, propertyFeesDueAtHotelCents: 3786, marginPercent: 15 });
    expect(p.roomSellCents).toBe(26792); // round(23297 × 1.15)
    expect(p.priceBasis).toBe("margin");
    expect(p.hotelMarginCents).toBe(26792 - 23297);
    expect(p.roomTaxCents).toBe(0); // until Q10
    expect(p.propertyFeesDueAtHotelCents).toBe(3786);
  });

  it("SSP floor binds when our margin would undercut it", () => {
    const p = priceRoom({ roomNetCents: 20000, sspCents: 25000, propertyFeesDueAtHotelCents: 0, marginPercent: 15 });
    expect(p.roomSellCents).toBe(25000);
    expect(p.priceBasis).toBe("ssp_floor");
  });

  it("with no SSP the margin is the price", () => {
    const p = priceRoom({ roomNetCents: 10000, sspCents: null, propertyFeesDueAtHotelCents: 0, marginPercent: 15 });
    expect(p.roomSellCents).toBe(11500);
    expect(p.priceBasis).toBe("margin");
  });

  it("never lets the sell price fall below net (margin 0, no SSP)", () => {
    const p = priceRoom({ roomNetCents: 10000, sspCents: null, propertyFeesDueAtHotelCents: 0, marginPercent: 0 });
    expect(p.roomSellCents).toBe(10000);
    expect(p.hotelMarginCents).toBe(0);
  });

  it("rejects non-integer or negative cents", () => {
    expect(() => priceRoom({ roomNetCents: 100.5, sspCents: null, propertyFeesDueAtHotelCents: 0, marginPercent: 15 })).toThrow(/integer/);
    expect(() => priceRoom({ roomNetCents: -1, sspCents: null, propertyFeesDueAtHotelCents: 0, marginPercent: 15 })).toThrow(/integer/);
  });
});

describe("packagePrice — one due-now number, one headline that includes fees payable at the hotel", () => {
  const room = priceRoom({ roomNetCents: 23297, sspCents: null, propertyFeesDueAtHotelCents: 3786, marginPercent: 15 });

  it("due now = parking + fee − promo + room sell + room tax + premium", () => {
    const p = packagePrice({ room, parkingOnlineCents: 8800, serviceFeeCents: 595, promoDiscountCents: 880, protectionPremiumCents: 0 });
    expect(p.dueNowCents).toBe(8800 + 595 - 880 + 26792 + 0 + 0);
    expect(p.headlineTotalCents).toBe(p.dueNowCents + 3786);
    expect(p.propertyFeesDueAtHotelCents).toBe(3786);
  });

  it("Park Guard premium sits on top only when chosen (D2)", () => {
    const none = packagePrice({ room, parkingOnlineCents: 8800, serviceFeeCents: 595, promoDiscountCents: 0, protectionPremiumCents: 0 });
    const planA = packagePrice({ room, parkingOnlineCents: 8800, serviceFeeCents: 595, promoDiscountCents: 0, protectionPremiumCents: 1299 });
    expect(planA.dueNowCents - none.dueNowCents).toBe(1299);
  });

  it("fees payable at the hotel appear in NO other formula (they are not in due-now)", () => {
    const withFees = packagePrice({ room, parkingOnlineCents: 8800, serviceFeeCents: 595, promoDiscountCents: 0, protectionPremiumCents: 0 });
    const noFees = packagePrice({ room: { ...room, propertyFeesDueAtHotelCents: 0 }, parkingOnlineCents: 8800, serviceFeeCents: 595, promoDiscountCents: 0, protectionPremiumCents: 0 });
    expect(withFees.dueNowCents).toBe(noFees.dueNowCents);
  });

  it("throws rather than charge a negative amount when a promo exceeds the parking", () => {
    expect(() => packagePrice({ room: { ...room, roomSellCents: 0 }, parkingOnlineCents: 100, serviceFeeCents: 0, promoDiscountCents: 500, protectionPremiumCents: 0 })).toThrow(/negative/);
  });
});
