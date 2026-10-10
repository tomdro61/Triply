import { describe, it, expect } from "vitest";
import { isTestBooking, excludeTestBookings } from "../admin";

describe("isTestBooking", () => {
  it("a test ResLab lot is test, whatever the mode", () => {
    expect(isTestBooking({ reslab_location_id: 194, livemode: true })).toBe(true);
  });
  it("a Stripe TEST-mode payment is test (staging shares the database)", () => {
    expect(isTestBooking({ reslab_location_id: 42, livemode: false })).toBe(true);
    expect(isTestBooking({ reslab_location_id: null, livemode: false })).toBe(true);
  });
  it("NULL livemode is live (every pre-015 row is a real booking)", () => {
    expect(isTestBooking({ reslab_location_id: 42, livemode: null })).toBe(false);
  });
  it("a live direct-lot row (no ResLab lot id) is real", () => {
    expect(isTestBooking({ reslab_location_id: null, livemode: true })).toBe(false);
  });
});

describe("excludeTestBookings", () => {
  it("adds two null-safe OR filters (ANDed by PostgREST)", () => {
    const calls: string[] = [];
    const q = { or(f: string) { calls.push(f); return q; } };
    excludeTestBookings(q);
    expect(calls).toEqual([
      "reslab_location_id.is.null,reslab_location_id.not.in.(194,195,196,197)",
      "livemode.is.null,livemode.eq.true",
    ]);
  });
});
