import { describe, it, expect } from "vitest";
import { calendarDayIn, shiftIsoDate, zonedMidnightUtc, windowForEtDay, yesterdayEt, trailingWindow, DIGEST_TZ } from "../window";

describe("ET calendar window (plan v2 §1)", () => {
  it("ET midnight is 04:00 UTC in summer and 05:00 UTC in winter", () => {
    expect(zonedMidnightUtc("2026-09-27", DIGEST_TZ).toISOString()).toBe("2026-09-27T04:00:00.000Z");
    expect(zonedMidnightUtc("2026-01-15", DIGEST_TZ).toISOString()).toBe("2026-01-15T05:00:00.000Z");
  });

  it("DST days: spring-forward and fall-back windows are 23 h and 25 h, boundaries exact", () => {
    const spring = windowForEtDay("2026-03-08"); // US spring forward
    expect((spring.endUtc.getTime() - spring.startUtc.getTime()) / 3_600_000).toBe(23);
    const fall = windowForEtDay("2026-11-01"); // US fall back
    expect((fall.endUtc.getTime() - fall.startUtc.getTime()) / 3_600_000).toBe(25);
    expect(fall.startUtc.toISOString()).toBe("2026-11-01T04:00:00.000Z");
    expect(fall.endUtc.toISOString()).toBe("2026-11-02T05:00:00.000Z");
  });

  it("23:59 ET and 00:01 ET land in different digests", () => {
    const w = windowForEtDay("2026-09-27");
    const lateSept27 = new Date("2026-09-28T03:59:00Z"); // 23:59 ET Sept 27
    const earlySept28 = new Date("2026-09-28T04:01:00Z"); // 00:01 ET Sept 28
    expect(lateSept27 >= w.startUtc && lateSept27 < w.endUtc).toBe(true);
    expect(earlySept28 >= w.startUtc && earlySept28 < w.endUtc).toBe(false);
  });

  it("yesterdayEt is the ET day before the run, even when UTC has rolled over", () => {
    // 13:05 UTC on Sept 28 = 09:05 ET Sept 28 → yesterday is Sept 27.
    expect(yesterdayEt(new Date("2026-09-28T13:05:00Z"))).toBe("2026-09-27");
    // 02:00 UTC on Sept 28 is still 22:00 ET Sept 27 → yesterday is Sept 26.
    expect(yesterdayEt(new Date("2026-09-28T02:00:00Z"))).toBe("2026-09-26");
  });

  it("trailing windows end at the digest day's start (exclusive)", () => {
    const t = trailingWindow("2026-09-27", 7);
    expect(t.firstDay).toBe("2026-09-20");
    expect(t.endUtc.toISOString()).toBe(windowForEtDay("2026-09-27").startUtc.toISOString());
  });

  it("shiftIsoDate and calendarDayIn are pure calendar helpers", () => {
    expect(shiftIsoDate("2026-03-01", -1)).toBe("2026-02-28");
    expect(shiftIsoDate("2026-12-31", 1)).toBe("2027-01-01");
    expect(calendarDayIn("America/New_York", new Date("2026-09-28T03:30:00Z"))).toBe("2026-09-27");
  });

  it("the footer label names the ET day", () => {
    expect(windowForEtDay("2026-09-27").label).toBe("Sept 27, 2026 · 00:00–24:00 ET");
  });
});
