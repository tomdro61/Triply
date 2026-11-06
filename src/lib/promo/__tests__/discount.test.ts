import { describe, it, expect } from "vitest";
import { normalisePromoCode, parsePromoRule, promoDiscountCents, type Cart, type PromoRule } from "../discount";
import { computeDirectQuote } from "@/lib/direct/pricing";

/**
 * The promo rule (plan notes/2026-11-06-promo-fixed-amount-plan.md, Part 0).
 * JFK5 = $5 off with a $25 minimum on the parking.
 */
const JFK5: PromoRule = { code: "JFK5", percent: null, amountCents: 500, minSubtotalCents: 2500 };
const SAVE10: PromoRule = { code: "SAVE10", percent: 10, amountCents: null, minSubtotalCents: 0 };

const cart = (over: Partial<Cart> = {}): Cart => ({
  parkingCents: 4000,
  percentBaseCents: 4000,
  onlineParkingCents: 4400,
  currency: "USD",
  ...over,
});

describe("promoDiscountCents — fixed codes", () => {
  it("above the minimum: the face value", () => {
    expect(promoDiscountCents(JFK5, cart({ parkingCents: 4000 }))).toEqual({ cents: 500 });
  });

  it("exactly at the minimum: applies (the minimum is inclusive)", () => {
    expect(promoDiscountCents(JFK5, cart({ parkingCents: 2500 }))).toEqual({ cents: 500 });
  });

  it("one cent below the minimum: refused below_minimum", () => {
    expect(promoDiscountCents(JFK5, cart({ parkingCents: 2499 }))).toEqual({ refused: "below_minimum" });
  });

  it("online parking under $5 (a pay-at-the-lot booking): refused not_applicable, never taken from the fee (D1)", () => {
    expect(promoDiscountCents(JFK5, cart({ onlineParkingCents: 499 }))).toEqual({ refused: "not_applicable" });
    expect(promoDiscountCents(JFK5, cart({ onlineParkingCents: 0 }))).toEqual({ refused: "not_applicable" });
  });

  it("online parking exactly $5: applies — the whole online parking, and not a cent of the fee", () => {
    expect(promoDiscountCents(JFK5, cart({ onlineParkingCents: 500 }))).toEqual({ cents: 500 });
  });

  it("the minimum is judged on the parking the customer sees, not on the online share", () => {
    // $40 parking, only $10 of it online: the minimum is met and $5 fits online.
    expect(promoDiscountCents(JFK5, cart({ parkingCents: 4000, onlineParkingCents: 1000 }))).toEqual({ cents: 500 });
  });
});

describe("promoDiscountCents — percent codes", () => {
  it("round(base × pct / 100)", () => {
    expect(promoDiscountCents(SAVE10, cart({ percentBaseCents: 8000 }))).toEqual({ cents: 800 });
  });

  it("the base is percentBaseCents (ResLab sub_total), not parkingCents (sub_total + fees)", () => {
    expect(promoDiscountCents(SAVE10, cart({ parkingCents: 8300, percentBaseCents: 8000 }))).toEqual({ cents: 800 });
  });

  it.each([
    [8000, 10],
    [3995, 10], // 399.5 → 400: the half-cent boundary that drifted 1¢ before
    [1999, 15],
    [12345, 12.5],
    [995, 33],
  ])("ResLab: within half a cent of today's unrounded sub_total × pct (base %i¢ at %s%%)", (base, pct) => {
    const r = promoDiscountCents({ ...SAVE10, percent: pct }, cart({ percentBaseCents: base, onlineParkingCents: 1_000_000 }));
    if (!("cents" in r)) throw new Error("expected a discount");
    const today = (base * pct) / 100; // /api/checkout/lot: sub_total × pct/100, unrounded
    expect(Math.abs(r.cents - today)).toBeLessThanOrEqual(0.5);
  });

  it.each([
    [995, 5, 16, 10],
    [1999, 3, 8.875, 15],
    [2000, 2, 10, 100],
  ])("direct: identical to computeDirectQuote (rate %i × %i days, %s%% tax, %s%% off)", (rateCents, days, taxRatePercent, pct) => {
    const q = computeDirectQuote({ rateCents, days, taxRatePercent, discountPercent: pct });
    const r = promoDiscountCents(
      { ...SAVE10, percent: pct },
      cart({ parkingCents: q.subtotalCents, percentBaseCents: q.subtotalCents, onlineParkingCents: q.grandTotalCents })
    );
    expect(r).toEqual({ cents: q.discountCents });
  });

  it("capped at the online parking (bug 6): a pay-at-the-lot booking's discount never eats the service fee", () => {
    // $40 subtotal at 10 % = $4.00, but only $1.00 of parking is paid online.
    const r = promoDiscountCents(SAVE10, cart({ percentBaseCents: 4000, onlineParkingCents: 100 }));
    expect(r).toEqual({ cents: 100 });
    const serviceFeeCents = 595;
    if (!("cents" in r)) throw new Error("expected a discount");
    // What the card pays for parking + fee never drops below the fee.
    expect(100 - r.cents + serviceFeeCents).toBe(serviceFeeCents);
  });

  it("nothing online at all: refused not_applicable — a discount is never 0 cents", () => {
    expect(promoDiscountCents(SAVE10, cart({ onlineParkingCents: 0 }))).toEqual({ refused: "not_applicable" });
  });

  it("a base too small to round to a cent: refused not_applicable", () => {
    expect(promoDiscountCents(SAVE10, cart({ percentBaseCents: 4 }))).toEqual({ refused: "not_applicable" });
  });

  it("the minimum applies to percent codes too", () => {
    expect(promoDiscountCents({ ...SAVE10, minSubtotalCents: 2500 }, cart({ parkingCents: 2000 }))).toEqual({ refused: "below_minimum" });
  });
});

