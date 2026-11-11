import { describe, it, expect } from "vitest";
import { bookingStatusLabel, evidenceZone, formatInstant, formatInstantUtc, MATCH_STATEMENT } from "../evidence";

describe("support evidence formatting", () => {
  it("shows an instant in the lot's zone, naming the zone", () => {
    // 20:42 UTC on Nov 11 = 3:42 PM in New York (EST), 12:42 PM in LA (PST).
    expect(formatInstant("2026-11-11T20:42:00Z", "America/New_York")).toBe("Nov 11, 2026, 3:42 PM EST");
    expect(formatInstant("2026-11-11T20:42:00Z", "America/Los_Angeles")).toBe("Nov 11, 2026, 12:42 PM PST");
  });

  it("with no known zone, shows UTC: never a guessed local zone", () => {
    expect(formatInstant("2026-11-11T20:42:00Z", null)).toBe("Nov 11, 2026, 8:42 PM UTC");
    expect(formatInstant("2026-11-11T20:42:00Z", "Not/AZone")).toBe("Nov 11, 2026, 8:42 PM UTC");
  });

  it("uses the booking's zone, else its airport's, else none", () => {
    expect(evidenceZone({ location_timezone: "America/Chicago" }, "America/Denver")).toBe("America/Chicago");
    expect(evidenceZone({ location_timezone: null }, "America/Los_Angeles")).toBe("America/Los_Angeles");
    expect(evidenceZone({ location_timezone: "Not/AZone" }, "Bad/Zone")).toBeNull();
    expect(evidenceZone(null)).toBeNull();
  });

  it("says 'not recorded' rather than inventing a time", () => {
    expect(formatInstant(null, "America/New_York")).toBe("not recorded");
    expect(formatInstant("garbage", "America/New_York")).toBe("not recorded");
    expect(formatInstantUtc(undefined)).toBe("not recorded");
    expect(formatInstantUtc("2026-11-11T20:42:05.123Z")).toBe("2026-11-11T20:42:05Z (UTC)");
  });

  it("a started cancellation shows even while the status still reads confirmed", () => {
    expect(bookingStatusLabel({ status: "confirmed", cancel_state: "claimed" })).toBe("Confirmed (cancellation in progress)");
    expect(bookingStatusLabel({ status: "refunded", cancel_state: "refund_issued" })).toBe("Cancelled and refunded");
    expect(bookingStatusLabel({ status: null, cancel_state: null })).toBe("not recorded");
    expect(bookingStatusLabel({ status: "weird_new", cancel_state: null })).toBe("weird_new");
  });

  it("never claims the form's email was verified or was the sender", () => {
    for (const s of Object.values(MATCH_STATEMENT)) expect(s).not.toMatch(/sent (this|the) request/);
    expect(MATCH_STATEMENT.matched).toContain("(not verified)");
  });
});
