import { describe, it, expect } from "vitest";
import { computeCancellationRefund } from "../refund-math";
import { PROTECTION_PLANS } from "@/lib/parkguard/client";

const A = PROTECTION_PLANS.A; // $12.99 retail / $6 wholesale
const B = PROTECTION_PLANS.B; // $7.99 / $4
const C = PROTECTION_PLANS.C; // $4.95 / $2

describe("computeCancellationRefund", () => {
  it("no Park Guard → 100% refund (service fee included)", () => {
    expect(
      computeCancellationRefund({
        amountReceivedCents: 6601, // $66.01
        protectionPlan: null,
        protectionPlanPriceDollars: null,
        protectionPlanWholesaleDollars: null,
      }),
    ).toEqual({ refundCents: 6601, pgWholesaleCents: 0 });
  });

  it("Plan A → withholds exactly the row's $6 wholesale", () => {
    const r = computeCancellationRefund({
      amountReceivedCents: 7900, // $79.00 incl. the $12.99 premium
      protectionPlan: A.name,
      protectionPlanPriceDollars: A.price,
      protectionPlanWholesaleDollars: A.wholesalePrice,
    });
    expect(r.pgWholesaleCents).toBe(600);
    expect(r.refundCents).toBe(7300);
  });

  it("Plan B → withholds the row's $4, not Plan A's $6", () => {
    const r = computeCancellationRefund({
      amountReceivedCents: 7400,
      protectionPlan: B.name,
      protectionPlanPriceDollars: "7.99", // decimal column → string
      protectionPlanWholesaleDollars: "4.00",
    });
    expect(r.pgWholesaleCents).toBe(400);
    expect(r.refundCents).toBe(7000);
  });

  it("Plan C → withholds the row's $2", () => {
    const r = computeCancellationRefund({
      amountReceivedCents: 7100,
      protectionPlan: C.name,
      protectionPlanPriceDollars: C.price,
      protectionPlanWholesaleDollars: C.wholesalePrice,
    });
    expect(r.pgWholesaleCents).toBe(200);
    expect(r.refundCents).toBe(6900);
  });

  it("reads the ROW, never the live constant: a wholesale no current tier has is withheld verbatim", () => {
    const r = computeCancellationRefund({
      amountReceivedCents: 8000,
      protectionPlan: "$1,000 Protection",
      protectionPlanPriceDollars: "10.99", // sold before the 2026-09-14 retail change
      protectionPlanWholesaleDollars: "5.00", // hypothetical earlier contract — NOT $6 / $4 / $2
    });
    expect(r.pgWholesaleCents).toBe(500);
    expect(r.refundCents).toBe(7500);
  });

  it("caps the withholding at the premium if the premium were somehow below the wholesale", () => {
    const r = computeCancellationRefund({
      amountReceivedCents: 5000,
      protectionPlan: A.name,
      protectionPlanPriceDollars: 4.5,
      protectionPlanWholesaleDollars: 6,
    });
    expect(r.pgWholesaleCents).toBe(450); // min(6, 4.5) * 100
    expect(r.refundCents).toBe(4550);
  });

  it("dirty row: protection_plan set but price null → withhold nothing (no NaN, no over-withhold)", () => {
    const r = computeCancellationRefund({
      amountReceivedCents: 5000,
      protectionPlan: A.name,
      protectionPlanPriceDollars: null,
      protectionPlanWholesaleDollars: 6,
    });
    expect(r.pgWholesaleCents).toBe(0);
    expect(r.refundCents).toBe(5000);
  });

  it("dirty row: protection_plan set but wholesale null (pre-022 deploy-window row) → withhold nothing", () => {
    // Triply eats the wholesale rather than guess a tier from the price.
    const r = computeCancellationRefund({
      amountReceivedCents: 5000,
      protectionPlan: A.name,
      protectionPlanPriceDollars: A.price,
      protectionPlanWholesaleDollars: null,
    });
    expect(r.pgWholesaleCents).toBe(0);
    expect(r.refundCents).toBe(5000);
  });

  it("dirty row: non-numeric strings ('abc'/'') in either column → withhold nothing, full refund", () => {
    for (const bad of ["abc", "", "  "]) {
      const badPrice = computeCancellationRefund({
        amountReceivedCents: 5000,
        protectionPlan: A.name,
        protectionPlanPriceDollars: bad,
        protectionPlanWholesaleDollars: 6,
      });
      expect(badPrice.pgWholesaleCents).toBe(0);
      expect(badPrice.refundCents).toBe(5000);
      const badWholesale = computeCancellationRefund({
        amountReceivedCents: 5000,
        protectionPlan: A.name,
        protectionPlanPriceDollars: A.price,
        protectionPlanWholesaleDollars: bad,
      });
      expect(badWholesale.pgWholesaleCents).toBe(0);
      expect(badWholesale.refundCents).toBe(5000);
    }
  });

  it("dirty row: NaN number in either column → withhold nothing (finite guard), never a NaN refund", () => {
    for (const input of [
      { protectionPlanPriceDollars: Number.NaN, protectionPlanWholesaleDollars: 6 },
      { protectionPlanPriceDollars: A.price, protectionPlanWholesaleDollars: Number.NaN },
    ]) {
      const r = computeCancellationRefund({
        amountReceivedCents: 5000,
        protectionPlan: A.name,
        ...input,
      });
      expect(r.pgWholesaleCents).toBe(0);
      expect(r.refundCents).toBe(5000);
      expect(Number.isFinite(r.refundCents)).toBe(true);
    }
  });

  it("dirty row: a negative wholesale never INCREASES the refund", () => {
    const r = computeCancellationRefund({
      amountReceivedCents: 5000,
      protectionPlan: A.name,
      protectionPlanPriceDollars: A.price,
      protectionPlanWholesaleDollars: -6,
    });
    expect(r.pgWholesaleCents).toBe(0);
    expect(r.refundCents).toBe(5000);
  });

  it("throws (never returns NaN) if amountReceivedCents is non-finite", () => {
    expect(() =>
      computeCancellationRefund({
        amountReceivedCents: Number.NaN,
        protectionPlan: null,
        protectionPlanPriceDollars: null,
        protectionPlanWholesaleDollars: null,
      }),
    ).toThrow(/non-finite/);
  });

  it("subtracts a prior partial refund (self-heals on a cron re-drive)", () => {
    expect(
      computeCancellationRefund({
        amountReceivedCents: 10000,
        priorRefundedCents: 2500,
        protectionPlan: null,
        protectionPlanPriceDollars: null,
        protectionPlanWholesaleDollars: null,
      }).refundCents,
    ).toBe(7500);
  });

  it("clamps to 0 (never negative) when a full refund already landed", () => {
    expect(
      computeCancellationRefund({
        amountReceivedCents: 10000,
        priorRefundedCents: 10000,
        protectionPlan: null,
        protectionPlanPriceDollars: null,
        protectionPlanWholesaleDollars: null,
      }).refundCents,
    ).toBe(0);
  });

  it("clamps to 0 when a prior refund exceeds the net owed (PG case)", () => {
    expect(
      computeCancellationRefund({
        amountReceivedCents: 7000,
        priorRefundedCents: 6800,
        protectionPlan: A.name,
        protectionPlanPriceDollars: A.price,
        protectionPlanWholesaleDollars: A.wholesalePrice,
      }).refundCents,
    ).toBe(0);
  });

  it("the 100×-bug guard: a $66.01 refund is 6601 cents, not 660100", () => {
    const r = computeCancellationRefund({
      amountReceivedCents: 6601,
      protectionPlan: null,
      protectionPlanPriceDollars: null,
      protectionPlanWholesaleDollars: null,
    });
    expect(r.refundCents).toBe(6601);
    expect(r.refundCents).toBeLessThan(1_000_000);
  });
});
