import { describe, expect, it } from "vitest";
import { readDirectMetadataMoney } from "../metadata-money";
import { computeDirectQuote } from "../pricing";

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
    const q = computeDirectQuote({ rateCents: 995, days: 5, taxRatePercent: 16, discountPercent: 10 });
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
