import { describe, it, expect } from "vitest";
import { airportPricingTimes, reslabLotPricingWindow, usableCheckinTime } from "../pricing-window";

const NY = "America/New_York";
const NOW = new Date("2026-10-06T17:29:00Z"); // 1:29 PM New York
const base = { checkin: "2026-10-06", checkout: "2026-10-09", airportTimeZone: NY, now: NOW };
const lot = (hours_before_reservation = 0, code?: string) => ({
  hours_before_reservation,
  timezone: code ? { id: 1, name: code, code } : undefined,
});

describe("usableCheckinTime", () => {
  it("drops a supplied same-day time that has passed, keeps everything else", () => {
    expect(usableCheckinTime("9:00 AM", "2026-10-06", NY, NOW)).toBeUndefined();
    expect(usableCheckinTime("6:00 PM", "2026-10-06", NY, NOW)).toBe("6:00 PM");
    expect(usableCheckinTime("9:00 AM", "2026-10-07", NY, NOW)).toBe("9:00 AM");
    expect(usableCheckinTime(undefined, "2026-10-06", NY, NOW)).toBeUndefined();
  });
});

describe("airportPricingTimes", () => {
  it("prices from the earliest open slot when a supplied same-day time has passed (chat's '9 AM' at 1:29 PM)", () => {
    expect(airportPricingTimes({ ...base, checkinTime: "9:00 AM" })).toMatchObject({
      ok: true,
      checkinTime: "2:00 PM",
    });
  });
});

describe("reslabLotPricingWindow", () => {
  it("matches the airport window for an ordinary lot", () => {
    expect(reslabLotPricingWindow(lot(), base)).toEqual({
      fromDate: "2026-10-06 14:00:00",
      toDate: "2026-10-09 14:00:00",
    });
  });

  it("honours the lot's notice period and timezone for a same-day default", () => {
    expect(reslabLotPricingWindow(lot(3), base)?.fromDate).toBe("2026-10-06 16:30:00");
    expect(reslabLotPricingWindow(lot(0, "America/Chicago"), base)?.fromDate).toBe("2026-10-06 13:00:00");
    expect(reslabLotPricingWindow(lot(3, "Not/AZone"), base)?.fromDate).toBe("2026-10-06 16:30:00");
  });

  it("is null when the lot can't take a booking today", () => {
    expect(reslabLotPricingWindow(lot(12), base)).toBeNull();
    expect(reslabLotPricingWindow(lot(0, "Asia/Tokyo"), base)).toBeNull();
    expect(reslabLotPricingWindow(lot(), { ...base, checkin: "2026-10-05" })).toBeNull();
  });

  it("uses a caller's time only if this lot can still take it today", () => {
    // 6 h notice at 1:29 PM → earliest 7:30 PM. 9 PM clears it: used as given.
    expect(reslabLotPricingWindow(lot(6), { ...base, checkinTime: "9:00 PM", checkoutTime: "9:00 AM" })).toEqual({
      fromDate: "2026-10-06 21:00:00",
      toDate: "2026-10-09 09:00:00",
    });
    // 6 PM is inside the notice period: the lot prices from its own earliest slot.
    expect(reslabLotPricingWindow(lot(6), { ...base, checkinTime: "6:00 PM" })?.fromDate).toBe(
      "2026-10-06 19:30:00"
    );
  });

  it("keeps 10:00 AM for a future date regardless of notice", () => {
    expect(reslabLotPricingWindow(lot(12), { ...base, checkin: "2026-10-07" })?.fromDate).toBe(
      "2026-10-07 10:00:00"
    );
  });
});
