import { describe, it, expect, beforeEach } from "vitest";
import {
  __attributionRateLimitSizeForTests,
  __resetAttributionRateLimitForTests,
  checkAttributionRateLimit,
} from "../limiter";

beforeEach(() => __resetAttributionRateLimitForTests());

describe("attribution rate limiter", () => {
  it("allows 30 per minute per key, then refuses, then resets after the window", () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 30; i++) expect(checkAttributionRateLimit("1.2.3.4", t0)).toBe(true);
    expect(checkAttributionRateLimit("1.2.3.4", t0 + 1)).toBe(false);
    expect(checkAttributionRateLimit("5.6.7.8", t0 + 1)).toBe(true);
    expect(checkAttributionRateLimit("1.2.3.4", t0 + 60_001)).toBe(true);
  });

  it("is BOUNDED — never grows past the cap (the ai/rate-limit Map does)", () => {
    for (let i = 0; i < 6000; i++) checkAttributionRateLimit(`ip-${i}`);
    expect(__attributionRateLimitSizeForTests()).toBeLessThanOrEqual(5000);
  });
});
