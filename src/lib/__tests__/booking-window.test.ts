import { describe, it, expect } from "vitest";
import {
  MAX_ADVANCE_BOOKING_DAYS,
  toLocalISODate,
  validateSearchDates,
} from "../booking-window";

// Fixed "now": a US evening, where toISOString() would already say tomorrow.
const NOW = new Date(2026, 9, 10, 21, 30); // 2026-10-10 21:30 local

describe("toLocalISODate", () => {
  it("formats the LOCAL calendar day, not the UTC one", () => {
    expect(toLocalISODate(NOW)).toBe("2026-10-10");
    expect(toLocalISODate(new Date(2026, 0, 5))).toBe("2026-01-05");
  });
});

describe("validateSearchDates — the single submit-time gate", () => {
  it("accepts a range inside the window", () => {
    expect(validateSearchDates("2026-10-15", "2026-10-20", NOW)).toBeNull();
  });

  it("accepts today and the exact 60-day boundary (ResLab's window is inclusive)", () => {
    expect(validateSearchDates("2026-10-10", "2026-10-11", NOW)).toBeNull();
    expect(validateSearchDates("2026-12-09", "2026-12-09", NOW)).toBeNull(); // +60, same-day return (the picker caps the return leg at max too)
  });

  it("rejects a typed check-in beyond the booking window with the window named", () => {
    const msg = validateSearchDates("2027-06-01", "2027-06-08", NOW);
    expect(msg).toMatch(new RegExp(`${MAX_ADVANCE_BOOKING_DAYS} days`));
    expect(msg).toMatch(/Dec 9, 2026/);
  });

  it("rejects a return date beyond the window even when the check-in is inside it", () => {
    expect(validateSearchDates("2026-12-05", "2026-12-20", NOW)).toMatch(/Dec 9, 2026/);
    expect(validateSearchDates("2026-12-05", "2026-12-09", NOW)).toBeNull();
  });

  it("rejects a past check-in", () => {
    expect(validateSearchDates("2026-10-09", "2026-10-12", NOW)).toMatch(/past/);
  });

  it("rejects a reversed range", () => {
    expect(validateSearchDates("2026-10-20", "2026-10-05", NOW)).toMatch(/on or after/);
  });

  it("rejects malformed or missing dates before comparing anything", () => {
    expect(validateSearchDates("", "2026-10-12", NOW)).toMatch(/both dates/);
    expect(validateSearchDates("10/15/2026", "2026-10-20", NOW)).toMatch(/both dates/);
  });
});
