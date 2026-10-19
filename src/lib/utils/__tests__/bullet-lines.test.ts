import { describe, it, expect } from "vitest";
import { bulletLines } from "../bullet-lines";

describe("bulletLines", () => {
  it("every line a bullet → the items, markers stripped; blank lines (joined sections) ignored", () => {
    expect(bulletLines("- Standard cars pay nothing extra.\n• Lot staff: 347\r\n\n- Show your confirmation.")).toEqual([
      "Standard cars pay nothing extra.",
      "Lot staff: 347",
      "Show your confirmation.",
    ]);
  });

  it("free text (ResLab conditions) → null, rendered as a paragraph as before", () => {
    expect(bulletLines("Oversized vehicles pay extra. Call ahead.")).toBeNull();
    expect(bulletLines("- one bullet\nthen a plain line")).toBeNull();
    expect(bulletLines("Price -$5 off")).toBeNull();
  });

  it("empty → null", () => {
    expect(bulletLines(null)).toBeNull();
    expect(bulletLines("")).toBeNull();
    expect(bulletLines("\n \n")).toBeNull();
  });
});
