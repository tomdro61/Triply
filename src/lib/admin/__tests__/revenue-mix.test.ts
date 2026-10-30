import { describe, it, expect } from "vitest";
import type { z } from "zod";
import type { ReconcileResult } from "@/lib/accounting/types";
import {
  accountingMixSchema,
  axisTicks,
  bottomLine,
  compactMoney,
  formatNegative,
  isDefinitive,
  keptSlices,
  keptStateOf,
  mixFromAccounting,
  netCommission,
  schemaIssuePaths,
  share,
  stackExtent,
} from "../revenue-mix";

// Compile-time contract: the chart schema only reads fields the reconciler
// actually returns, with compatible types. A rename in ReconcileResult breaks
// this line instead of silently blanking the chart at runtime.
type ReconcilerHasEverythingTheChartReads = ReconcileResult extends z.input<typeof accountingMixSchema> ? true : never;
const reconcilerContract: ReconcilerHasEverythingTheChartReads = true;
void reconcilerContract;

// Distinct values everywhere, so a field read from the wrong place shows up.
const response = (
  over: {
    total?: number | null;
    commission?: number | null;
    fee?: number | null;
    cash?: number | null;
    fees?: number | null;
    pgMargin?: number;
    missing?: string[];
  } = {}
) => ({
  counts: { confirmed: 41, refunded: 3 },
  grossRevenue: 4866.37,
  grossCustomerSpend: 5282.87,
  confirmed: { serviceFee: 332.57, pgPremium: 83.93, pgOptIns: 7, pgWholesale: 42 },
  triplyNet: {
    serviceFee: 344.52, // includes 11.95 kept on refunded bookings
    pgMargin: over.pgMargin ?? 41.93,
    parkingChannelCommission: "commission" in over ? over.commission : 612.4,
    reslabChannelFee: "fee" in over ? over.fee : 151.1,
    total: "total" in over ? over.total : 847.75,
    cashTotal: "cash" in over ? over.cash : 690.25,
    stripeProcessingFees: "fees" in over ? over.fees : 157.5,
    totalReason: null as string | null,
  },
  direct: { confirmed: 2 },
  pgWholesaleMissingReservations: over.missing ?? [],
  bookings: [],
});
const mixOf = (over?: Parameters<typeof response>[0]) => mixFromAccounting(accountingMixSchema.parse(response(over)));

describe("mixFromAccounting", () => {
  it("maps paid from the confirmed figures and kept from triplyNet", () => {
    const m = mixOf();
    expect(m.paid).toEqual({
      parking: 4866.37,
      serviceFee: 332.57,
      parkGuard: 83.93,
      total: 5282.87, // the reconciler's grossCustomerSpend, read — not re-added
      bookings: 41,
      pgOptIns: 7,
    });
    expect(m.kept).toEqual({
      parkingCommission: 612.4,
      reslabFee: 151.1,
      serviceFee: 344.52,
      pgMargin: 41.93,
      total: 847.75,
      stripeFees: 157.5,
      net: 690.25,
    });
    expect(m.keptReason).toBeNull();
    expect(m.directConfirmed).toBe(2);
    expect(m.pgWholesaleMissing).toBe(0);
    expect(isDefinitive(m)).toBe(true);
  });

  it("no kept figures when the reconciler has no total, with its reason", () => {
    const r = response({ total: null, cash: null });
    r.triplyNet.totalReason = "missing ResLab data for 1 of 41 confirmed bookings";
    const m = mixFromAccounting(accountingMixSchema.parse(r));
    expect(m.kept).toBeNull();
    expect(m.keptReason).toBe("missing ResLab data for 1 of 41 confirmed bookings");
    expect(keptStateOf(m)).toEqual({ unavailable: "missing ResLab data for 1 of 41 confirmed bookings" });
    expect(isDefinitive(m)).toBe(false);
  });

  it("no kept figures when the commission or the ResLab fee is unknown, even with a total", () => {
    for (const over of [{ commission: null }, { fee: null }]) {
      const m = mixOf(over);
      expect(m.kept).toBeNull();
      expect(m.keptReason).toBe("the reconciler returned no total");
    }
  });

  it("keeps the pre-Stripe total when Stripe fees are unknown — never invents net", () => {
    const m = mixOf({ cash: null, fees: null });
    expect(m.kept?.net).toBeNull();
    expect(m.kept?.stripeFees).toBeNull();
    expect(bottomLine(m.kept!)).toBe(847.75);
  });

  it("carries accounting's missing-wholesale warning and refuses to call it definitive", () => {
    const m = mixOf({ missing: ["RTL1", "RTL2"] });
    expect(m.pgWholesaleMissing).toBe(2);
    expect(m.kept).not.toBeNull();
    expect(isDefinitive(m)).toBe(false);
  });

  it("an empty month parses, with no ratios downstream", () => {
    const r = response({ commission: 0, fee: 0, total: 0, cash: 0, fees: 0, pgMargin: 0 });
    const m = mixFromAccounting(
      accountingMixSchema.parse({
        ...r,
        counts: { confirmed: 0 },
        grossRevenue: 0,
        grossCustomerSpend: 0,
        confirmed: { serviceFee: 0, pgPremium: 0, pgOptIns: 0 },
      })
    );
    expect(m.paid.total).toBe(0);
    expect(share(m.paid.serviceFee, m.paid.total)).toBeNull();
  });

  it("rejects a missing field, accepts a null one where the reconciler allows it", () => {
    expect(accountingMixSchema.safeParse({ ...response(), direct: undefined }).success).toBe(false);
    const missing = accountingMixSchema.safeParse({
      ...response(),
      triplyNet: { ...response().triplyNet, reslabChannelFee: undefined },
    });
    expect(missing.success).toBe(false);
    if (!missing.success) expect(schemaIssuePaths(missing.error)).toBe("triplyNet.reslabChannelFee");
    expect(accountingMixSchema.safeParse(response({ fee: null })).success).toBe(true);
  });
});

