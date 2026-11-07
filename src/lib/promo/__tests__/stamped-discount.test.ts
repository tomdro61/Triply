import { describe, it, expect } from "vitest";
import { checkStampAgainstCharge, promoStampMetadata, readCheckoutFigures, readStampedDiscount, stampedDiscountRefusal } from "../stamped-discount";

describe("readStampedDiscount — PaymentIntent metadata.discountCents", () => {
  it("absent when the key is not there (every PaymentIntent before the writer)", () => {
    expect(readStampedDiscount({ discountPercent: "10" })).toEqual({ kind: "absent" });
    expect(readStampedDiscount({})).toEqual({ kind: "absent" });
    expect(readStampedDiscount(null)).toEqual({ kind: "absent" });
    expect(readStampedDiscount(undefined)).toEqual({ kind: "absent" });
  });

  it("a positive whole number of cents", () => {
    expect(readStampedDiscount({ discountCents: "500" })).toEqual({ kind: "cents", cents: 500 });
    expect(readStampedDiscount({ discountCents: "1" })).toEqual({ kind: "cents", cents: 1 });
  });

  it.each(["0", "-500", "5.00", "500.5", "05", " 500", "500 ", "", "5e2", "abc", "1234567890"])(
    "%j is invalid — refused, never coerced",
    (raw) => {
      expect(readStampedDiscount({ discountCents: raw })).toEqual({ kind: "invalid", raw });
    }
  );
});

describe("stampedDiscountRefusal — bounds", () => {
  it("within the online parking: trusted", () => {
    expect(stampedDiscountRefusal({ kind: "cents", cents: 500 }, 6800)).toBeNull();
    expect(stampedDiscountRefusal({ kind: "cents", cents: 500 }, 500)).toBeNull();
  });

  it("above the online parking: refused (it would come out of the service fee)", () => {
    expect(stampedDiscountRefusal({ kind: "cents", cents: 501 }, 500)).toMatch(/exceeds the online parking 500/);
  });

  it("invalid: refused", () => {
    expect(stampedDiscountRefusal({ kind: "invalid", raw: "5.00" }, 6800)).toMatch(/not a positive whole number/);
  });

  it.each([Number.NaN, -1, 1.5])("an unknown online parking (%s): refused, the bound cannot be checked", (online) => {
    expect(stampedDiscountRefusal({ kind: "cents", cents: 500 }, online)).toMatch(/cannot be checked/);
  });
});

describe("readCheckoutFigures — checkout's own figures beside the stamp (PR 1 review)", () => {
  it("absent when neither key is there", () => {
    expect(readCheckoutFigures({ discountCents: "500" })).toEqual({ kind: "absent" });
    expect(readCheckoutFigures(undefined)).toEqual({ kind: "absent" });
  });

  it("both, as whole cents", () => {
    expect(readCheckoutFigures({ onlineParkingCents: "6800", preDiscountOnlineCents: "7400" })).toEqual({
      kind: "figures",
      onlineParkingCents: 6800,
      preDiscountOnlineCents: 7400,
    });
    expect(readCheckoutFigures({ onlineParkingCents: "0", preDiscountOnlineCents: "595" })).toMatchObject({ kind: "figures", onlineParkingCents: 0 });
  });

  it.each([
    ["one without the other", { onlineParkingCents: "6800" }],
    ["the other without the one", { preDiscountOnlineCents: "7400" }],
    ["a decimal", { onlineParkingCents: "68.00", preDiscountOnlineCents: "7400" }],
    ["a negative", { onlineParkingCents: "6800", preDiscountOnlineCents: "-1" }],
    ["online parking above the pre-discount total (which includes the fee)", { onlineParkingCents: "7500", preDiscountOnlineCents: "7400" }],
  ])("invalid: %s", (_label, meta) => {
    expect(readCheckoutFigures(meta).kind).toBe("invalid");
  });
});

