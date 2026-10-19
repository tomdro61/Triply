import { describe, it, expect } from "vitest";
import { parseTime12Strict } from "@/lib/utils/time";
import { shiftIsoDate } from "../dates";
import {
  bookedDays,
  lotWindowVerdict,
  parking24hBlocks,
  validateParkStayWindow,
  type LotWindowFacts,
  type ParkStayWindow,
} from "../parking-window";

const NY = "America/New_York";
// 2026-10-20 12:00 New York (EDT, UTC−4).
const NOON_OCT20 = new Date("2026-10-20T16:00:00Z");

function win(over: Partial<{ night: string; arrivalTime: string; returnDate: string; returnTime: string; now: Date }> = {}): ParkStayWindow {
  const r = validateParkStayWindow({
    night: over.night ?? "2026-11-10",
    arrivalTime: over.arrivalTime ?? "7:00 PM",
    returnDate: over.returnDate ?? "2026-11-14",
    returnTime: over.returnTime ?? "6:00 PM",
    airportTimeZone: NY,
    now: over.now ?? NOON_OCT20,
  });
  if (!r.ok) throw new Error(`unexpected ${r.error.code}`);
  return r.window;
}

const hourlyLot: LotWindowFacts = { hoursBeforeReservation: 0, minimumBookingDays: 0, dailyOrHourly: "hourly", timeZone: NY };

describe("parseTime12Strict (plan v3 §4.1)", () => {
  it.each([
    ["12:00 AM", 0],
    ["12:30 AM", 30],
    ["12:00 PM", 720],
    ["1:05 PM", 785],
    ["11:59 PM", 1439],
    ["07:00 PM", 1140],
  ])("%s → %i", (input, minutes) => {
    expect(parseTime12Strict(input)).toBe(minutes);
  });

  it.each(["13:99 PM", "13:00 PM", "0:30 AM", "12:60 PM", "7:00pm", " 7:00 PM", "7:00  PM", "7 PM", "", "7:0 PM"])("rejects %j", (input) => {
    expect(parseTime12Strict(input)).toBeNull();
  });
});

