import { describe, it, expect, vi } from "vitest";
import { cancelSource, isOtherStripeMode, stripeKeyIsLive } from "../source-guard";

describe("cancelSource — strict polarity (plan 4b §9 H-C)", () => {
  it("a ResLab row calls ResLab, with or without the column selected", () => {
    expect(cancelSource({ inventory_source: "reslab", reslab_reservation_number: "RTL862696" })).toEqual({ kind: "reslab" });
    expect(cancelSource({ reslab_reservation_number: "RTL862696" })).toEqual({ kind: "reslab" });
    expect(cancelSource({ inventory_source: null, reslab_reservation_number: "RTL1" })).toEqual({ kind: "reslab" });
  });
  it("a direct row with our own number skips ResLab", () => {
    expect(cancelSource({ inventory_source: "direct", reslab_reservation_number: "TRP-AB12CD34" })).toEqual({ kind: "direct" });
  });
  it("disagreement never bypasses ResLab silently", () => {
    expect(cancelSource({ inventory_source: "direct", reslab_reservation_number: "RTL1" }).kind).toBe("inconsistent");
    expect(cancelSource({ inventory_source: "reslab", reslab_reservation_number: "TRP-AB12CD34" }).kind).toBe("inconsistent");
    expect(cancelSource({ reslab_reservation_number: "TRP-AB12CD34" }).kind).toBe("inconsistent");
    expect(cancelSource({ inventory_source: "other", reslab_reservation_number: "RTL1" }).kind).toBe("inconsistent");
  });
});

describe("isOtherStripeMode (plan 4b §9 H-D)", () => {
  it("compares a recorded mode with the key's", () => {
    expect(isOtherStripeMode(false, true)).toBe(true); // staging booking, production key
    expect(isOtherStripeMode(true, false)).toBe(true); // live booking, staging key
    expect(isOtherStripeMode(true, true)).toBe(false);
    expect(isOtherStripeMode(false, false)).toBe(false);
  });
  it("NULL (pre-015 row) is a LIVE booking: production acts, a test key refuses", () => {
    expect(isOtherStripeMode(null, true)).toBe(false); // production, unchanged
    expect(isOtherStripeMode(null, false)).toBe(true); // staging/localhost must not cancel it
  });
  it("undefined (column not selected) never guards", () => {
    expect(isOtherStripeMode(undefined, false)).toBe(false);
    expect(isOtherStripeMode(undefined, true)).toBe(false);
  });
  it("defaults to this deployment's key", () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_live_x");
    try {
      expect(isOtherStripeMode(null)).toBe(false);
      expect(isOtherStripeMode(false)).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    try {
      expect(isOtherStripeMode(null)).toBe(true);
      expect(isOtherStripeMode(false)).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("reads live keys (secret and restricted)", () => {
    expect(stripeKeyIsLive("sk_live_x")).toBe(true);
    expect(stripeKeyIsLive("rk_live_x")).toBe(true);
    expect(stripeKeyIsLive("sk_test_x")).toBe(false);
    expect(stripeKeyIsLive("")).toBe(false);
  });
});
