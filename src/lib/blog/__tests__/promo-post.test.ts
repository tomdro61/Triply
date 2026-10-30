import { describe, it, expect } from "vitest";
import { isPromoPost } from "../promo-post";

describe("isPromoPost", () => {
  it.each([
    "dfw-airport-parking-promo-code-2023",
    "lax-official-airport-parking-promo-code",
    "clt-airport-parking-promo",
    "laguardia-airport-parking-deals",
    "bush-airport-parking-coupon",
    "bwi-long-term-parking-discount-code",
    "pearson-airport-parking-military-discount",
    "bwi-airport-parking-groupon",
    "iah-airport-parking-code",
  ])("matches %s", (slug) => {
    expect(isPromoPost(slug)).toBe(true);
  });

  it.each([
    "msp-parking-qr-code",
    "bwi-airport-parking-per-day",
    "how-much-is-parking-at-lax",
    "jfk-airport-short-term-parking-terminal-8",
    "promotional-parking-guide",
    "seattle-airport-parking-decoded",
  ])("does not match %s", (slug) => {
    expect(isPromoPost(slug)).toBe(false);
  });
});
