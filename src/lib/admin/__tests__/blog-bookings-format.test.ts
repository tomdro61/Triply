import { describe, it, expect } from "vitest";
import { fmtNet } from "../blog-bookings-format";

describe("fmtNet", () => {
  it("is an ellipsis while loading and a dash before net is loaded", () => {
    expect(fmtNet(null, true)).toBe("…");
    expect(fmtNet(null)).toBe("—");
  });
  it("is a dash, not $0, when no booking has a known figure", () => {
    expect(fmtNet({ blogNet: 0, blogNetKnown: 0, blogNetUnknown: 3 })).toBe("—");
  });
  it("is $0 when known figures really sum to zero", () => {
    expect(fmtNet({ blogNet: 0, blogNetKnown: 2, blogNetUnknown: 0 })).toBe("$0");
  });
  it("formats known sums as whole dollars", () => {
    expect(fmtNet({ blogNet: 1234.4, blogNetKnown: 5, blogNetUnknown: 1 })).toBe("$1,234");
  });
});
