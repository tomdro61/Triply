import { describe, it, expect } from "vitest";
import { fmtNet, netGapParts, netShortfallText, partialNetNotice } from "../blog-bookings-format";

describe("fmtNet", () => {
  it("is an ellipsis while loading and a dash before net is loaded", () => {
    expect(fmtNet(null, true)).toBe("…");
    expect(fmtNet(null)).toBe("—");
  });
  it("is an ellipsis while loading even over figures from an earlier load", () => {
    expect(fmtNet({ blogNet: 1234, blogNetKnown: 5, blogNetUnknown: 0 }, true)).toBe("…");
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

describe("net take wording", () => {
  it("does not blame ResLab when no read failed", () => {
    const text = netShortfallText({ bookings: 10, known: 4, fetchErrors: 0, skipped: 0 });
    expect(text).toBe(
      "net take has a figure for only 4 of 10 blog bookings: 6 bookings without a figure for another reason (disputed and direct-lot bookings have none)"
    );
    expect(text).not.toMatch(/ResLab/);
  });
  it("separates failed reads, reads skipped for time, and the rest", () => {
    expect(netGapParts({ bookings: 10, known: 4, fetchErrors: 3, skipped: 2 })).toEqual([
      "1 ResLab read failed",
      "2 bookings not read before the time limit",
      "3 bookings without a figure for another reason (disputed and direct-lot bookings have none)",
    ]);
  });
  it("is empty when every booking has a figure", () => {
    expect(netGapParts({ bookings: 3, known: 3, fetchErrors: 0, skipped: 0 })).toEqual([]);
  });
});

describe("partialNetNotice", () => {
  const partial = { bookings: 10, known: 8, fetchErrors: 2, skipped: 0 };
  it("describes a partial result", () => {
    expect(partialNetNotice(partial, false)).toBe(
      "Net take is partial: it covers 8 of 10 blog bookings (2 ResLab reads failed)."
    );
  });
  it("is hidden while a reload is in flight (the cells show … then)", () => {
    expect(partialNetNotice(partial, true)).toBeNull();
  });
  it("is null with no failed read, or nothing loaded", () => {
    expect(partialNetNotice({ ...partial, fetchErrors: 0 }, false)).toBeNull();
    expect(partialNetNotice(null, false)).toBeNull();
  });
});
