import { describe, expect, it } from "vitest";
import { isFixedPromoEnabled } from "../flag";

/**
 * PROMO_FIXED_ENABLED decides whether $5 codes (the 23 <IATA>5 codes and, from
 * Nov 11 2026, new WELCOME codes) apply at checkout and are minted at signup.
 * Pinned because a near-miss value silently reads as OFF.
 */
const env = (value: string | undefined): NodeJS.ProcessEnv => ({ NODE_ENV: "test", PROMO_FIXED_ENABLED: value });

describe("isFixedPromoEnabled", () => {
  it.each(["true", "TRUE", " true ", "True\n"])("%j → on", (v) => {
    expect(isFixedPromoEnabled(env(v))).toBe(true);
  });

  it.each(["false", "", "1", "yes", "on", "enabled", "truee"])("%j → off", (v) => {
    expect(isFixedPromoEnabled(env(v))).toBe(false);
  });

  it("unset → off", () => {
    expect(isFixedPromoEnabled(env(undefined))).toBe(false);
  });
});

// NEGATIVE CONTROL (never merge): a type error only tsc sees.
const ciNegativeControl: number = "not a number";
void ciNegativeControl;
