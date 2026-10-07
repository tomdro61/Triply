import { describe, it, expect } from "vitest";
import {
  stillBookableCheckinTime,
  bookableCheckinTimes,
  earliestSameDaySlot,
  minutesTo12Hour,
  resolvePricingTimes,
  time12ToMinutes,
  zonedWallClock,
} from "../time";

const NY = "America/New_York";
const LA = "America/Los_Angeles";
// 2026-10-06 is EDT (UTC-4): 17:29Z is 1:29 PM in New York.
const at = (iso: string) => new Date(iso);

function sameDay(nowIso: string, extra: Partial<Parameters<typeof resolvePricingTimes>[0]> = {}) {
  return resolvePricingTimes({
    checkinDate: "2026-10-06",
    checkoutDate: "2026-10-09",
    timeZone: NY,
    now: at(nowIso),
    ...extra,
  });
}

describe("minutesTo12Hour / time12ToMinutes", () => {
  it("round-trips the picker's slots", () => {
    expect(minutesTo12Hour(0)).toBe("12:00 AM");
    expect(minutesTo12Hour(30)).toBe("12:30 AM");
    expect(minutesTo12Hour(600)).toBe("10:00 AM");
    expect(minutesTo12Hour(720)).toBe("12:00 PM");
    expect(minutesTo12Hour(1410)).toBe("11:30 PM");
    expect(time12ToMinutes("2:30 PM")).toBe(870);
    expect(time12ToMinutes("12:00 AM")).toBe(0);
  });

  it("returns NaN for free text (chat-supplied times)", () => {
    expect(time12ToMinutes("10am")).toBeNaN();
    expect(time12ToMinutes("14:00")).toBeNaN();
  });
});

describe("zonedWallClock", () => {
  it("reads the zone's date and time, not the server's", () => {
    // 00:30Z on Oct 7 is still Oct 6 at 8:30 PM in New York.
    expect(zonedWallClock(NY, at("2026-10-07T00:30:00Z"))).toEqual({
      date: "2026-10-06",
      secondsOfDay: 20 * 3600 + 30 * 60,
    });
  });

  it("renders midnight as hour 0, never 24", () => {
    expect(zonedWallClock(NY, at("2026-10-06T04:00:00Z")).secondsOfDay).toBe(0);
  });
});

describe("earliestSameDaySlot", () => {
  it("rounds now + 30 min up to the next :00/:30, counting seconds", () => {
    expect(earliestSameDaySlot(13 * 3600 + 29 * 60)).toBe(14 * 60);
    // 13:30:59 + 30 min = 14:00:59 — must not round down to a 29-minute lead.
    expect(earliestSameDaySlot(13 * 3600 + 30 * 60 + 59)).toBe(14 * 60 + 30);
    expect(earliestSameDaySlot(21 * 3600)).toBe(21 * 60 + 30);
  });

  it("is null once no slot is left today (no wrap past midnight)", () => {
    expect(earliestSameDaySlot(22 * 3600 + 59 * 60)).toBe(23 * 60 + 30);
    expect(earliestSameDaySlot(23 * 3600 + 1)).toBeNull();
    expect(earliestSameDaySlot(23 * 3600 + 45 * 60)).toBeNull();
  });
});

