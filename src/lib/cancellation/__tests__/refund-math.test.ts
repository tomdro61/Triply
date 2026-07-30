import { describe, it, expect } from "vitest";
import { computeCancellationRefund } from "../refund-math";
import { PROTECTION_PLAN } from "@/lib/parkguard/client";

describe("computeCancellationRefund", () => {
  it("no Park Guard → 100% refund (service fee included)", () => {
    expect(
      computeCancellationRefund({
        amountReceivedCents: 6601, // $66.01
        protectionPlan: null,
        protectionPlanPriceDollars: null,
      }),
    ).toEqual({ refundCents: 6601, pgWholesaleCents: 0 });
  });

  it("with Park Guard → withholds exactly the $6 wholesale", () => {
    const r = computeCancellationRefund({
      amountReceivedCents: 7700, // $77.00 incl. the $10.99 PG premium
      protectionPlan: PROTECTION_PLAN.name,
      protectionPlanPriceDollars: PROTECTION_PLAN.price, // 10.99
    });
    expect(r.pgWholesaleCents).toBe(600);
    expect(r.refundCents).toBe(7100); // 7700 - 600
  });

  it("withholds only $6 even on an older, higher-premium ($12.99) booking", () => {
    const r = computeCancellationRefund({
      amountReceivedCents: 8000,
      protectionPlan: PROTECTION_PLAN.name,
      protectionPlanPriceDollars: "12.99", // stored as a string (decimal column)
    });
    expect(r.pgWholesaleCents).toBe(600); // capped at $6, not the higher premium
    expect(r.refundCents).toBe(7400);
  });

  it("caps the withholding at the premium if it were somehow < $6", () => {
    const r = computeCancellationRefund({
      amountReceivedCents: 5000,
      protectionPlan: PROTECTION_PLAN.name,
      protectionPlanPriceDollars: 4.5,
    });
    expect(r.pgWholesaleCents).toBe(450); // min(6, 4.5) * 100
    expect(r.refundCents).toBe(4550);
  });

  it("dirty row: protection_plan set but price null → withhold nothing (no NaN, no over-withhold)", () => {
    const r = computeCancellationRefund({
      amountReceivedCents: 5000,
      protectionPlan: PROTECTION_PLAN.name,
      protectionPlanPriceDollars: null,
    });
    expect(r.pgWholesaleCents).toBe(0);
    expect(r.refundCents).toBe(5000);
  });

  it("dirty row: non-numeric price string ('abc'/'') → withhold nothing, full refund", () => {
    for (const bad of ["abc", "", "  "]) {
      const r = computeCancellationRefund({
        amountReceivedCents: 5000,
        protectionPlan: PROTECTION_PLAN.name,
        protectionPlanPriceDollars: bad,
      });
      expect(r.pgWholesaleCents).toBe(0);
      expect(r.refundCents).toBe(5000);
    }
  });

  it("dirty row: NaN number price → withhold nothing (finite guard), never a NaN refund", () => {
    const r = computeCancellationRefund({
      amountReceivedCents: 5000,
      protectionPlan: PROTECTION_PLAN.name,
      protectionPlanPriceDollars: Number.NaN,
    });
    expect(r.pgWholesaleCents).toBe(0);
    expect(r.refundCents).toBe(5000);
    expect(Number.isFinite(r.refundCents)).toBe(true);
  });

  it("throws (never returns NaN) if amountReceivedCents is non-finite", () => {
    expect(() =>
      computeCancellationRefund({
        amountReceivedCents: Number.NaN,
        protectionPlan: null,
        protectionPlanPriceDollars: null,
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
      }).refundCents,
    ).toBe(0);
  });

  it("clamps to 0 when a prior refund exceeds the net owed (PG case)", () => {
    expect(
      computeCancellationRefund({
        amountReceivedCents: 7000,
        priorRefundedCents: 6800,
        protectionPlan: PROTECTION_PLAN.name,
        protectionPlanPriceDollars: PROTECTION_PLAN.price,
      }).refundCents,
    ).toBe(0);
  });

  it("the 100×-bug guard: a $66.01 refund is 6601 cents, not 660100", () => {
    const r = computeCancellationRefund({
      amountReceivedCents: 6601,
      protectionPlan: null,
      protectionPlanPriceDollars: null,
    });
    expect(r.refundCents).toBe(6601);
    expect(r.refundCents).toBeLessThan(1_000_000);
  });
});
