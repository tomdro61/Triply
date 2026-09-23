import { describe, it, expect } from "vitest";
import { differenceInCalendarDays, parseISO } from "date-fns";
import {
  getFallbackDateBounds,
  nextReturnDateAfterDepartChange,
} from "../date-range-field-error-boundary";
import { MAX_ADVANCE_BOOKING_DAYS } from "@/lib/booking-window";

// Pure-logic tests only: this repo's vitest config runs in a `node`
// environment with no React Testing Library / jsdom set up (see
// vitest.config.ts — `include` is `*.test.ts`, not `*.tsx`), so the boundary
// component itself isn't rendered here. These cover the two behaviors the
// pass-3 review flagged as missing: the fallback `<input type="date">`
// bounds, and clearing a return date that's been made invalid.

describe("getFallbackDateBounds", () => {
  it("spans exactly MAX_ADVANCE_BOOKING_DAYS from min to max", () => {
    const { min, max } = getFallbackDateBounds();
    expect(differenceInCalendarDays(parseISO(max), parseISO(min))).toBe(
      MAX_ADVANCE_BOOKING_DAYS
    );
  });

  it("min is today, formatted yyyy-MM-dd", () => {
    const { min } = getFallbackDateBounds();
    expect(min).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(differenceInCalendarDays(parseISO(min), new Date())).toBe(0);
  });
});

describe("nextReturnDateAfterDepartChange", () => {
  it("clears the return date when it now precedes the new depart date", () => {
    expect(nextReturnDateAfterDepartChange("2026-10-15", "2026-10-10")).toBe("");
  });

  it("keeps the return date when it's still after the new depart date", () => {
    expect(nextReturnDateAfterDepartChange("2026-10-05", "2026-10-10")).toBe(
      "2026-10-10"
    );
  });

  it("keeps an empty return date empty", () => {
    expect(nextReturnDateAfterDepartChange("2026-10-05", "")).toBe("");
  });

  it("keeps the return date when depart is cleared", () => {
    expect(nextReturnDateAfterDepartChange("", "2026-10-10")).toBe("2026-10-10");
  });

  it("keeps a return date equal to the new depart date (same-day is not reversed)", () => {
    expect(nextReturnDateAfterDepartChange("2026-10-10", "2026-10-10")).toBe(
      "2026-10-10"
    );
  });
});
