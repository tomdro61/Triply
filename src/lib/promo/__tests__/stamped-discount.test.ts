import { describe, it, expect } from "vitest";
import { readStampedDiscount, stampedDiscountRefusal } from "../stamped-discount";

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
