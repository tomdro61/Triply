import { describe, expect, it } from "vitest";
import { adminDateRange, etDayBounds } from "../eastern-day";

describe("etDayBounds", () => {
  it("keeps 8:15 PM ET on the same Eastern day (UTC is already tomorrow)", () => {
    // 2026-10-22 00:15 UTC = Oct 21 8:15 PM EDT
    const b = etDayBounds(new Date("2026-10-22T00:15:00Z"));
    expect(b.day).toBe("2026-10-21");
    expect(b.todayStart).toBe("2026-10-21T04:00:00.000Z");
    expect(b.tomorrowStart).toBe("2026-10-22T04:00:00.000Z");
    expect(b.weekStart).toBe("2026-10-18T04:00:00.000Z"); // Sunday
    expect(b.monthStart).toBe("2026-10-01T04:00:00.000Z");
  });

  it("uses EST offsets after daylight saving ends", () => {
    const b = etDayBounds(new Date("2026-11-10T15:00:00Z"));
    expect(b.todayStart).toBe("2026-11-10T05:00:00.000Z");
    expect(b.monthStart).toBe("2026-11-01T04:00:00.000Z"); // Nov 1 midnight is still EDT
  });

  it("the fall-back day (Nov 1) is 25 hours long", () => {
    const b = etDayBounds(new Date("2026-11-01T12:00:00Z"));
    expect(Date.parse(b.tomorrowStart) - Date.parse(b.todayStart)).toBe(25 * 3600_000);
  });

  it("puts the month start in the right month at 11 PM ET on the last day", () => {
    // Oct 31 11:00 PM EDT = Nov 1 03:00 UTC
    const b = etDayBounds(new Date("2026-11-01T03:00:00Z"));
    expect(b.day).toBe("2026-10-31");
    expect(b.monthStart).toBe("2026-10-01T04:00:00.000Z");
  });
});

describe("adminDateRange", () => {
  const now = new Date("2026-10-22T00:15:00Z"); // Oct 21 8:15 PM EDT

  it("today = Eastern midnight to the next", () => {
    expect(adminDateRange("today", {}, now)).toEqual({
      startDate: "2026-10-21T04:00:00.000Z",
      endDate: "2026-10-22T04:00:00.000Z",
    });
  });

  it("last 7 / last 30 include today", () => {
    expect(adminDateRange("last7", {}, now)).toEqual({ startDate: "2026-10-15T04:00:00.000Z" });
    expect(adminDateRange("last30", {}, now)).toEqual({ startDate: "2026-09-22T04:00:00.000Z" });
  });

  it("custom dates are Eastern days, end day included", () => {
    expect(adminDateRange("custom", { start: "2026-10-01", end: "2026-10-05" }, now)).toEqual({
      startDate: "2026-10-01T04:00:00.000Z",
      endDate: "2026-10-06T04:00:00.000Z",
    });
    expect(adminDateRange("custom", { start: "2026-10-01" }, now)).toEqual({ startDate: "2026-10-01T04:00:00.000Z" });
    expect(adminDateRange("custom", { start: "" }, now)).toEqual({});
  });

  it("all (or an unknown value) = no filter", () => {
    expect(adminDateRange("all", {}, now)).toEqual({});
    expect(adminDateRange("nope", {}, now)).toEqual({});
  });
});
