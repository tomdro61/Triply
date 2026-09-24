import { describe, it, expect } from "vitest";
import { deriveHotelNight, shiftIsoDate, todayInZone, isHotelCheckinBookable } from "../dates";

describe("shiftIsoDate — pure calendar arithmetic, no timezone", () => {
  it("crosses month, year and leap-day boundaries", () => {
    expect(shiftIsoDate("2026-03-01", -1)).toBe("2026-02-28");
    expect(shiftIsoDate("2028-03-01", -1)).toBe("2028-02-29");
    expect(shiftIsoDate("2026-12-31", 1)).toBe("2027-01-01");
    expect(shiftIsoDate("2026-01-01", -1)).toBe("2025-12-31");
  });

  it("is unaffected by DST transitions (a day is a day, not 86 400 000 ms)", () => {
    // US spring-forward 2026-03-08 and fall-back 2026-11-01.
    expect(shiftIsoDate("2026-03-08", 1)).toBe("2026-03-09");
    expect(shiftIsoDate("2026-11-01", -1)).toBe("2026-10-31");
  });

  it("rejects anything that is not YYYY-MM-DD", () => {
    expect(() => shiftIsoDate("2026-3-8", 1)).toThrow(/YYYY-MM-DD/);
    expect(() => shiftIsoDate("2026-03-08T00:00:00Z", 1)).toThrow(/YYYY-MM-DD/);
  });
});

describe("deriveHotelNight", () => {
  it("'before' books the night before parking starts", () => {
    expect(deriveHotelNight("2026-10-15", "2026-10-20", "before")).toEqual({
      checkin: "2026-10-14",
      checkout: "2026-10-15",
    });
  });

  it("'after' books the night the traveller gets back", () => {
    expect(deriveHotelNight("2026-10-15", "2026-10-20", "after")).toEqual({
      checkin: "2026-10-20",
      checkout: "2026-10-21",
    });
  });

  it("never depends on the parking TIMES — only the dates are inputs", () => {
    // Same-day trip: night before is the previous calendar day regardless of a 4:00 AM check-in.
    expect(deriveHotelNight("2026-10-15", "2026-10-15", "before").checkin).toBe("2026-10-14");
  });
});

describe("todayInZone / isHotelCheckinBookable — the only clock in the module", () => {
  // 2026-10-15T03:30:00Z is the evening of the 14th in New York and the morning of the 15th in London.
  const instant = new Date("2026-10-15T03:30:00Z");

  it("reports the calendar day AT THE AIRPORT, not the server's", () => {
    expect(todayInZone("America/New_York", instant)).toBe("2026-10-14");
    expect(todayInZone("Europe/London", instant)).toBe("2026-10-15");
    expect(todayInZone("Pacific/Kiritimati", instant)).toBe("2026-10-15");
  });

  it("'night before' for a same-day trip is bookable only while it is still that day at the airport", () => {
    // Parking starts 2026-10-15; the night before is 2026-10-14. At 23:30 New York on the 14th it is still bookable…
    expect(isHotelCheckinBookable("2026-10-14", "America/New_York", instant)).toBe(true);
    // …but at the same instant in London (already the 15th) it is in the past.
    expect(isHotelCheckinBookable("2026-10-14", "Europe/London", instant)).toBe(false);
  });
});