describe("resolvePricingTimes", () => {
  it("keeps 10:00 AM / 2:00 PM for any future check-in date", () => {
    expect(
      resolvePricingTimes({
        checkinDate: "2026-10-07",
        checkoutDate: "2026-10-10",
        timeZone: NY,
        now: at("2026-10-06T17:29:00Z"),
      })
    ).toEqual({ ok: true, checkinTime: "10:00 AM", checkoutTime: "2:00 PM", sameDay: false });
  });

  it("prices a same-day check-in at the earliest open slot, not 10:00 AM", () => {
    // 1:29 PM → 2:00 PM (the bug: 10:00 AM was already past, ResLab 422'd).
    expect(sameDay("2026-10-06T17:29:00Z")).toEqual({
      ok: true,
      checkinTime: "2:00 PM",
      checkoutTime: "2:00 PM",
      sameDay: true,
    });
    // 8:10 AM → 9:00 AM: a same-day morning search no longer waits for 10.
    expect(sameDay("2026-10-06T12:10:00Z")).toMatchObject({ checkinTime: "9:00 AM" });
    // 12:00 AM → 12:30 AM
    expect(sameDay("2026-10-06T04:00:00Z")).toMatchObject({ checkinTime: "12:30 AM" });
  });

  it("judges 'today' in the airport's timezone, not UTC", () => {
    // 00:30Z Oct 7: already Oct 7 in UTC, but 8:30 PM Oct 6 in New York and
    // 5:30 PM Oct 6 in Los Angeles — both same-day for an Oct 6 check-in.
    const now = at("2026-10-07T00:30:00Z");
    expect(sameDay(now.toISOString())).toMatchObject({ checkinTime: "9:00 PM", sameDay: true });
    expect(sameDay(now.toISOString(), { timeZone: LA })).toMatchObject({ checkinTime: "6:00 PM" });
    expect(
      resolvePricingTimes({ checkinDate: "2026-10-07", checkoutDate: "2026-10-09", timeZone: NY, now })
    ).toMatchObject({ checkinTime: "10:00 AM", sameDay: false });
  });

  it("works across the DST change (Nov 1 2026, 1:30 AM EST after fall-back)", () => {
    expect(
      resolvePricingTimes({
        checkinDate: "2026-11-01",
        checkoutDate: "2026-11-03",
        timeZone: NY,
        now: at("2026-11-01T06:30:00Z"),
      })
    ).toMatchObject({ checkinTime: "2:00 AM", sameDay: true });
  });

  it("applies a longer lead (a lot's notice period)", () => {
    // 1:29 PM + 3 h = 4:29 PM → 4:30 PM
    expect(sameDay("2026-10-06T17:29:00Z", { leadMinutes: 180 })).toMatchObject({
      checkinTime: "4:30 PM",
    });
    // 9:00 PM + 3 h crosses midnight → nothing today
    expect(sameDay("2026-10-07T01:00:00Z", { leadMinutes: 180 })).toEqual({
      ok: false,
      reason: "same_day_too_late",
    });
  });

  it("reports too late instead of clamping to a past time", () => {
    // 10:59 PM → 11:30 PM is still open
    expect(sameDay("2026-10-07T02:59:00Z")).toMatchObject({ checkinTime: "11:30 PM" });
    // 11:20 PM and 11:45 PM: no slot left today
    expect(sameDay("2026-10-07T03:20:00Z")).toEqual({ ok: false, reason: "same_day_too_late" });
    expect(sameDay("2026-10-07T03:45:00Z")).toEqual({ ok: false, reason: "same_day_too_late" });
  });

  it("rejects a check-in date already past at the airport", () => {
    expect(
      resolvePricingTimes({
        checkinDate: "2026-10-05",
        checkoutDate: "2026-10-08",
        timeZone: NY,
        now: at("2026-10-06T17:29:00Z"),
      })
    ).toEqual({ ok: false, reason: "checkin_in_past" });
  });

  it("puts a same-date return after the check-in", () => {
    // 3:10 PM → check-in 4:00 PM; 2:00 PM would be before it → 5:00 PM.
    expect(
      sameDay("2026-10-06T19:10:00Z", { checkoutDate: "2026-10-06" })
    ).toMatchObject({ checkinTime: "4:00 PM", checkoutTime: "5:00 PM" });
    // Morning same-date stay keeps 2:00 PM.
    expect(
      sameDay("2026-10-06T12:10:00Z", { checkoutDate: "2026-10-06" })
    ).toMatchObject({ checkinTime: "9:00 AM", checkoutTime: "2:00 PM" });
    // 10:40 PM → check-in 11:30 PM, return would cross midnight → too late.
    expect(sameDay("2026-10-07T02:40:00Z", { checkoutDate: "2026-10-06" })).toEqual({
      ok: false,
      reason: "same_day_too_late",
    });
  });

  it("never rewrites times the caller supplied", () => {
    expect(
      sameDay("2026-10-06T19:00:00Z", { checkinTime: "10:00 AM", checkoutTime: "9:00 AM" })
    ).toEqual({ ok: true, checkinTime: "10:00 AM", checkoutTime: "9:00 AM", sameDay: true });
  });
});

describe("bookableCheckinTimes", () => {
  const options = Array.from({ length: 48 }, (_, i) => minutesTo12Hour(i * 30));

  it("offers every slot for a future date or with no timezone", () => {
    const now = at("2026-10-06T17:29:00Z");
    expect(bookableCheckinTimes(options, "2026-10-07", NY, 0, now)).toHaveLength(48);
    expect(bookableCheckinTimes(options, "2026-10-06", undefined, 0, now)).toHaveLength(48);
  });

  it("hides today's past and too-soon slots", () => {
    const today = bookableCheckinTimes(options, "2026-10-06", NY, 0, at("2026-10-06T17:29:00Z"));
    expect(today[0]).toBe("2:00 PM");
    expect(today.at(-1)).toBe("11:30 PM");
    expect(today).not.toContain("10:00 AM");
  });

  it("respects the lot's notice period", () => {
    const today = bookableCheckinTimes(options, "2026-10-06", NY, 2, at("2026-10-06T17:29:00Z"));
    expect(today[0]).toBe("3:30 PM");
  });

  it("is empty when nothing is left today", () => {
    expect(bookableCheckinTimes(options, "2026-10-06", NY, 0, at("2026-10-07T03:20:00Z"))).toEqual([]);
  });
});

describe("stillBookableCheckinTime (Reserve gating)", () => {
  const options = Array.from({ length: 48 }, (_, i) => minutesTo12Hour(i * 30));
  const now = at("2026-10-06T17:29:00Z"); // 1:29 PM New York

  it("blanks a pre-filled time that has already passed today, so Reserve stays off", () => {
    expect(stillBookableCheckinTime("10:00 AM", options, "2026-10-06", NY, 0, now)).toBe("");
  });

  it("keeps the same time for a future date — never substitutes another", () => {
    expect(stillBookableCheckinTime("10:00 AM", options, "2026-10-07", NY, 0, now)).toBe("10:00 AM");
  });

  it("drops a slot that was open when picked but has since passed (tab left open)", () => {
    expect(stillBookableCheckinTime("2:00 PM", options, "2026-10-06", NY, 0, now)).toBe("2:00 PM");
    const later = at("2026-10-06T18:45:00Z"); // 2:45 PM
    expect(stillBookableCheckinTime("2:00 PM", options, "2026-10-06", NY, 0, later)).toBe("");
  });

  it("stays empty when nothing was picked", () => {
    expect(stillBookableCheckinTime("", options, "2026-10-07", NY, 0, now)).toBe("");
  });
});
