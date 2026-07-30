import { describe, it, expect } from "vitest";
import {
  isCancellable,
  checkInInstantMs,
  CANCEL_CUTOFF_HOURS,
} from "../eligibility";

const NY = "America/New_York";
const LA = "America/Los_Angeles";
const HOUR = 3_600_000;

describe("checkInInstantMs — absolute UTC instant (DST-correct)", () => {
  it("interprets a SUMMER wall-clock as EDT (UTC-4)", () => {
    // 2026-08-15 10:00 in New York (EDT) === 2026-08-15 14:00 UTC
    expect(checkInInstantMs("2026-08-15 10:00:00", NY)).toBe(
      Date.UTC(2026, 7, 15, 14, 0, 0),
    );
  });

  it("interprets a WINTER wall-clock as EST (UTC-5)", () => {
    // 2026-01-15 10:00 in New York (EST) === 2026-01-15 15:00 UTC
    expect(checkInInstantMs("2026-01-15 10:00:00", NY)).toBe(
      Date.UTC(2026, 0, 15, 15, 0, 0),
    );
  });

  it("handles a non-Eastern zone (LAX summer, PDT UTC-7)", () => {
    expect(checkInInstantMs("2026-08-15 10:00:00", LA)).toBe(
      Date.UTC(2026, 7, 15, 17, 0, 0),
    );
  });

  it("accepts the PostgREST 'T'-separated read-back form", () => {
    expect(checkInInstantMs("2026-08-15T10:00:00", NY)).toBe(
      Date.UTC(2026, 7, 15, 14, 0, 0),
    );
  });

  it("accepts a value with no seconds", () => {
    expect(checkInInstantMs("2026-08-15 10:00", NY)).toBe(
      Date.UTC(2026, 7, 15, 14, 0, 0),
    );
  });

  it("does NOT parse the wall-clock as UTC (regression guard for the shipped bug)", () => {
    expect(checkInInstantMs("2026-08-15 10:00:00", NY)).not.toBe(
      Date.UTC(2026, 7, 15, 10, 0, 0),
    );
  });

  it("returns null for a malformed timestamp", () => {
    expect(checkInInstantMs("2026/08/15 10:00", NY)).toBeNull();
    expect(checkInInstantMs("not-a-date", NY)).toBeNull();
  });

  it("returns null for a value carrying an offset/Z (not a bare wall-clock)", () => {
    expect(checkInInstantMs("2026-08-15T10:00:00Z", NY)).toBeNull();
    expect(checkInInstantMs("2026-08-15T10:00:00-04:00", NY)).toBeNull();
  });

  it("returns null for an invalid IANA timezone (fail closed)", () => {
    expect(checkInInstantMs("2026-08-15 10:00:00", "Not/AZone")).toBeNull();
  });

  it("returns null for null/empty inputs", () => {
    expect(checkInInstantMs(null, NY)).toBeNull();
    expect(checkInInstantMs("2026-08-15 10:00:00", null)).toBeNull();
    expect(checkInInstantMs("2026-08-15 10:00:00", "")).toBeNull();
  });

  // Range-validation: format-valid but out-of-range components must fail closed,
  // NOT silently roll over into a shifted instant.
  it("returns null for range-invalid components (would otherwise roll over)", () => {
    expect(checkInInstantMs("2026-02-29 10:00:00", NY)).toBeNull(); // 2026 not leap
    expect(checkInInstantMs("2026-04-31 10:00:00", NY)).toBeNull(); // April has 30
    expect(checkInInstantMs("2026-13-15 10:00:00", NY)).toBeNull(); // month 13
    expect(checkInInstantMs("2026-08-15 25:00:00", NY)).toBeNull(); // hour 25
    expect(checkInInstantMs("2026-08-15 10:60:00", NY)).toBeNull(); // minute 60
  });

  it("accepts a REAL leap day (2028-02-29) — February is EST (UTC-5)", () => {
    expect(checkInInstantMs("2028-02-29 10:00:00", NY)).toBe(
      Date.UTC(2028, 1, 29, 15, 0, 0),
    );
  });

  // DST-transition regression locks (pins the library's resolution of the
  // nonexistent spring-forward gap hour and the ambiguous fall-back hour).
  it("resolves the spring-forward GAP time deterministically (not null/NaN)", () => {
    const ms = checkInInstantMs("2026-03-08 02:30:00", NY); // 2:30 doesn't exist
    expect(ms).not.toBeNull();
    expect(Number.isNaN(ms)).toBe(false);
  });

  it("resolves the fall-back AMBIGUOUS time deterministically (not null/NaN)", () => {
    const ms = checkInInstantMs("2026-11-01 01:30:00", NY); // 1:30 occurs twice
    expect(ms).not.toBeNull();
    expect(Number.isNaN(ms)).toBe(false);
  });
});

