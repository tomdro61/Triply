import { describe, it, expect } from "vitest";
import { cartFromCostData, createLatestGate, decideCheckoutPromo, ruleFromValidateResponse } from "../checkout-promo";
import { promoDiscountCents, type PromoRule } from "../discount";
import type { CheckoutCostData } from "@/types/checkout";

/**
 * The checkout page's promo decisions (promo plan Part 2, /sketch-flow Nov 7):
 * the page's cart, the validate answer → rule, and what the page does with
 * the server's verdict once the PaymentIntent exists.
 */
const JFK5: PromoRule = { code: "JFK5", percent: null, amountCents: 500, minSubtotalCents: 2500 };
const TEN: PromoRule = { code: "TEN", percent: 10, amountCents: null, minSubtotalCents: 0 };

const costData = (over: Partial<CheckoutCostData> = {}): CheckoutCostData => ({
  costsToken: "tok",
  grandTotal: 88,
  subtotal: 80,
  taxTotal: 5,
  feesTotal: 3,
  serviceFee: 6,
  dueAtLocation: 20,
  dueNow: 74,
  soldOut: false,
  ...over,
});

describe("cartFromCostData — the same cart the POST prices", () => {
  it("ResLab: parking = sub + fees, percent base = sub, online = grand − due", () => {
    expect(cartFromCostData(costData())).toEqual({ parkingCents: 8300, percentBaseCents: 8000, onlineParkingCents: 6800, currency: "USD" });
  });

  it("no usable price → null (a code can't be checked), never NaN into the rule", () => {
    expect(cartFromCostData(null)).toBeNull();
    expect(cartFromCostData(undefined)).toBeNull();
    // The GET's fallback without ResLab figures.
    expect(cartFromCostData(costData({ grandTotal: Number.NaN }))).toBeNull();
    expect(cartFromCostData(costData({ dueAtLocation: 99 }))).toBeNull(); // more due at the lot than the total
  });

  it("the page applies a code exactly as the server's rule does on the same prices", () => {
    const cart = cartFromCostData(costData());
    if (!cart) throw new Error("expected a cart");
    expect(promoDiscountCents(JFK5, cart)).toEqual({ cents: 500 });
    expect(promoDiscountCents(TEN, cart)).toEqual({ cents: 800 });
  });
});

describe("ruleFromValidateResponse", () => {
  it("a fixed and a percent answer → their rules (code normalised)", () => {
    expect(ruleFromValidateResponse({ valid: true, code: "jfk5", kind: "fixed", discountPercent: null, discountCents: 500, minSubtotalCents: 2500 })).toEqual(JFK5);
    expect(ruleFromValidateResponse({ valid: true, code: "TEN", kind: "percent", discountPercent: 10, discountCents: null, minSubtotalCents: 0 })).toEqual(TEN);
  });

  it.each([
    ["both kinds", { discountPercent: 10, discountCents: 500 }],
    ["neither kind", { discountPercent: null, discountCents: null }],
    ["a percent over 100", { discountPercent: 150, discountCents: null }],
    ["a fractional amount", { discountPercent: null, discountCents: 4.5 }],
    ["no minimum (an older server)", { discountPercent: 10, discountCents: null, minSubtotalCents: undefined }],
    ["not valid", { valid: false }],
  ])("refuses %s → null (the page never guesses a discount)", (_label, over) => {
    expect(ruleFromValidateResponse({ valid: true, code: "X", discountPercent: 10, discountCents: null, minSubtotalCents: 0, ...over })).toBeNull();
  });
});

describe("decideCheckoutPromo — the server's verdict wins", () => {
  it("applied as the page showed → keep, nothing reported", () => {
    expect(decideCheckoutPromo(JFK5, 500, { code: "JFK5", kind: "fixed", appliedCents: 500 })).toEqual({ action: "keep", appliedCents: 500, report: null });
  });

  it("a percent code at a moved price → keep the SERVER's amount, not reported (prices move)", () => {
    expect(decideCheckoutPromo(TEN, 800, { code: "TEN", kind: "percent", appliedCents: 850 })).toEqual({ action: "keep", appliedCents: 850, report: null });
  });

  it("a fixed code at a different amount → keep the server's amount, and report it (a bug or an edited code)", () => {
    const d = decideCheckoutPromo(JFK5, 500, { code: "JFK5", kind: "fixed", appliedCents: 300 });
    expect(d).toMatchObject({ action: "keep", appliedCents: 300, report: expect.stringContaining("300 cents on the PaymentIntent, 500 on the page") });
  });

  it("refused → drop it; the notice carries the reason and says nothing was charged; not a bug, so not reported", () => {
    const d = decideCheckoutPromo(JFK5, 500, { code: "JFK5", refused: "used_up", message: "This promo code has reached its usage limit" });
    expect(d).toEqual({
      action: "drop",
      notice:
        "Your promo code JFK5 couldn't be applied: This promo code has reached its usage limit. Your total has been updated — please review it and continue. You have not been charged.",
      report: null,
    });
  });

  it.each([
    ["no verdict at all (an older server)", undefined],
    ["null", null],
    ["a malformed verdict", { code: "JFK5", appliedCents: "500" }],
    ["a verdict for another code", { code: "LGA5", kind: "fixed", appliedCents: 500 }],
  ])("%s → drop and report: the page can't tell what the PaymentIntent carries", (_label, raw) => {
    const d = decideCheckoutPromo(JFK5, 500, raw);
    expect(d.action).toBe("drop");
    expect(d.report).not.toBeNull();
    if (d.action === "drop") expect(d.notice).toMatch(/You have not been charged\.$/);
  });
});

describe("createLatestGate — a late Apply answer never lands", () => {
  it("Continue (invalidate) while Apply is in flight: the answer is stale", () => {
    const gate = createLatestGate();
    const applyIsCurrent = gate.begin();
    gate.invalidate(); // Continue pressed
    expect(applyIsCurrent()).toBe(false);
  });

  it("a second Apply overtakes the first; Remove overtakes both", () => {
    const gate = createLatestGate();
    const first = gate.begin();
    const second = gate.begin();
    expect(first()).toBe(false);
    expect(second()).toBe(true);
    gate.invalidate(); // Remove
    expect(second()).toBe(false);
  });
});
