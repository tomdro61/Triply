import { describe, it, expect } from "vitest";
import { isIsoDate, isoDayDiff, shiftIsoDate, todayInZone } from "../dates";

describe("shiftIsoDate — pure calendar arithmetic, no timezone", () => {
  it("crosses month, year and leap-day boundaries", () => {
    expect(shiftIsoDate("2026-03-01", -1)).toBe("2026-02-28");
    expect(shiftIsoDate("2028-03-01", -1)).toBe("2028-02-29");
    expect(shiftIsoDate("2026-12-31", 1)).toBe("2027-01-01");
    expect(shiftIsoDate("2026-01-01", -1)).toBe("2025-12-31");
  });

  it("is unaffected by DST transitions (a day is a day, not 86 400 000 ms)", () => {
    expect(shiftIsoDate("2026-03-08", 1)).toBe("2026-03-09");
    expect(shiftIsoDate("2026-11-01", -1)).toBe("2026-10-31");
  });

  it("rejects anything that is not YYYY-MM-DD", () => {
    expect(() => shiftIsoDate("2026-3-8", 1)).toThrow(/YYYY-MM-DD/);
    expect(() => shiftIsoDate("2026-03-08T00:00:00Z", 1)).toThrow(/YYYY-MM-DD/);
  });

  it("rejects a well-shaped date that doesn't exist, instead of rolling it over (review round 1, item 10)", () => {
    expect(() => shiftIsoDate("2026-02-30", 0)).toThrow(/real YYYY-MM-DD/);
    expect(() => shiftIsoDate("2027-02-29", 1)).toThrow(/real YYYY-MM-DD/);
    expect(() => isoDayDiff("2026-04-31", "2026-05-01")).toThrow(/real YYYY-MM-DD/);
    expect(shiftIsoDate("2028-02-29", 1)).toBe("2028-03-01");
  });
});

describe("isIsoDate / isoDayDiff", () => {
  it("accepts only real calendar dates", () => {
    expect(isIsoDate("2026-11-11")).toBe(true);
    expect(isIsoDate("2028-02-29")).toBe(true);
    expect(isIsoDate("2026-02-29")).toBe(false);
    expect(isIsoDate("2026-13-01")).toBe(false);
    expect(isIsoDate("2026-11-1")).toBe(false);
  });
  it("counts calendar days across DST and year ends", () => {
    expect(isoDayDiff("2026-10-31", "2026-11-02")).toBe(2);
    expect(isoDayDiff("2026-12-31", "2027-01-01")).toBe(1);
    expect(isoDayDiff("2026-03-09", "2026-03-08")).toBe(-1);
  });
});

describe("todayInZone — the calendar day AT THE AIRPORT", () => {
  // 2026-10-15T03:30:00Z is the evening of the 14th in New York and the morning of the 15th in London.
  const instant = new Date("2026-10-15T03:30:00Z");
  it("reports the airport's date, not the server's", () => {
    expect(todayInZone("America/New_York", instant)).toBe("2026-10-14");
    expect(todayInZone("Europe/London", instant)).toBe("2026-10-15");
  });
});