describe("validateParkStayWindow — required inputs, literal strings, no defaults", () => {
  it("builds ResLab's from/to from the customer's own times; departure = night + 1", () => {
    const w = win();
    expect(w).toMatchObject({
      night: "2026-11-10",
      departureDate: "2026-11-11",
      fromDate: "2026-11-10 19:00:00",
      toDate: "2026-11-14 18:00:00",
      arrivalMinutes: 1140,
      returnMinutes: 1080,
    });
  });

  it("names the field for every refusal", () => {
    const cases: [Parameters<typeof validateParkStayWindow>[0], string, string][] = [
      [{ night: "2026-02-30", arrivalTime: "7:00 PM", returnDate: "2026-11-14", returnTime: "6:00 PM", airportTimeZone: NY, now: NOON_OCT20 }, "night", "night_invalid"],
      [{ night: "2026-10-19", arrivalTime: "7:00 PM", returnDate: "2026-11-14", returnTime: "6:00 PM", airportTimeZone: NY, now: NOON_OCT20 }, "night", "night_past"],
      [{ night: "2026-11-10", arrivalTime: "13:99 PM", returnDate: "2026-11-14", returnTime: "6:00 PM", airportTimeZone: NY, now: NOON_OCT20 }, "arrivalTime", "arrival_invalid"],
      [{ night: "2026-11-10", arrivalTime: "11:00 AM", returnDate: "2026-11-14", returnTime: "6:00 PM", airportTimeZone: NY, now: NOON_OCT20 }, "arrivalTime", "arrival_off_grid"],
      [{ night: "2026-11-10", arrivalTime: "7:15 PM", returnDate: "2026-11-14", returnTime: "6:00 PM", airportTimeZone: NY, now: NOON_OCT20 }, "arrivalTime", "arrival_off_grid"],
      [{ night: "2026-11-10", arrivalTime: "7:00 PM", returnDate: "2026-11-10", returnTime: "6:00 PM", airportTimeZone: NY, now: NOON_OCT20 }, "returnDate", "return_before_departure"],
      [{ night: "2026-11-10", arrivalTime: "7:00 PM", returnDate: "2026-11-14", returnTime: "25:00 PM", airportTimeZone: NY, now: NOON_OCT20 }, "returnTime", "return_time_invalid"],
    ];
    for (const [input, field, code] of cases) {
      const r = validateParkStayWindow(input);
      expect(r.ok).toBe(false);
      if (!r.ok) expect([r.error.field, r.error.code]).toEqual([field, code]);
    }
  });

  it("accepts the arrival grid ends 12:00 PM and 11:30 PM", () => {
    expect(win({ arrivalTime: "12:00 PM" }).fromDate).toBe("2026-11-10 12:00:00");
    expect(win({ arrivalTime: "11:30 PM" }).fromDate).toBe("2026-11-10 23:30:00");
  });

  describe("limits judged in New York at 11:59 PM and 12:01 AM", () => {
    // 2026-10-20 23:59 EDT = 2026-10-21T03:59Z; 2026-10-21 00:01 EDT = 2026-10-21T04:01Z.
    const beforeMidnight = new Date("2026-10-21T03:59:00Z");
    const afterMidnight = new Date("2026-10-21T04:01:00Z");

    it("night: today … today + 100", () => {
      const at = (night: string, now: Date) =>
        validateParkStayWindow({ night, arrivalTime: "7:00 PM", returnDate: shiftIsoDate(night, 3), returnTime: "6:00 PM", airportTimeZone: NY, now });
      // At 11:59 PM on Oct 20, today is Oct 20: +100 = Jan 28.
      expect(at("2027-01-28", beforeMidnight).ok).toBe(true);
      expect(at("2027-01-29", beforeMidnight).ok).toBe(false);
      expect(at("2026-10-20", beforeMidnight).ok).toBe(true);
      // Two minutes later it is Oct 21: Jan 29 opens and Oct 20 is past.
      expect(at("2027-01-29", afterMidnight).ok).toBe(true);
      const past = at("2026-10-20", afterMidnight);
      expect(past.ok === false && past.error.code).toBe("night_past");
    });

    it("returnDate: night + 1 … night + 60, whatever the clock says", () => {
      for (const now of [beforeMidnight, afterMidnight]) {
        const at = (returnDate: string) =>
          validateParkStayWindow({ night: "2026-11-10", arrivalTime: "7:00 PM", returnDate, returnTime: "6:00 PM", airportTimeZone: NY, now });
        expect(at("2026-11-11").ok).toBe(true);
        expect(at("2027-01-09").ok).toBe(true); // Nov 10 + 60
        const far = at("2027-01-10");
        expect(far.ok === false && far.error.code).toBe("return_too_far");
      }
    });
  });
});

describe("24-hour blocks (§4.2)", () => {
  it("Tue 4 PM → Sun 6 PM is 6 blocks; arriving at 7 PM makes it 5", () => {
    // 2026-11-10 is a Tuesday.
    expect(parking24hBlocks(win({ arrivalTime: "4:00 PM", returnDate: "2026-11-15", returnTime: "6:00 PM" }))).toBe(6);
    expect(parking24hBlocks(win({ arrivalTime: "7:00 PM", returnDate: "2026-11-15", returnTime: "6:00 PM" }))).toBe(5);
  });
  it("a daily lot counts calendar days inclusive", () => {
    expect(bookedDays(win({ returnDate: "2026-11-11" }), { dailyOrHourly: "daily" })).toBe(2);
  });
});

