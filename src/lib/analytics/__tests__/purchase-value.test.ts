import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/sentry", () => ({ captureBookingError: vi.fn() }));

import { promoCouponFamily, purchasePromo } from "../purchase-value";
import { trackPurchase } from "../gtag";

/**
 * The GA4 purchase event and promo codes (promo plan D3): the value is net of
 * the discount, the coupon is the code's family — never a per-person WELCOME
 * code — and an unknown discount reports the value before it, with no coupon.
 */
describe("promoCouponFamily", () => {
  it("a minted per-subscriber WELCOME code reports as WELCOME; shared codes as themselves", () => {
    expect(promoCouponFamily("WELCOME-7KQ2MX")).toBe("WELCOME");
    expect(promoCouponFamily("welcome-7kq2mx")).toBe("WELCOME");
    expect(promoCouponFamily("JFK5")).toBe("JFK5");
    expect(promoCouponFamily(" thanks10 ")).toBe("THANKS10");
    expect(promoCouponFamily(null)).toBeNull();
    expect(promoCouponFamily("")).toBeNull();
  });
});

describe("purchasePromo", () => {
  it("a promo booking: the total before the code, the discount, the family", () => {
    expect(purchasePromo({ grandTotal: 104.95, promoDiscount: 5, promoCode: "JFK5" })).toEqual({ grossTotal: 104.95, discount: 5, coupon: "JFK5" });
  });
  it("no code: no discount, no coupon", () => {
    expect(purchasePromo({ grandTotal: 104.95, promoDiscount: 0, promoCode: null })).toEqual({ grossTotal: 104.95, discount: 0, coupon: null });
  });
  it.each([
    ["null (the booking row couldn't be read)", null],
    ["absent (a response from before D3)", undefined],
    ["not a number", Number.NaN],
  ])("an unknown discount — %s — reports the value before it and no coupon, never a guess", (_label, promoDiscount) => {
    expect(purchasePromo({ grandTotal: 104.95, promoDiscount, promoCode: "JFK5" })).toEqual({ grossTotal: 104.95, discount: 0, coupon: null });
  });
});

describe("trackPurchase with a promo", () => {
  const gtag = vi.fn();
  beforeEach(() => {
    gtag.mockReset();
    vi.stubGlobal("window", { gtag });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("value and item price net of the discount; coupon set; the commission estimate less the discount", () => {
    trackPurchase({
      confirmationNumber: "RTL1",
      lotId: "132",
      lotName: "DoubleTree",
      grandTotal: 104.95, // parking 82 + fee 10 + PG 12.95
      serviceFee: 10,
      protectionPlanPrice: 12.95,
      promoDiscount: 5,
      coupon: "JFK5",
    });
    const [, name, params] = gtag.mock.calls[0];
    expect(name).toBe("purchase");
    expect(params).toMatchObject({
      value: 99.95,
      coupon: "JFK5",
      triply_commission: +(82 * 0.15 - 5).toFixed(2),
      items: [{ price: 99.95, discount: 5, coupon: "JFK5" }],
    });
  });

  it("no code: exactly as before — value = the total, no coupon or discount keys", () => {
    trackPurchase({ confirmationNumber: "RTL2", lotId: "132", lotName: "DoubleTree", grandTotal: 92, serviceFee: 10 });
    const params = gtag.mock.calls[0][2];
    expect(params.value).toBe(92);
    expect(params).not.toHaveProperty("coupon");
    expect(params.items[0]).not.toHaveProperty("discount");
    expect(params.triply_commission).toBe(+(82 * 0.15).toFixed(2));
  });
});
