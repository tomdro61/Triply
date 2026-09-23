import { describe, it, expect, vi, afterEach } from "vitest";
import { deriveSearchEventDates, utcToday } from "../derive";
import { localToday } from "@/lib/availability/log";

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

  describe("timezone boundary — searchedOn must be the airport's local today, not UTC", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("under-counts lead_days by a day if the caller passes utcToday() for a US evening search", () => {
      // 9:30pm US Eastern on Oct 10 is already Oct 11 in UTC.
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-10-11T01:30:00Z"));

      expect(utcToday()).toBe("2026-10-11");
      expect(localToday("America/New_York")).toBe("2026-10-10");

      // Same checkin, two different "today"s the caller could pass — this is
      // exactly the drift the review flagged between availability_log
      // (localToday) and the old search_events (utcToday) baseline.
      const withUtcToday = deriveSearchEventDates("2026-10-15", "2026-10-18", utcToday());
      const withAirportLocalToday = deriveSearchEventDates(
        "2026-10-15",
        "2026-10-18",
        localToday("America/New_York")
      );

      expect(withUtcToday?.leadDays).toBe(4);
      expect(withAirportLocalToday?.leadDays).toBe(5);
      // The route (src/lib/reslab/search.ts) must use the airport-local
      // value, matching what availability_log records for the same search.
      expect(withAirportLocalToday?.leadDays).not.toBe(withUtcToday?.leadDays);
    });

    it("agrees with UTC for a west-coast morning search — no boundary crossed", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-10-11T15:00:00Z")); // 8am PT, Oct 11 everywhere

      expect(utcToday()).toBe(localToday("America/Los_Angeles"));
    });
  });
});
