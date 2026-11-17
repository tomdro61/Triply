import { describe, expect, it } from "vitest";
import { CONVERTED_DRIFT_FIELDS, DIRECT_DRIFT_FIELDS, pricedDifferently } from "../price-drift";

const page = { subtotal: 71.05, feesTotal: 3.63, taxTotal: 9.43, serviceFee: 5.95, dueAtLocation: 0, grandTotal: 76.86 };

describe("pricedDifferently", () => {
  it("equal figures are not a difference, whatever float noise they carry", () => {
    expect(pricedDifferently(page, { ...page }, CONVERTED_DRIFT_FIELDS)).toBe(false);
    expect(pricedDifferently({ subtotal: 0.1 + 0.2 }, { subtotal: 0.3 }, ["subtotal"])).toBe(false);
  });

  it.each(CONVERTED_DRIFT_FIELDS)("one cent off in %s is a difference", (field) => {
    expect(pricedDifferently(page, { ...page, [field]: page[field] + 0.01 }, CONVERTED_DRIFT_FIELDS)).toBe(true);
    expect(pricedDifferently(page, { ...page, [field]: page[field] - 0.01 }, CONVERTED_DRIFT_FIELDS)).toBe(true);
  });

  it("a changed long-stay discount moves only the total, and is caught by it", () => {
    // CAD 100 with a 10 discount at 0.725: the parts the response lists are
    // unchanged when ResLab drops the discount; only the total moves.
    const withDiscount = { subtotal: 72.5, feesTotal: 0, taxTotal: 0, serviceFee: 5.95, dueAtLocation: 0, grandTotal: 65.25 };
    const without = { ...withDiscount, grandTotal: 72.5 };
    expect(pricedDifferently(withDiscount, without, CONVERTED_DRIFT_FIELDS)).toBe(true);
    // The parts alone would have let it through.
    expect(pricedDifferently(withDiscount, without, ["subtotal", "feesTotal", "taxTotal", "serviceFee", "dueAtLocation"])).toBe(false);
  });

  it("fails closed: a figure missing or not a number on either side, or on both, is a difference", () => {
    expect(pricedDifferently(page, { ...page, grandTotal: undefined }, CONVERTED_DRIFT_FIELDS)).toBe(true);
    expect(pricedDifferently({ ...page, taxTotal: undefined }, page, CONVERTED_DRIFT_FIELDS)).toBe(true);
    expect(pricedDifferently({ subtotal: undefined }, { subtotal: undefined }, ["subtotal"])).toBe(true);
    expect(pricedDifferently({ subtotal: "71.05" }, { subtotal: 71.05 }, ["subtotal"])).toBe(true);
    expect(pricedDifferently({ subtotal: Number.NaN }, { subtotal: Number.NaN }, ["subtotal"])).toBe(true);
    expect(pricedDifferently({ subtotal: Infinity }, { subtotal: Infinity }, ["subtotal"])).toBe(true);
  });

  it("only the listed fields are compared (a direct lot's at-lot figures are not)", () => {
    const atLotMoved = { ...page, dueAtLocation: 40, feesTotal: 9 };
    const taxMoved = { ...page, taxTotal: 9.44 };
    expect(pricedDifferently(page, atLotMoved, DIRECT_DRIFT_FIELDS)).toBe(false);
    expect(pricedDifferently(page, taxMoved, DIRECT_DRIFT_FIELDS)).toBe(true);
  });
});
