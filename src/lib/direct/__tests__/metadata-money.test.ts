import { describe, expect, it } from "vitest";
import { readDirectMetadataMoney } from "../metadata-money";
import { computeDirectQuote } from "../pricing";
import type { PromoRule } from "@/lib/promo/discount";

const percentCode = (percent: number): PromoRule => ({ code: "SAVE", percent, amountCents: null, minSubtotalCents: 0 });

/**
 * A direct PaymentIntent's metadata exactly as POST /api/checkout/lot stamps it
 * (postDirect): Oct 20 10:00 AM → Oct 25 10:00 AM = 5 days at $9.95, 16 % tax,
 * $5.95 fee, Plan A ($12.99). Charge = 4975 + 796 + 595 + 1299 = 7665.
 */
function meta(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    inventorySource: "direct",
    lotId: "direct-1",
    directLotId: "1",
    checkin: "2026-10-20",
    checkout: "2026-10-25",
    checkinTime: "10:00 AM",
    checkoutTime: "10:00 AM",
    customerEmail: "guest@example.com",
    parkingOnlyChargeAmountCents: "6366",
    protectionPlanCode: "A",
    protectionPlanPrice: "12.99",
    directRateCents: "995",
    directDays: "5",
    directSubtotalCents: "4975",
    directTaxCents: "796",
    directGrandTotalCents: "5771",
    directDiscountCents: "0",
    directServiceFeeCents: "595",
    directTaxRatePercent: "16",
    directSurcharges: "small_suv:500",
    ...overrides,
  };
}

describe("readDirectMetadataMoney", () => {
  it("decodes a consistent PaymentIntent", () => {
    const r = readDirectMetadataMoney(meta(), 7665);
    expect(r).toEqual({
      ok: true,
      money: {
        rateCents: 995,
        days: 5,
        subtotalCents: 4975,
        taxCents: 796,
        grandTotalCents: 5771,
        discountCents: 0,
        serviceFeeCents: 595,
        protectionPremiumCents: 1299,
        chargeCents: 7665,
        taxRatePercent: 16,
        discountPercent: 0,
      },
    });
  });

  it("agrees with computeDirectQuote for every stamped value (promo + no Park Guard)", () => {
    const q = computeDirectQuote({ rateCents: 995, days: 5, taxRatePercent: 16, promo: percentCode(10) });
    const m = meta({
      protectionPlanCode: undefined,
      protectionPlanPrice: undefined,
      discountPercent: "10",
      directDiscountCents: String(q.discountCents),
      directServiceFeeCents: String(q.serviceFeeCents),
      parkingOnlyChargeAmountCents: String(q.chargeCents),
    });
    const r = readDirectMetadataMoney(m, q.chargeCents);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.money.discountCents).toBe(498);
      expect(r.money.protectionPremiumCents).toBe(0);
      expect(r.money.chargeCents).toBe(q.chargeCents);
    }
  });

  it("takes the service fee AS STAMPED — a fee-rule change mid-flight never blocks the booking", () => {
    // $4.95 was the old minimum; today's rule says $5.95. Arithmetic still agrees.
    const r = readDirectMetadataMoney(meta({ directServiceFeeCents: "495", parkingOnlyChargeAmountCents: "6266" }), 7565);
    expect(r.ok).toBe(true);
  });

  it("refuses when pi.amount differs from the stamped charge", () => {
    expect(readDirectMetadataMoney(meta(), 7664)).toEqual({ ok: false, detail: "pi.amount 7664 != stamped charge 7665" });
  });

  it("refuses when the Park Guard premium in Stripe is not in the amount (update-pi baseline)", () => {
    expect(readDirectMetadataMoney(meta(), 6366).ok).toBe(false);
  });

  it.each([
    ["directRateCents", { directRateCents: undefined }],
    ["directSubtotalCents", { directSubtotalCents: "49.75" }],
    ["directTaxCents", { directTaxCents: "-1" }],
    ["directGrandTotalCents", { directGrandTotalCents: "" }],
    ["directDiscountCents", { directDiscountCents: "01" }],
    ["directServiceFeeCents", { directServiceFeeCents: "abc" }],
    ["parkingOnlyChargeAmountCents", { parkingOnlyChargeAmountCents: undefined }],
    ["directDays", { directDays: "0" }],
    ["directTaxRatePercent", { directTaxRatePercent: undefined }],
    ["discountPercent", { discountPercent: "ten" }],
    ["stay", { checkinTime: undefined }],
  ])("refuses a missing or malformed %s", (_key, overrides) => {
    expect(readDirectMetadataMoney(meta(overrides), 7665).ok).toBe(false);
  });

  it.each([
    ["subtotal != rate × days", { directSubtotalCents: "4976" }],
    ["tax wrong for the stamped rate", { directTaxRatePercent: "18" }],
    ["grand != subtotal + tax", { directGrandTotalCents: "5772" }],
    ["discount without a percent", { directDiscountCents: "100" }],
    ["days do not match the stay", { checkout: "2026-10-26" }],
    ["parking baseline disagrees", { parkingOnlyChargeAmountCents: "6367" }],
  ])("refuses an inconsistent stamp: %s", (_label, overrides) => {
    expect(readDirectMetadataMoney(meta(overrides), 7665).ok).toBe(false);
  });

  it("refuses a half protection pair (never guesses the tier)", () => {
    expect(readDirectMetadataMoney(meta({ protectionPlanCode: undefined }), 7665).ok).toBe(false);
  });

  it("refuses a discount percent of 0 stamped explicitly (checkout only stamps > 0)", () => {
    expect(readDirectMetadataMoney(meta({ discountPercent: "0" }), 7665).ok).toBe(false);
  });
});

