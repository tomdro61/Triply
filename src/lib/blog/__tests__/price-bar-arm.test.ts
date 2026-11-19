import { describe, it, expect } from "vitest";
import { priceBarArm } from "../price-bar-arm";

describe("priceBarArm", () => {
  it("splits by post id parity", () => {
    expect(priceBarArm(4166)).toBe("price");
    expect(priceBarArm(4167)).toBe("control");
    expect(priceBarArm("3051")).toBe("control");
    expect(priceBarArm("3056")).toBe("price");
  });

  it("falls back to control for a missing or odd id", () => {
    expect(priceBarArm(undefined)).toBe("control");
    expect(priceBarArm(null)).toBe("control");
    expect(priceBarArm("abc")).toBe("control");
    expect(priceBarArm(12.5)).toBe("control");
  });

  it("gives exactly half of ids 1-1000 prices", () => {
    let price = 0;
    for (let id = 1; id <= 1000; id++) if (priceBarArm(id) === "price") price++;
    expect(price).toBe(500);
  });
});
