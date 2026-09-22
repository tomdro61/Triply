import { describe, it, expect } from "vitest";
import { deriveSearchEventDates } from "../derive";

describe("deriveSearchEventDates", () => {
  it("derives stay_days and lead_days for an ordinary future search", () => {
    expect(deriveSearchEventDates("2026-10-10", "2026-10-14", "2026-10-01")).toEqual({
      stayDays: 4,
      leadDays: 9,
    });
  });

  it("treats a same-day checkin/checkout as a valid 0-night stay", () => {
    expect(deriveSearchEventDates("2026-10-10", "2026-10-10", "2026-10-01")).toEqual({
      stayDays: 0,
      leadDays: 9,
    });
  });

  it("handles a stay that crosses a month boundary", () => {
    expect(deriveSearchEventDates("2026-01-28", "2026-02-03", "2026-01-20")).toEqual({
      stayDays: 6,
      leadDays: 8,
    });
  });

  it("handles a stay that crosses a year boundary", () => {
    expect(deriveSearchEventDates("2026-12-30", "2027-01-02", "2026-12-15")).toEqual({
      stayDays: 3,
      leadDays: 15,
    });
  });

  it("returns null for an invalid range — checkout before checkin", () => {
    expect(deriveSearchEventDates("2026-10-14", "2026-10-10", "2026-10-01")).toBeNull();
  });

  it("returns null for an unparseable checkin", () => {
    expect(deriveSearchEventDates("not-a-date", "2026-10-14", "2026-10-01")).toBeNull();
  });

  it("returns null for an unparseable checkout", () => {
    expect(deriveSearchEventDates("2026-10-10", "not-a-date", "2026-10-01")).toBeNull();
  });

  it("allows a negative lead_days — a checkin date already in the past is a real signal", () => {
    expect(deriveSearchEventDates("2026-10-01", "2026-10-05", "2026-10-10")).toEqual({
      stayDays: 4,
      leadDays: -9,
    });
  });

  it("defaults searchedOn to today when omitted", () => {
    const today = new Date().toISOString().slice(0, 10);
    const result = deriveSearchEventDates(today, today);
    expect(result).toEqual({ stayDays: 0, leadDays: 0 });
  });
});
