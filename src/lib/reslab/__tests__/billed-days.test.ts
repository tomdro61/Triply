import { describe, it, expect } from "vitest";
import { billedParkingDays } from "../billed-days";

const line = (number_of_days: unknown, extra: Record<string, unknown> = {}) => ({ number_of_days, ...extra });

describe("billedParkingDays", () => {
  it("RTL869257: a stay split over three rate periods is 3 + 1 + 1 = 5 days, not the first line's 3", () => {
    expect(
      billedParkingDays({
        from_date: "2026-10-22 06:00:00",
        to_date: "2026-10-26 23:30:00",
        parking_rates: [
          line(3, { from_date: "2026-10-22 00:00:00", to_date: "2026-10-24 00:00:00", price_of_one_unit: 7.95 }),
          line(1, { from_date: "2026-10-25 00:00:00", to_date: "2026-10-25 00:00:00", price_of_one_unit: 6.95 }),
          line(1, { from_date: "2026-10-26 00:00:00", to_date: "2026-10-26 00:00:00", price_of_one_unit: 5.95 }),
        ],
      })
    ).toBe(5);
  });

  it("one rate line → its count", () => {
    expect(billedParkingDays({ parking_rates: [line(3)] })).toBe(3);
  });

  it("any line without a positive whole day count (hourly, missing, 0, fractional, string) → null, never a partial sum", () => {
    for (const bad of [null, undefined, 0, 1.5, "2", -1]) {
      expect(billedParkingDays({ parking_rates: [line(3), line(bad)] })).toBeNull();
    }
  });

  it("no rate lines → the block's own count, else null", () => {
    expect(billedParkingDays({ number_of_days: 4 })).toBe(4);
    expect(billedParkingDays({ parking_rates: [], number_of_days: 4 })).toBe(4);
    expect(billedParkingDays({ parking_rates: [] })).toBeNull();
  });

  it("unreadable input → null", () => {
    for (const bad of [undefined, null, "x", 3, [], { parking_rates: "nope" }, { parking_rates: [null] }]) {
      expect(billedParkingDays(bad)).toBeNull();
    }
  });
});