describe("lotWindowVerdict — every night, not only tonight (§4.3)", () => {
  it("notice period on a FUTURE night: a 72-hour lot hides a night two days out", () => {
    // Now Oct 20 noon; parking starts Oct 22 7 PM = 55 h away.
    const w = win({ night: "2026-10-22", returnDate: "2026-10-25" });
    expect(lotWindowVerdict(w, { ...hourlyLot, hoursBeforeReservation: 72 }, NY, NOON_OCT20)).toBe("notice_period");
    expect(lotWindowVerdict(w, { ...hourlyLot, hoursBeforeReservation: 48 }, NY, NOON_OCT20)).toBe("ok");
  });

  it("same night: at least 30 minutes ahead even with no notice set", () => {
    const w = win({ night: "2026-10-20", arrivalTime: "12:00 PM", returnDate: "2026-10-22" });
    expect(lotWindowVerdict(w, hourlyLot, NY, NOON_OCT20)).toBe("notice_period");
    const later = win({ night: "2026-10-20", arrivalTime: "12:30 PM", returnDate: "2026-10-22" });
    expect(lotWindowVerdict(later, hourlyLot, NY, NOON_OCT20)).toBe("ok");
  });

  it("judges notice in the LOT's zone; an invalid zone falls back to the airport's", () => {
    // 12:30 PM in New York is 9:30 AM in Los Angeles — a lot in LA time would see 3.5 h of notice.
    const w = win({ night: "2026-10-20", arrivalTime: "12:30 PM", returnDate: "2026-10-22" });
    expect(lotWindowVerdict(w, { ...hourlyLot, hoursBeforeReservation: 2, timeZone: "America/Los_Angeles" }, NY, NOON_OCT20)).toBe("ok");
    expect(lotWindowVerdict(w, { ...hourlyLot, hoursBeforeReservation: 2, timeZone: "Not/AZone" }, NY, NOON_OCT20)).toBe("notice_period");
  });

  it("minimum stay at lots 304 and 323 (minimum_booking_days 2): a one-day trip is hidden", () => {
    const twoDayLot = { ...hourlyLot, minimumBookingDays: 2 };
    // Nov 10 7 PM → Nov 11 6 PM = 23 h = 1 block.
    expect(lotWindowVerdict(win({ returnDate: "2026-11-11", returnTime: "6:00 PM" }), twoDayLot, NY, NOON_OCT20)).toBe("min_stay");
    // Nov 10 7 PM → Nov 11 8 PM = 25 h = 2 blocks.
    expect(lotWindowVerdict(win({ returnDate: "2026-11-11", returnTime: "8:00 PM" }), twoDayLot, NY, NOON_OCT20)).toBe("ok");
    expect(lotWindowVerdict(win({ returnDate: "2026-11-11", returnTime: "6:00 PM" }), hourlyLot, NY, NOON_OCT20)).toBe("ok");
  });
});

describe("DST: the window is measured in literal wall-clock time (review note)", () => {
  // US clocks fall back at 2:00 AM on Sun 1 Nov 2026: Sat 7 PM → Sun 7 PM is 25 real hours.
  // We count WALL-CLOCK hours (24 → 1 block), never instants. If ResLab counts real
  // hours instead, it sees MORE blocks than we do: our minimum-stay pre-filter can only
  // hide a lot ResLab would accept (the safe direction), and the quote — ResLab's own
  // price — is what the customer pays either way.
  it("Sat 31 Oct 7:00 PM → Sun 1 Nov 7:00 PM is one block; 7:30 PM is two", () => {
    const at = (returnTime: string) => win({ night: "2026-10-31", arrivalTime: "7:00 PM", returnDate: "2026-11-01", returnTime });
    expect(parking24hBlocks(at("7:00 PM"))).toBe(1);
    expect(parking24hBlocks(at("7:30 PM"))).toBe(2);
    expect(lotWindowVerdict(at("7:00 PM"), { ...hourlyLot, minimumBookingDays: 2 }, NY, NOON_OCT20)).toBe("min_stay");
  });
});
