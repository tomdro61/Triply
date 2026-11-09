import { describe, it, expect } from "vitest";
import { freeCancelText, freeCancelWindow } from "../free-cancel-window";

// 2026-11-06 14:00 in New York (EST, UTC-5) = 19:00Z.
const NOW = new Date("2026-11-06T19:00:00Z");
const NY = "America/New_York";

describe("freeCancelWindow", () => {
  it("three weeks out: open, with the dated cutoff (day before, same time)", () => {
    const w = freeCancelWindow("2026-11-20", "10:00 AM", NY, NOW);
    expect(w).toEqual({ kind: "open", until: "Thu, Nov 19, 10:00 AM" });
    expect(freeCancelText(w)).toBe("Free cancellation until Thu, Nov 19, 10:00 AM");
  });

  it("the live repro: check-in tomorrow 9 AM, now 2 PM → the cutoff (today 9 AM) has passed", () => {
    const w = freeCancelWindow("2026-11-07", "9:00 AM", NY, NOW);
    expect(w).toEqual({ kind: "closed" });
    expect(freeCancelText(w)).toBe("Not cancellable online (check-in is under 24 hours away)");
  });

  it("check-in tomorrow 6 PM, now 2 PM → still open until today 6 PM", () => {
    expect(freeCancelWindow("2026-11-07", "6:00 PM", NY, NOW)).toEqual({ kind: "open", until: "Fri, Nov 6, 6:00 PM" });
  });

  it("the cutoff minute itself is closed", () => {
    expect(freeCancelWindow("2026-11-07", "2:00 PM", NY, NOW)).toEqual({ kind: "closed" });
  });

  it("uses the airport's clock, not the device's: 2 PM in NY is 11 AM in LA", () => {
    expect(freeCancelWindow("2026-11-07", "12:00 PM", "America/Los_Angeles", NOW)).toEqual({
      kind: "open",
      until: "Fri, Nov 6, 12:00 PM",
    });
  });

  it("same-day check-in is closed even before a time is picked", () => {
    expect(freeCancelWindow("2026-11-06", "", NY, NOW)).toEqual({ kind: "closed" });
    expect(freeCancelWindow("2026-11-06", undefined, NY, NOW)).toEqual({ kind: "closed" });
  });

  it("no time picked: closed only once the day's last slot (11:30 PM) is inside 24 h", () => {
    // Check-in Nov 7; last slot 11:30 PM Nov 7 ET = Nov 8 04:30Z; cutoff Nov 7 04:30Z.
    expect(freeCancelWindow("2026-11-07", "", NY, new Date("2026-11-07T04:29:00Z"))).toEqual({ kind: "open", until: null });
    expect(freeCancelWindow("2026-11-07", "", NY, new Date("2026-11-07T04:30:00Z"))).toEqual({ kind: "closed" });
  });

  it("no time picked yet and more than a day out: the generic line", () => {
    const w = freeCancelWindow("2026-11-20", "", NY, NOW);
    expect(w).toEqual({ kind: "open", until: null });
    expect(freeCancelText(w)).toBe("Free cancellation up to 24h before check-in");
  });

  it("month and year boundaries", () => {
    expect(freeCancelWindow("2026-12-01", "8:30 AM", NY, NOW)).toEqual({ kind: "open", until: "Mon, Nov 30, 8:30 AM" });
    expect(freeCancelWindow("2027-01-01", "12:00 AM", NY, NOW)).toEqual({ kind: "open", until: "Thu, Dec 31, 12:00 AM" });
  });

  it("no zone: claims neither open nor closed, states only the rule", () => {
    const w = freeCancelWindow("2026-11-07", "9:00 AM", undefined, NOW);
    expect(w).toEqual({ kind: "unknown" });
    expect(freeCancelText(w)).toBe("Online cancellation closes 24 hours before check-in");
    expect(freeCancelWindow("2026-11-07", "9:00 AM", "Not/AZone", NOW)).toEqual({ kind: "unknown" });
  });

  it("no clock (server render): never claims closed, still shows the cutoff", () => {
    expect(freeCancelWindow("2026-11-07", "9:00 AM", NY, null)).toEqual({ kind: "open", until: "Fri, Nov 6, 9:00 AM" });
  });

  it("daylight saving: 24 real hours, like the server gate, not 'same time the day before'", () => {
    // US clocks fall back at 2 AM on Sun Nov 1, 2026. Check-in Sun 10:00 AM EST is
    // 15:00Z; 24 h earlier is Sat 15:00Z = 11:00 AM EDT.
    const before = new Date("2026-10-25T12:00:00Z");
    expect(freeCancelWindow("2026-11-01", "10:00 AM", NY, before)).toEqual({ kind: "open", until: "Sat, Oct 31, 11:00 AM" });
    // And the gate flips at that instant, not an hour later.
    expect(freeCancelWindow("2026-11-01", "10:00 AM", NY, new Date("2026-10-31T15:00:00Z"))).toEqual({ kind: "closed" });
    expect(freeCancelWindow("2026-11-01", "10:00 AM", NY, new Date("2026-10-31T14:59:00Z")).kind).toBe("open");
  });

  it("bad input degrades to the generic line", () => {
    expect(freeCancelWindow("", "9:00 AM", NY, NOW)).toEqual({ kind: "unknown" });
    expect(freeCancelWindow("11/20/2026", "9:00 AM", NY, NOW)).toEqual({ kind: "unknown" });
    expect(freeCancelWindow("2026-11-20", "25:00 PM", NY, NOW)).toEqual({ kind: "open", until: null });
  });
});