describe("readDirectMetadataMoney — a stamped discountCents (promo plan Part 1)", () => {
  // $5 off (JFK5): parking-only = 5771 − 500 + 595 = 5866; + Plan A 1299 = 7165.
  const fixed = (overrides: Record<string, string | undefined> = {}) =>
    meta({
      promoCode: "JFK5",
      discountCents: "500",
      directDiscountCents: "500",
      parkingOnlyChargeAmountCents: "5866",
      ...overrides,
    });

  it("accepts a fixed code: no percent, the stamp is the discount", () => {
    const r = readDirectMetadataMoney(fixed(), 7165);
    expect(r).toMatchObject({ ok: true, money: { discountCents: 500, discountPercent: 0, chargeCents: 7165 } });
  });

  it("both keys: discountCents is the authority — the percent beside it is display-only and NOT recomputed", () => {
    // 10 % of 4975 would be 498; a capped / fixed stamp of 500 must still pass.
    const r = readDirectMetadataMoney(fixed({ discountPercent: "10" }), 7165);
    expect(r).toMatchObject({ ok: true, money: { discountCents: 500, discountPercent: 10 } });
  });

  it("refuses when the direct stamp disagrees with discountCents", () => {
    // 498 is what the percent gives, but the stamp says 500.
    const r = readDirectMetadataMoney(
      fixed({ discountPercent: "10", directDiscountCents: "498", parkingOnlyChargeAmountCents: "5868" }),
      7167
    );
    expect(r).toEqual({ ok: false, detail: "directDiscountCents 498 != discountCents 500" });
  });

  it("accepts a discount of the whole parking total (≤ grand); refuses one cent more", () => {
    expect(
      readDirectMetadataMoney(fixed({ discountCents: "5771", directDiscountCents: "5771", parkingOnlyChargeAmountCents: "595" }), 595 + 1299).ok
    ).toBe(true);
    const r = readDirectMetadataMoney(
      fixed({ discountCents: "5772", directDiscountCents: "5772", parkingOnlyChargeAmountCents: "594" }),
      594 + 1299
    );
    expect(r).toEqual({ ok: false, detail: "discountCents 5772 exceeds the online parking 5771" });
  });

  it.each(["0", "-500", "5.00", "", "abc"])("refuses an unusable discountCents %j", (raw) => {
    const r = readDirectMetadataMoney(fixed({ discountCents: raw }), 7165);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toMatch(/not a positive whole number/);
  });

  it("refuses a discountCents with no discount on the direct stamp", () => {
    expect(readDirectMetadataMoney(meta({ discountCents: "500" }), 7665)).toEqual({
      ok: false,
      detail: "directDiscountCents 0 != discountCents 500",
    });
  });

  it("the old percent-only stamp still reads exactly as before (in-flight PaymentIntents)", () => {
    const q = computeDirectQuote({ rateCents: 995, days: 5, taxRatePercent: 16, promo: percentCode(10) });
    const m = meta({
      discountPercent: "10",
      directDiscountCents: String(q.discountCents),
      parkingOnlyChargeAmountCents: String(q.chargeCents),
    });
    expect(readDirectMetadataMoney(m, q.chargeCents + 1299)).toMatchObject({ ok: true, money: { discountCents: 498 } });
  });
});