describe("promoDiscountCents — the fee is never reduced", () => {
  it.each([
    [JFK5, 0, 2500],
    [JFK5, 500, 2500],
    [JFK5, 4400, 4000],
    [SAVE10, 0, 9000],
    [SAVE10, 1, 9000],
    [SAVE10, 300, 9000],
    [SAVE10, 9000, 9000],
  ])("%o with online parking %i¢: the discount is at most the online parking", (rule, online, base) => {
    const r = promoDiscountCents(rule, cart({ parkingCents: base, percentBaseCents: base, onlineParkingCents: online }));
    if ("cents" in r) {
      expect(r.cents).toBeGreaterThan(0);
      expect(r.cents).toBeLessThanOrEqual(online);
    } else {
      expect(r.refused).toBe("not_applicable");
    }
  });
});

describe("promoDiscountCents — currency", () => {
  it.each(["CAD", "EUR", ""])("%s is refused (the Nov 3 CAD-as-USD class)", (currency) => {
    expect(promoDiscountCents(JFK5, cart({ currency }))).toEqual({ refused: "currency" });
    expect(promoDiscountCents(SAVE10, cart({ currency }))).toEqual({ refused: "currency" });
  });

  it("usd in any case is USD", () => {
    expect(promoDiscountCents(JFK5, cart({ currency: "usd" }))).toEqual({ cents: 500 });
  });
});

describe("promoDiscountCents — malformed input throws (money is never guessed)", () => {
  it.each([
    ["both kinds", { ...JFK5, percent: 10 }],
    ["neither kind", { ...JFK5, amountCents: null }],
    ["amount 0", { ...JFK5, amountCents: 0 }],
    ["amount not whole cents", { ...JFK5, amountCents: 4.5 }],
    ["percent 0", { ...SAVE10, percent: 0 }],
    ["percent over 100", { ...SAVE10, percent: 101 }],
    ["negative minimum", { ...SAVE10, minSubtotalCents: -1 }],
  ])("rule: %s", (_label, rule) => {
    expect(() => promoDiscountCents(rule, cart())).toThrow();
  });

  it.each([
    ["parking", { parkingCents: -1 }],
    ["base", { percentBaseCents: 1.5 }],
    ["online", { onlineParkingCents: Number.NaN }],
  ])("cart: %s", (_label, over) => {
    expect(() => promoDiscountCents(SAVE10, cart(over))).toThrow();
  });
});

describe("normalisePromoCode", () => {
  it("trims and upper-cases", () => {
    expect(normalisePromoCode("  jfk5 ")).toBe("JFK5");
  });
});

describe("parsePromoRule — a promo_codes row → PromoRule", () => {
  it("a percent row from before migration 049 (no new columns)", () => {
    expect(parsePromoRule({ code: "SAVE10", discount_percent: 10 })).toEqual({
      ok: true,
      rule: { code: "SAVE10", percent: 10, amountCents: null, minSubtotalCents: 0 },
    });
  });

  it("a fixed row in Vin's dollars (DECIMAL as a string), converted to cents once", () => {
    expect(parsePromoRule({ code: "jfk5", discount_percent: null, discount_amount: "5.00", min_subtotal: "25.00" })).toEqual({
      ok: true,
      rule: { code: "JFK5", percent: null, amountCents: 500, minSubtotalCents: 2500 },
    });
  });

  it("a fixed row with numeric DECIMALs and no minimum", () => {
    expect(parsePromoRule({ code: "LGA5", discount_percent: null, discount_amount: 5, min_subtotal: null })).toEqual({
      ok: true,
      rule: { code: "LGA5", percent: null, amountCents: 500, minSubtotalCents: 0 },
    });
  });

  it.each([
    ["both kinds", { code: "X", discount_percent: 10, discount_amount: "5.00" }],
    ["neither kind", { code: "X", discount_percent: null, discount_amount: null }],
    ["neither kind (columns absent)", { code: "X" }],
    ["amount 0", { code: "X", discount_percent: null, discount_amount: "0.00" }],
    ["amount negative", { code: "X", discount_percent: null, discount_amount: "-5.00" }],
    ["amount unreadable", { code: "X", discount_percent: null, discount_amount: "five" }],
    ["percent out of range", { code: "X", discount_percent: 150 }],
    ["percent 0", { code: "X", discount_percent: 0 }],
    ["minimum unreadable", { code: "X", discount_percent: 10, min_subtotal: "lots" }],
    ["empty code", { code: "  ", discount_percent: 10 }],
    ["code missing", { discount_percent: 10 }],
    ["not an object", null],
    ["percent as a string (wrong type)", { code: "X", discount_percent: "10" }],
  ])("refused: %s", (_label, row) => {
    const r = parsePromoRule(row);
    expect(r.ok).toBe(false);
  });

  it("a parsed rule always prices without throwing", () => {
    const r = parsePromoRule({ code: "JFK5", discount_percent: null, discount_amount: "5.00", min_subtotal: "25.00" });
    if (!r.ok) throw new Error(r.reason);
    expect(promoDiscountCents(r.rule, cart())).toEqual({ cents: 500 });
  });
});
