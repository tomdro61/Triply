import { describe, expect, it } from "vitest";
import { parseTime12Strict } from "@/lib/utils/time";
import { isArrivalSlot } from "@/lib/hotels/parking-window";
import { ARRIVAL_TIME_OPTIONS, RETURN_TIME_OPTIONS, formatIsoDay, formatReslabDateTime } from "../format";

describe("the form's time options agree with the server's strict rules (review T3)", () => {
  it("arrival: 24 slots, 12:00 PM … 11:30 PM, every one strict-parses and is an arrival slot", () => {
    expect(ARRIVAL_TIME_OPTIONS).toHaveLength(24);
    expect(ARRIVAL_TIME_OPTIONS[0]).toBe("12:00 PM");
    expect(ARRIVAL_TIME_OPTIONS[ARRIVAL_TIME_OPTIONS.length - 1]).toBe("11:30 PM");
    for (const t of ARRIVAL_TIME_OPTIONS) {
      const m = parseTime12Strict(t);
      expect(m, t).not.toBeNull();
      expect(isArrivalSlot(m ?? -1), t).toBe(true);
    }
  });

  it("return: 48 slots, 12:00 AM … 11:30 PM, every one strict-parses", () => {
    expect(RETURN_TIME_OPTIONS).toHaveLength(48);
    expect(RETURN_TIME_OPTIONS[0]).toBe("12:00 AM");
    expect(RETURN_TIME_OPTIONS[47]).toBe("11:30 PM");
    for (const t of RETURN_TIME_OPTIONS) expect(parseTime12Strict(t), t).not.toBeNull();
  });
});

describe("display formatting of literal dates", () => {
  it("names the weekday by calendar math, not by parsing an instant", () => {
    expect(formatIsoDay("2026-11-15")).toBe("Sun 15 Nov");
    expect(formatReslabDateTime("2026-11-10 19:00:00")).toBe("Tue 10 Nov, 7:00 PM");
  });
});
