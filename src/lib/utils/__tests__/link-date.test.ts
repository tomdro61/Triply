import { describe, it, expect } from "vitest";
import { linkDate } from "../link-date";

describe("linkDate", () => {
  it("a plain date → itself", () => {
    expect(linkDate("2026-12-05")).toBe("2026-12-05");
  });

  it("a date and time (TRIPLY-2D's link) → the date part", () => {
    expect(linkDate("2026-12-05T18:00")).toBe("2026-12-05");
    expect(linkDate("2026-12-14T02:00:00")).toBe("2026-12-14");
    expect(linkDate("2026-12-14T02:00:00.000Z")).toBe("2026-12-14");
    expect(linkDate("2026-12-14T02:00:00-05:00")).toBe("2026-12-14");
    expect(linkDate("2026-12-14 02:00")).toBe("2026-12-14");
  });

  it("not a real day → undefined", () => {
    expect(linkDate("2026-02-30")).toBeUndefined();
    expect(linkDate("2026-13-01")).toBeUndefined();
    expect(linkDate("2026-02-30T10:00")).toBeUndefined();
  });

  it("anything else → undefined, like a link without a date", () => {
    expect(linkDate(undefined)).toBeUndefined();
    expect(linkDate("")).toBeUndefined();
    expect(linkDate("tomorrow")).toBeUndefined();
    expect(linkDate("12/05/2026")).toBeUndefined();
    expect(linkDate("2026-12-05Tgarbage")).toBeUndefined();
    expect(linkDate("2026-12-5")).toBeUndefined();
  });
});
