import { describe, it, expect } from "vitest";
import {
  accountingMixSchema,
  bottomLine,
  compactMoney,
  mixFromAccounting,
  netCommission,
  niceTicks,
  paidFromStats,
  share,
} from "../revenue-mix";

// Distinct values everywhere, so a field read from the wrong place shows up.
const response = (over: { total?: number | null; commission?: number | null; cash?: number | null; fees?: number | null } = {}) => ({
  counts: { confirmed: 41, refunded: 3 },
  grossRevenue: 4866.37,
  grossCustomerSpend: 5282.87,
  confirmed: { serviceFee: 332.57, pgPremium: 83.93, pgOptIns: 7, pgWholesale: 42 },
  triplyNet: {
    serviceFee: 344.52, // includes 11.95 kept on refunded bookings
    pgMargin: 41.93,
    parkingChannelCommission: "commission" in over ? over.commission : 612.4,
    reslabChannelFee: 151.1,
    total: "total" in over ? over.total : 847.75,
    cashTotal: "cash" in over ? over.cash : 690.25,
    stripeProcessingFees: "fees" in over ? over.fees : 157.5,
    totalReason: null as string | null,
  },
  direct: { confirmed: 2 },
  bookings: [],
});

describe("mixFromAccounting", () => {
  it("maps paid from the confirmed figures and kept from triplyNet", () => {
    const m = mixFromAccounting(accountingMixSchema.parse(response()));
    expect(m.paid).toEqual({
      parking: 4866.37,
      serviceFee: 332.57,
      parkGuard: 83.93,
      total: 4866.37 + 332.57 + 83.93,
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
  });

  it("no kept figures when the reconciler has no total, with its reason", () => {
    const r = response({ total: null, cash: null });
    r.triplyNet.totalReason = "missing ResLab data for 1 of 41 confirmed bookings";
    const m = mixFromAccounting(accountingMixSchema.parse(r));
    expect(m.kept).toBeNull();
    expect(m.keptReason).toBe("missing ResLab data for 1 of 41 confirmed bookings");
    expect(m.paid.total).toBeCloseTo(5282.87, 10);
  });

  it("no kept figures when the commission is unknown even if a total came back", () => {
    const m = mixFromAccounting(accountingMixSchema.parse(response({ commission: null })));
    expect(m.kept).toBeNull();
    expect(m.keptReason).toBe("the reconciler returned no total");
  });

  it("keeps the pre-Stripe total when Stripe fees are unknown — never invents net", () => {
    const m = mixFromAccounting(accountingMixSchema.parse(response({ cash: null, fees: null })));
    expect(m.kept?.net).toBeNull();
    expect(m.kept?.stripeFees).toBeNull();
    expect(bottomLine(m.kept!)).toBe(847.75);
  });

  it("rejects a response without the fields it reads", () => {
    const noDirect = { ...response(), direct: undefined };
    expect(accountingMixSchema.safeParse(noDirect).success).toBe(false);
  });
});

describe("netCommission / bottomLine", () => {
  it("commission after ResLab's fee; bottom line is net cash when known", () => {
    const k = mixFromAccounting(accountingMixSchema.parse(response())).kept!;
    expect(netCommission(k)).toBeCloseTo(461.3, 10);
    expect(bottomLine(k)).toBe(690.25);
    // The three kept slices add up to the reconciler's total.
    expect(netCommission(k) + k.serviceFee + k.pgMargin).toBeCloseTo(k.total, 10);
  });
});

describe("paidFromStats", () => {
  it("parking is gross less service fee and Park Guard", () => {
    expect(paidFromStats({ gross: 1000, serviceFee: 60, pgRevenue: 25.98, confirmed: 9, pgOptIns: 2 })).toEqual({
      parking: 1000 - 60 - 25.98,
      serviceFee: 60,
      parkGuard: 25.98,
      total: 1000,
      bookings: 9,
      pgOptIns: 2,
    });
  });
});

describe("share", () => {
  it("is null for a non-positive whole", () => {
    expect(share(5, 0)).toBeNull();
    expect(share(5, -1)).toBeNull();
    expect(share(25, 100)).toBe(0.25);
  });
});

describe("niceTicks", () => {
  it("starts at 0 and ends at or above max on clean steps", () => {
    expect(niceTicks(5282.87)).toEqual([0, 2000, 4000, 6000]);
    expect(niceTicks(847.75)).toEqual([0, 250, 500, 750, 1000]);
    expect(niceTicks(100)).toEqual([0, 25, 50, 75, 100]);
  });
  it("handles zero and garbage", () => {
    expect(niceTicks(0)).toEqual([0, 1]);
    expect(niceTicks(Number.NaN)).toEqual([0, 1]);
  });
});

describe("compactMoney", () => {
  it("compacts from a thousand up", () => {
    expect(compactMoney(0)).toBe("$0");
    expect(compactMoney(849.6)).toBe("$850");
    expect(compactMoney(1234)).toBe("$1.2K");
    expect(compactMoney(12500)).toBe("$13K");
    expect(compactMoney(-40)).toBe("−$40");
  });
});
