import { describe, it, expect } from "vitest";
import { FALLBACK_TIMEZONE, bookingStatusLabel, evidenceZone, formatInstant, formatInstantUtc, MATCH_STATEMENT } from "../evidence";

describe("support evidence formatting", () => {
  it("shows an instant in the lot's zone, naming the zone", () => {
    // 20:42 UTC on Nov 11 = 3:42 PM in New York (EST), 12:42 PM in LA (PST).
    expect(formatInstant("2026-11-11T20:42:00Z", "America/New_York")).toBe("Nov 11, 2026, 3:42 PM EST");
    expect(formatInstant("2026-11-11T20:42:00Z", "America/Los_Angeles")).toBe("Nov 11, 2026, 12:42 PM PST");
  });

  it("falls back to New York for a missing or broken zone, and says which zone the page uses", () => {
    expect(formatInstant("2026-11-11T20:42:00Z", null)).toBe("Nov 11, 2026, 3:42 PM EST");
    expect(formatInstant("2026-11-11T20:42:00Z", "Not/AZone")).toBe("Nov 11, 2026, 3:42 PM EST");
    expect(evidenceZone({ location_timezone: "Not/AZone" })).toBe(FALLBACK_TIMEZONE);
    expect(evidenceZone(null)).toBe(FALLBACK_TIMEZONE);
    expect(evidenceZone({ location_timezone: "America/Chicago" })).toBe("America/Chicago");
  });

  it("says 'not recorded' rather than inventing a time", () => {
    expect(formatInstant(null, "America/New_York")).toBe("not recorded");
    expect(formatInstant("garbage", "America/New_York")).toBe("not recorded");
    expect(formatInstantUtc(undefined)).toBe("not recorded");
    expect(formatInstantUtc("2026-11-11T20:42:05.123Z")).toBe("2026-11-11T20:42:05Z (UTC)");
  });

  it("a started cancellation shows even while the status still reads confirmed", () => {
    expect(bookingStatusLabel({ status: "confirmed", cancel_state: "claimed" })).toBe("Confirmed (cancellation in progress)");
    expect(bookingStatusLabel({ status: "refunded", cancel_state: "done" })).toBe("Cancelled and refunded");
    expect(bookingStatusLabel({ status: null, cancel_state: null })).toBe("not recorded");
    expect(bookingStatusLabel({ status: "weird_new", cancel_state: null })).toBe("weird_new");
  });

  it("has a statement for every booking match the database allows", () => {
    expect(Object.keys(MATCH_STATEMENT).sort()).toEqual(["email_mismatch", "lookup_failed", "matched", "none", "not_found"]);
  });
});