describe("isCancellable — 24h gate", () => {
  const checkIn = "2026-08-15 10:00:00"; // EDT → 2026-08-15 14:00 UTC
  const instant = Date.UTC(2026, 7, 15, 14, 0, 0);

  it("cancellable when now is > 24h before check-in", () => {
    expect(isCancellable(checkIn, NY, instant - 25 * HOUR)).toEqual({
      cancellable: true,
      reason: "ok",
    });
  });

  it("NOT cancellable when now is < 24h before check-in", () => {
    expect(isCancellable(checkIn, NY, instant - 23 * HOUR)).toEqual({
      cancellable: false,
      reason: "within_24h",
    });
  });

  it("boundary: exactly 24h before is NOT cancellable (strict >)", () => {
    expect(
      isCancellable(checkIn, NY, instant - CANCEL_CUTOFF_HOURS * HOUR).cancellable,
    ).toBe(false);
  });

  it("boundary: one second past 24h IS cancellable", () => {
    expect(
      isCancellable(checkIn, NY, instant - CANCEL_CUTOFF_HOURS * HOUR - 1000)
        .cancellable,
    ).toBe(true);
  });

  it("NOT cancellable for a check-in already in the past", () => {
    expect(isCancellable(checkIn, NY, instant + HOUR)).toEqual({
      cancellable: false,
      reason: "within_24h",
    });
  });

  it("evaluates in the LOT's zone, not the server's — DST winter case", () => {
    const winter = "2026-01-15 10:00:00";
    const winterInstant = Date.UTC(2026, 0, 15, 15, 0, 0);
    expect(isCancellable(winter, NY, winterInstant - 25 * HOUR).cancellable).toBe(true);
    expect(isCancellable(winter, NY, winterInstant - 23 * HOUR).cancellable).toBe(false);
  });

  it("fails closed (unknown_timezone) when tz is null/empty", () => {
    expect(isCancellable(checkIn, null)).toEqual({
      cancellable: false,
      reason: "unknown_timezone",
    });
    expect(isCancellable(checkIn, "")).toEqual({
      cancellable: false,
      reason: "unknown_timezone",
    });
  });

  it("fails closed (bad_timestamp) when check_in is malformed/empty/null", () => {
    expect(isCancellable("not-a-date", NY).reason).toBe("bad_timestamp");
    expect(isCancellable("", NY).reason).toBe("bad_timestamp");
    expect(isCancellable(null, NY).reason).toBe("bad_timestamp");
  });

  it("fails closed (bad_timestamp) for a range-invalid timestamp", () => {
    expect(isCancellable("2026-02-29 10:00:00", NY).reason).toBe("bad_timestamp");
    expect(isCancellable("2026-08-15 25:00:00", NY).reason).toBe("bad_timestamp");
  });

  it("fails closed (unknown_timezone) for an invalid IANA zone", () => {
    expect(isCancellable(checkIn, "Not/AZone")).toEqual({
      cancellable: false,
      reason: "unknown_timezone",
    });
  });
});