describe("kept slices", () => {
  it("commission after ResLab's fee; the three slices add up to the reconciler's total", () => {
    const k = mixOf().kept!;
    expect(netCommission(k)).toBeCloseTo(461.3, 10);
    const s = keptSlices(k);
    expect(s.commission + s.serviceFee + s.pgMargin).toBeCloseTo(k.total, 10);
    expect(bottomLine(k)).toBe(690.25);
  });
  it("a negative Park Guard margin stays negative and still adds up", () => {
    const k = mixOf({ pgMargin: -12, total: 461.3 + 344.52 - 12 }).kept!;
    const s = keptSlices(k);
    expect(s.pgMargin).toBe(-12);
    expect(s.commission + s.serviceFee + s.pgMargin).toBeCloseTo(k.total, 10);
    const ext = stackExtent([s.commission, s.serviceFee, s.pgMargin]);
    expect(ext.up).toBeCloseTo(461.3 + 344.52, 10);
    expect(ext.down).toBe(-12);
  });
  it("commission below the fee (Due-at-Lot bookings) is a negative slice", () => {
    expect(netCommission(mixOf({ commission: 100, fee: 151.1 }).kept!)).toBeCloseTo(-51.1, 10);
  });
});

describe("share", () => {
  it("is null for a non-positive whole and signed for a negative part", () => {
    expect(share(5, 0)).toBeNull();
    expect(share(5, -1)).toBeNull();
    expect(share(25, 100)).toBe(0.25);
    expect(share(-10, 100)).toBe(-0.1);
  });
});

describe("axisTicks", () => {
  const sane = (t: number[], lo: number, hi: number) => {
    expect(t.length).toBeGreaterThanOrEqual(2);
    expect(t.every(Number.isFinite)).toBe(true);
    expect(new Set(t).size).toBe(t.length);
    for (let i = 1; i < t.length; i++) expect(t[i]).toBeGreaterThan(t[i - 1]);
    expect(t).toContain(0);
    expect(t[0]).toBeLessThanOrEqual(lo);
    expect(t[t.length - 1]).toBeGreaterThanOrEqual(hi);
  };
  it("clean steps from 0 up", () => {
    expect(axisTicks(0, 5282.87)).toEqual([0, 2000, 4000, 6000]);
    expect(axisTicks(0, 847.75)).toEqual([0, 250, 500, 750, 1000]);
    expect(axisTicks(0, 100)).toEqual([0, 25, 50, 75, 100]);
  });
  it("extends below zero for a loss, on the same step", () => {
    const t = axisTicks(-40, 900);
    sane(t, -40, 900);
    expect(t[0]).toBe(-250);
  });
  it("never degenerates", () => {
    for (const [lo, hi] of [
      [0, 0],
      [0, 0.004],
      [0, 0.7],
      [0, 1e-9],
      [-5, 0],
      [0, 1e7],
      [0, 123456789],
    ]) {
      sane(axisTicks(lo, hi), lo, hi);
    }
    sane(axisTicks(Number.NaN, Number.POSITIVE_INFINITY), 0, 0);
  });
});

describe("compactMoney", () => {
  it("compacts at clean boundaries", () => {
    expect(compactMoney(0)).toBe("$0");
    expect(compactMoney(849.6)).toBe("$850");
    expect(compactMoney(999.6)).toBe("$1K");
    expect(compactMoney(1234)).toBe("$1.2K");
    expect(compactMoney(9949)).toBe("$9.9K");
    expect(compactMoney(9950)).toBe("$10K");
    expect(compactMoney(12500)).toBe("$13K");
    expect(compactMoney(999_500)).toBe("$1M");
    expect(compactMoney(1_400_000)).toBe("$1.4M");
  });
  it("signs losses, but never a negative zero", () => {
    expect(compactMoney(-40)).toBe("−$40");
    expect(compactMoney(-0.4)).toBe("$0");
  });
});

describe("formatNegative", () => {
  it("prefixes a real minus sign", () => {
    expect(formatNegative(157.5)).toBe("−$157.50");
  });
});
