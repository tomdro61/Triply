import { describe, it, expect } from "vitest";
import { isKnownEmpty, emptyMetaDescription } from "../content";

describe("known-empty airport page", () => {
  it("is empty when a successful search returns no lots", () => {
    expect(isKnownEmpty(0, 0)).toBe(true); // we list nothing here
    expect(isKnownEmpty(0, 2)).toBe(true); // we list lots, none bookable
  });

  it("is not empty when anything is bookable", () => {
    expect(isKnownEmpty(1, 1)).toBe(false);
    expect(isKnownEmpty(5, 9)).toBe(false);
  });

  it("claims nothing when the count is unknown", () => {
    expect(isKnownEmpty(0, null)).toBe(false);
  });

  it("writes a meta with no price, lot count or booking promise", () => {
    const d = emptyMetaDescription("Salt Lake City International Airport", "SLC");
    expect(d).toContain("SLC");
    expect(d).toContain("Salt Lake City International Airport");
    expect(d).not.toMatch(/\$|\d+\+|compare|book now|\/day/i);
  });
});