describe("checkStampAgainstCharge — what the PaymentIntent alone can prove", () => {
  const CHECKOUT = { onlineParkingCents: "6800", preDiscountOnlineCents: "7400", parkingOnlyChargeAmountCents: "6900", serviceFee: "6" };
  const stamp = { kind: "cents" as const, cents: 500 };

  it("no checkout figures: refused (required beside a stamp since PR 2); an unusable stamp still fails on its own form first", () => {
    expect(checkStampAgainstCharge({}, stamp, { premiumCents: 0, piAmountCents: 1 })).toMatchObject({
      ok: false,
      cause: "stamp_invalid",
      detail: expect.stringContaining("without onlineParkingCents"),
    });
    expect(checkStampAgainstCharge({}, { kind: "invalid", raw: "5.00" }, { premiumCents: 0, piAmountCents: 6900 })).toMatchObject({
      ok: false,
      cause: "stamp_invalid",
    });
  });

  it("figures that add up (with Park Guard): ok", () => {
    expect(checkStampAgainstCharge(CHECKOUT, stamp, { premiumCents: 1299, piAmountCents: 8199 })).toMatchObject({ ok: true, checkout: { kind: "figures" } });
  });

  it("a fee stamped as String(dollars) with cents: ok (5.95 → 595, no float drift)", () => {
    const meta = { onlineParkingCents: "2000", preDiscountOnlineCents: "2595", parkingOnlyChargeAmountCents: "2095", serviceFee: "5.95" };
    expect(checkStampAgainstCharge(meta, stamp, { premiumCents: 0, piAmountCents: 2095 })).toMatchObject({ ok: true });
  });

  it.each([
    ["pre-discount − discount ≠ parking-only", { ...CHECKOUT, parkingOnlyChargeAmountCents: "6800" }, 6800, "stamp_inconsistent"],
    ["parking-only + premium ≠ pi.amount", CHECKOUT, 6901, "stamp_inconsistent"],
    ["parking-only missing", { onlineParkingCents: "6800", preDiscountOnlineCents: "7400" }, 6900, "stamp_inconsistent"],
    ["partial figures", { onlineParkingCents: "6800", parkingOnlyChargeAmountCents: "6900" }, 6900, "stamp_invalid"],
    ["more than checkout's online parking", { onlineParkingCents: "400", preDiscountOnlineCents: "1000", parkingOnlyChargeAmountCents: "500", serviceFee: "6" }, 500, "stamp_exceeds_checkout_online_parking"],
    ["serviceFee missing", { onlineParkingCents: "6800", preDiscountOnlineCents: "7400", parkingOnlyChargeAmountCents: "6900" }, 6900, "stamp_inconsistent"],
    ["serviceFee not a dollar amount", { ...CHECKOUT, serviceFee: "6.000" }, 6900, "stamp_inconsistent"],
    // Due at the lot (3.00) is under the fee (5.95), so this passes online ≤ pre-discount:
    // online parking 2.00 stamped as 5.00 would let $3 of the $5 come out of the fee.
    ["online parking that forgot due_at_location (due under the fee)", { onlineParkingCents: "500", preDiscountOnlineCents: "795", parkingOnlyChargeAmountCents: "295", serviceFee: "5.95" }, 295, "stamp_inconsistent"],
  ])("refused: %s", (_label, meta, piAmountCents, cause) => {
    expect(checkStampAgainstCharge(meta, stamp, { premiumCents: 0, piAmountCents })).toMatchObject({ ok: false, cause });
  });
});

describe("promoStampMetadata — the writer's half (POST /api/checkout/lot)", () => {
  const figures = { discountCents: 500, onlineParkingCents: 6800, preDiscountOnlineCents: 7400 };

  it("the code, discountCents and both figures, always together; discountPercent only for a percent code", () => {
    expect(promoStampMetadata({ code: "JFK5", percent: null, ...figures })).toEqual({
      promoCode: "JFK5",
      discountCents: "500",
      onlineParkingCents: "6800",
      preDiscountOnlineCents: "7400",
    });
    expect(promoStampMetadata({ code: "TEN", percent: 10, ...figures })).toMatchObject({ discountPercent: "10" });
  });

  it("what it writes, with checkout's other keys, passes the reader exactly (with and without Park Guard)", () => {
    const meta = { ...promoStampMetadata({ code: "JFK5", percent: null, ...figures }), parkingOnlyChargeAmountCents: "6900", serviceFee: "6" };
    const stamped = readStampedDiscount(meta);
    if (stamped.kind === "absent") throw new Error("no discountCents stamped");
    expect(checkStampAgainstCharge(meta, stamped, { premiumCents: 0, piAmountCents: 6900 })).toMatchObject({ ok: true, cents: 500 });
    expect(checkStampAgainstCharge(meta, stamped, { premiumCents: 1299, piAmountCents: 8199 })).toMatchObject({ ok: true, cents: 500 });
  });

  it.each([
    ["a zero discount (a code that gave none stamps nothing)", { discountCents: 0 }],
    ["fractional cents", { discountCents: 4.5 }],
    ["a discount above the online parking (out of the fee)", { discountCents: 6801 }],
    ["online parking above the pre-discount total", { onlineParkingCents: 7500 }],
    ["an unknown figure", { onlineParkingCents: Number.NaN }],
  ])("throws rather than write a stamp the readers would refuse: %s", (_label, over) => {
    expect(() => promoStampMetadata({ code: "JFK5", percent: null, ...figures, ...over })).toThrow(/promoStampMetadata/);
  });
});
