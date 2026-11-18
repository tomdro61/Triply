import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ReconcileOptions } from "../types";

/**
 * Bookings whose ResLab reservation is in Canadian dollars. The booking row
 * and Stripe are US dollars; ResLab's history is CAD. Every expectation below
 * is worked out by hand from the fixture figures.
 */

const h = vi.hoisted(() => ({
  rows: [] as unknown[],
  pis: new Map<string, unknown>(),
  reservations: new Map<string, unknown>(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: vi.fn(async () => {
    const builder: Record<string, unknown> = {};
    for (const m of ["from", "select", "gte", "lte", "order"]) builder[m] = () => builder;
    builder.returns = () => Promise.resolve({ data: h.rows, error: null });
    return builder;
  }),
}));

vi.mock("@/lib/stripe/client", () => ({
  stripe: {
    paymentIntents: {
      retrieve: vi.fn(async (id: string) => {
        const pi = h.pis.get(id);
        if (pi === undefined) {
          const err = new Error(`No such payment_intent: ${id}`) as Error & { code: string };
          err.code = "resource_missing";
          throw err;
        }
        return pi;
      }),
    },
  },
}));

import { reconcileRevenue } from "../reconcile";
import { netTakeOfDetail } from "@/lib/admin/blog-bookings";
import { classifyRowCurrency, CONVERSION_LIVE_FROM } from "../reslab-currency";

const OPTS: ReconcileOptions = {
  from: "2026-12-01",
  to: "2026-12-31",
  by: "checkout",
  invoiceAmount: 0,
  includeReslab: true,
  includeStripe: true,
};

function row(resNum: string, over: Record<string, unknown> = {}) {
  h.rows.push({
    id: `id-${resNum}`,
    reslab_reservation_number: resNum,
    status: "confirmed",
    created_at: "2026-12-02T12:00:00Z",
    check_in: "2026-12-10 10:00:00",
    check_out: "2026-12-15 10:00:00",
    grand_total: 100,
    subtotal: 80,
    due_at_location: 0,
    triply_service_fee: 5.95,
    service_fee_refunded: false,
    protection_plan: null,
    protection_plan_price: 0,
    protection_plan_wholesale: null,
    pg_identifier: null,
    stripe_payment_intent_id: `pi_${resNum}`,
    reslab_location_id: 330,
    location_name: "Lot YUL",
    airport_code: "YUL",
    inventory_source: "reslab",
    direct_lot_id: null,
    livemode: true,
    discount_amount: 0,
    reslab_currency: null,
    fx_rate: null,
    customers: { email: "a@example.com" },
    ...over,
  });
}

function pi(resNum: string, received: number, refunded = 0) {
  h.pis.set(`pi_${resNum}`, {
    amount_received: received,
    latest_charge: { amount_refunded: refunded, balance_transaction: { fee: 300 } },
    status: "succeeded",
    metadata: {},
  });
}

const CAD = { location: { currency: { code: "CAD" } } };
const USD = { location: { currency: { code: "USD" } } };

/** C$123.00: subtotal 100 + fees 10 + tax 13. Lot is owed C$95, commission C$20, ResLab fee C$4. */
const CAD_HISTORY = {
  ...CAD,
  subtotal: 100,
  total_fees: 10,
  total_tax: 13,
  grand_total: 123,
  location_total: 95,
  due_at_location_total: 0,
  channel_total: 20,
  commissions_total: 75,
  refund_amount: 0,
  partial_refund: 0,
  fees: [
    { fee_type: "location_fee", dollar_amount: 6 },
    { fee_type: "channel_fee", dollar_amount: 4 },
  ],
};
/** A US$100 reservation: lot owed 82, commission 18, ResLab fee 4. */
const USD_HISTORY = {
  ...USD,
  subtotal: 80,
  total_fees: 12,
  total_tax: 8,
  grand_total: 100,
  location_total: 82,
  due_at_location_total: 0,
  channel_total: 18,
  commissions_total: 64,
  refund_amount: 0,
  partial_refund: 0,
  fees: [{ fee_type: "channel_fee", dollar_amount: 4 }],
};

function reservation(resNum: string, history: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  h.reservations.set(resNum, { cancelled: 0, history: [history], ...extra });
}

/** Converted at 0.75: the row holds US$92.25 (75.00 + 7.50 + 9.75); the card paid 92.25 + 5.95. */
function converted(resNum = "CA1", over: Record<string, unknown> = {}, history: Record<string, unknown> = CAD_HISTORY) {
  row(resNum, { grand_total: 92.25, subtotal: 75, reslab_currency: "CAD", fx_rate: "0.750000", ...over });
  pi(resNum, 9820);
  reservation(resNum, history);
}

/** One of the old bookings: charged C$123 as US$123, row unmarked, booked before conversion. */
function legacy(resNum = "OLD1", over: Record<string, unknown> = {}) {
  row(resNum, { grand_total: 123, subtotal: 100, created_at: "2026-10-31T15:00:00Z", ...over });
  pi(resNum, 12895);
  reservation(resNum, CAD_HISTORY);
}

function us(resNum = "US1") {
  row(resNum, { reslab_location_id: 100, airport_code: "JFK" });
  pi(resNum, 10595);
  reservation(resNum, USD_HISTORY);
}

beforeEach(() => {
  h.rows = [];
  h.pis.clear();
  h.reservations.clear();
  process.env.STRIPE_SECRET_KEY = "sk_live_dummy";
  process.env.RESLAB_API_KEY = "k";
  process.env.RESLAB_API_URL = "https://reslab.test/v1";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/authenticate")) return { ok: true, json: async () => ({ token: "tok" }) } as unknown as Response;
      const data = h.reservations.get(url.split("/reservations/")[1] ?? "");
      if (data === undefined) return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
      return { ok: true, json: async () => data } as unknown as Response;
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a converted booking (row marked CAD with its own rate)", () => {
  it("puts every ResLab figure into US dollars at the booking's rate", async () => {
    converted();
    const r = await reconcileRevenue(OPTS);
    const b = r.bookings[0];

    expect(b.reslab_location_total).toBe(71.25); // C$95 × 0.75
    expect(b.reslab_channel_total).toBe(15); // C$20
    expect(b.reslab_channel_fee).toBe(3); // C$4
    expect(b.reslab_commissions_total).toBe(56.25); // C$75
    expect(b.reslab_grand_total).toBe(92.25);
    expect(b.triply_total).toBeCloseTo(20.95, 10); // 15 commission + 5.95 fee
    expect(b.fx).toEqual({
      kind: "converted",
      rate: "0.750000",
      location_total_cad: 95,
      due_at_location_cad: 0,
      channel_fee_cad: 4,
      channel_total_cad: 20,
      commissions_total_cad: 75,
      grand_total_cad: 123,
    });
    expect(b.note).toContain("converted from CAD at 0.750000");

    // Triply's keep: commission 15 − ResLab fee 3 + service fee 5.95.
    expect(r.triplyNet.total).toBeCloseTo(17.95, 10);
    expect(r.triplyNet.canadianEstimated).toBe(1);
    expect(r.triplyNet.canadianLeftOut).toBe(0);
    expect(r.confirmed.channelTotal).toBe(15);
    expect(r.confirmed.channelFee).toBe(3);
    expect(r.confirmed.locationTotalOwed).toBe(71.25);
    expect(r.confirmed.reslabSubtotal).toBe(75);
    expect(r.takeRates.channelCommissionRate).toBeCloseTo(0.2, 10);
    // Net take for the blog-bookings page is US dollars too.
    expect(netTakeOfDetail(b)).toBeCloseTo(17.95, 10);

    expect(r.reslab.grandTotalMismatches).toEqual([]);
    expect(r.integrity.chargeMismatches).toEqual([]);
    expect(r.integrity.parkingFlowMismatches).toEqual([]);
    expect(r.reslab.dataIncomplete).toBe(false);
  });

  it("keeps what is owed for it out of the US-dollar settlement, and reports it in CAD", async () => {
    converted();
    const r = await reconcileRevenue({ ...OPTS, invoiceAmount: 70 });

    expect(r.reslab.sumAmountOwed).toBe(0);
    expect(r.reslab.sumLocationTotal).toBe(0);
    expect(r.reslab.sumChannelFee).toBe(0);
    expect(r.reslab.settlementRows).toBe(0);
    expect(r.reslab.variance).toBe(-70);

    expect(r.canadian.converted).toBe(1);
    expect(r.canadian.settlementRows).toBe(1);
    expect(r.canadian.converted_owed).toEqual({ cad: 99, usdAtBookingRates: 74.25 }); // C$95 + C$4
    expect(r.canadian.keepEstimate).toBe(12);
    expect(r.canadian.reservations).toEqual([{ resNum: "CA1", kind: "converted", reason: null }]);

    // No invoice rate: the Canadian part of the invoice is the booking-rate estimate.
    expect(r.reslab.canadianInvoiceBasis).toBe("booking_rates");
    expect(r.reslab.canadianInvoiceUsd).toBe(74.25);
    expect(r.reslab.varianceInclCanadian).toBeCloseTo(4.25, 10);
    expect(r.reslab.exchangeDifference).toBeNull();
  });

  it("with ResLab's invoice rate: every Canadian dollar at that rate, and the exchange difference", async () => {
    converted();
    const r = await reconcileRevenue({ ...OPTS, invoiceAmount: 70, invoiceCadRate: 0.72 });

    expect(r.reslab.canadianInvoiceBasis).toBe("invoice_rate");
    expect(r.reslab.canadianInvoiceUsd).toBe(71.28); // C$99 × 0.72
    expect(r.reslab.varianceInclCanadian).toBeCloseTo(1.28, 10);
    expect(r.reslab.exchangeDifference).toBe(-2.97); // 71.28 − 74.25: cheaper than estimated
    // The invoice rate never moves what Triply kept.
    expect(r.triplyNet.total).toBeCloseTo(17.95, 10);
    expect(r.bookings[0].reslab_channel_total).toBe(15);
  });

  it("converts the parts one by one, as fulfilment did: C$34.56 at 0.725 is US$25.05, not 25.06", async () => {
    // 29.95 → 21.71, 1.50 → 1.09, 3.11 → 2.25. As one figure 34.56 → 25.06.
    row("CA2", { grand_total: 25.05, subtotal: 21.71, reslab_currency: "CAD", fx_rate: 0.725 });
    pi("CA2", 3100);
    reservation("CA2", { ...CAD_HISTORY, subtotal: 29.95, total_fees: 1.5, total_tax: 3.11, grand_total: 34.56 });
    const r = await reconcileRevenue(OPTS);

    expect(r.bookings[0].reslab_grand_total).toBe(25.05);
    expect(r.bookings[0].fx?.rate).toBe("0.725000");
    expect(r.reslab.grandTotalMismatches).toEqual([]);
  });

  it("reports a booking one cent off its stamped rate", async () => {
    converted("CA1", { grand_total: 92.27 });
    const r = await reconcileRevenue(OPTS);

    expect(r.reslab.grandTotalMismatches).toHaveLength(1);
    expect(r.reslab.grandTotalMismatches[0]).toMatchObject({ resNum: "CA1", supabase: 92.27, reslab: 92.25 });
    expect(r.reslab.grandTotalMismatches[0].note).toContain("C$123.00 at the booking's rate 0.750000");
  });

  it("reports parts that do not add up, even when the single total happens to match", async () => {
    converted("CA1", {}, { ...CAD_HISTORY, total_tax: 12 }); // 100 + 10 + 12 ≠ 123
    const r = await reconcileRevenue(OPTS);

    expect(r.reslab.grandTotalMismatches).toHaveLength(1);
    expect(r.reslab.grandTotalMismatches[0].note).toContain("do not convert");
    // The settlement figures still convert: the row stays in the totals.
    expect(r.triplyNet.total).toBeCloseTo(17.95, 10);
  });

  it("accepts ResLab figures sent as strings", async () => {
    converted("CA1", {}, { ...CAD_HISTORY, location_total: "95.00", channel_total: "20.00", subtotal: "100.00", grand_total: "123.00", total_fees: "10.00", total_tax: "13.00" });
    const r = await reconcileRevenue(OPTS);

    expect(r.bookings[0].reslab_location_total).toBe(71.25);
    expect(r.reslab.grandTotalMismatches).toEqual([]);
  });

  it("is still converted when ResLab states no currency: the row is the witness", async () => {
    const { location: _location, ...noCurrency } = CAD_HISTORY;
    converted("CA1", {}, noCurrency);
    const r = await reconcileRevenue(OPTS);

    expect(r.canadian.converted).toBe(1);
    expect(r.bookings[0].reslab_channel_total).toBe(15);
  });

  it("a display-only figure that cannot be converted is unknown, not a fault", async () => {
    converted("CA1", {}, { ...CAD_HISTORY, refund_amount: -5, commissions_total: 75.123 });
    const r = await reconcileRevenue(OPTS);

    expect(r.bookings[0].reslab_refund_amount).toBeNull();
    expect(r.bookings[0].reslab_commissions_total).toBeNull();
    expect(r.canadian.faults).toBe(0);
    expect(r.triplyNet.total).toBeCloseTo(17.95, 10);
  });

  it("refunded, with ResLab's history zeroed: no mismatch, nothing owed, fee kept", async () => {
    converted("CA1", { status: "refunded" }, { ...CAD_HISTORY, grand_total: 0, location_total: 0, channel_total: 0 });
    h.reservations.set("CA1", { ...(h.reservations.get("CA1") as object), cancelled: 1 });
    pi("CA1", 9820, 9225);
    const r = await reconcileRevenue(OPTS);

    expect(r.reslab.grandTotalMismatches).toEqual([]);
    expect(r.canadian.settlementRows).toBe(0);
    expect(r.canadian.converted_owed).toEqual({ cad: 0, usdAtBookingRates: 0 });
    expect(r.triplyNet.total).toBeCloseTo(5.95, 10);
  });

  it("a mixed month: the US booking's figures are exactly what they are alone", async () => {
    us();
    const alone = await reconcileRevenue(OPTS);
    converted();
    const mixed = await reconcileRevenue(OPTS);

    expect(mixed.reslab.sumAmountOwed).toBe(alone.reslab.sumAmountOwed); // 86: the US row only
    expect(mixed.reslab.settlementRows).toBe(1);
    expect(mixed.bookings.find((b) => b.reslab_reservation_number === "US1")).toEqual(alone.bookings[0]);
    expect(mixed.bookings.find((b) => b.reslab_reservation_number === "US1")?.fx).toBeUndefined();
    // 18 − 4 + 5.95 for the US row, + 17.95 for the Canadian one.
    expect(alone.triplyNet.total).toBeCloseTo(19.95, 10);
    expect(mixed.triplyNet.total).toBeCloseTo(37.9, 10);
    expect(mixed.reslab.varianceInclCanadian).toBeCloseTo(86 + 74.25, 10);
  });
});

describe("an old booking charged one-for-one before conversion", () => {
  it("unmarked row: ResLab's side is left out, the headline stays", async () => {
    us();
    legacy();
    const r = await reconcileRevenue(OPTS);
    const old = r.bookings.find((b) => b.reslab_reservation_number === "OLD1");

    expect(r.canadian.noRateLegacy).toBe(1);
    expect(r.canadian.faults).toBe(0);
    expect(r.canadian.reservations).toEqual([
      { resNum: "OLD1", kind: "no_rate_legacy", reason: "booked before conversion: charged the Canadian figure one-for-one" },
    ]);
    expect(r.canadian.noRateOwedCad).toBe(99);
    expect(r.canadian.converted_owed).toEqual({ cad: 0, usdAtBookingRates: 0 });

    // Nothing of ResLab's CAD reaches a US-dollar figure.
    expect(old?.reslab_location_total).toBeNull();
    expect(old?.reslab_channel_total).toBeNull();
    expect(old?.triply_total).toBeNull();
    expect(old?.fx).toMatchObject({ kind: "no_rate", rate: null, channel_total_cad: 20, grand_total_cad: 123 });
    expect(r.reslab.sumAmountOwed).toBe(86);
    expect(r.confirmed.channelTotal).toBe(18);
    expect(r.confirmed.locationTotalOwed).toBe(82);

    // The headline is a figure: the US row in full, the old row's service fee only.
    expect(r.reslab.dataIncomplete).toBe(false);
    expect(r.reslab.confirmedExpected).toBe(1);
    expect(r.reslab.fetched).toBe(1);
    expect(r.triplyNet.total).toBeCloseTo(18 - 4 + 5.95 + 5.95, 10);
    expect(r.triplyNet.canadianLeftOut).toBe(1);

    // Its Stripe parking (128.95 − 5.95) is not in "net parking cash" or the take rates.
    expect(r.confirmed.stripeParkingCollected).toBe(100);
    expect(r.canadian.leftOutConfirmed).toBe(1);
    expect(r.canadian.leftOutStripeParking).toBe(123);
    expect(r.takeRates.stripeTakeRate).toBeCloseTo(19.95 / 105.95, 10);

    // It was charged the Canadian figure, so the raw comparison holds.
    expect(r.reslab.grandTotalMismatches).toEqual([]);
  });

  it("the same booking after the data fix (marked CAD at rate 1)", async () => {
    legacy("OLD1", { reslab_currency: "CAD", fx_rate: "1.000000" });
    const r = await reconcileRevenue(OPTS);

    expect(r.canadian.noRateLegacy).toBe(1);
    expect(r.canadian.faults).toBe(0);
    expect(r.triplyNet.total).toBeCloseTo(5.95, 10);
    expect(r.takeRates.stripeTakeRate).toBeNull(); // nothing left to measure
  });

  it("ResLab's invoice rate prices what is owed for it", async () => {
    legacy();
    const r = await reconcileRevenue({ ...OPTS, invoiceAmount: 71.28, invoiceCadRate: 0.72 });

    expect(r.reslab.canadianInvoiceUsd).toBe(71.28);
    expect(r.reslab.varianceInclCanadian).toBeCloseTo(0, 10);
    expect(r.reslab.exchangeDifference).toBe(0); // no converted booking to compare with
    // Without the rate there is no estimate for it.
    expect((await reconcileRevenue(OPTS)).reslab.canadianInvoiceUsd).toBe(0);
  });

  it("reports Stripe refunds on a confirmed Canadian booking", async () => {
    legacy();
    pi("OLD1", 12895, 3432);
    const r = await reconcileRevenue(OPTS);

    expect(r.canadian.stripeRefunded).toBe(34.32);
  });

  it("a row whose charge was not the Canadian figure is still a mismatch", async () => {
    legacy("OLD1", { grand_total: 120 });
    const r = await reconcileRevenue(OPTS);

    expect(r.reslab.grandTotalMismatches).toEqual([
      { resNum: "OLD1", supabase: 120, reslab: 123, diff: -3, note: "ResLab figure is Canadian dollars, compared one-for-one" },
    ]);
  });
});

describe("a currency fault withholds the headline", () => {
  const faultCases: Array<[string, () => void, string, string]> = [
    [
      "an unmarked Canadian reservation booked after conversion went live",
      () => {
        row("BAD");
        pi("BAD", 10595);
        reservation("BAD", CAD_HISTORY);
      },
      "no_rate",
      "ResLab reports CAD but the booking is not marked as converted",
    ],
    [
      "a row marked CAD that ResLab says is US dollars",
      () => {
        converted("BAD", {}, { ...CAD_HISTORY, ...USD });
      },
      "conflict",
      "the booking is marked CAD but ResLab reports USD",
    ],
    [
      "a third currency",
      () => {
        row("BAD");
        pi("BAD", 10595);
        reservation("BAD", { ...CAD_HISTORY, location: { currency: { code: "eur " } } });
      },
      "conflict",
      "ResLab reports EUR",
    ],
    [
      "a rate that cannot be read",
      () => {
        converted("BAD", { fx_rate: null });
      },
      "no_rate",
      "the booking's rate cannot be read",
    ],
    [
      "rate 1 on a booking made after conversion went live",
      () => {
        converted("BAD", { fx_rate: 1 });
      },
      "no_rate",
      "marked at rate 1 after conversion went live",
    ],
    [
      "a settlement figure that is not whole cents",
      () => {
        converted("BAD", {}, { ...CAD_HISTORY, channel_total: 20.005 });
      },
      "no_rate",
      "a ResLab figure could not be converted",
    ],
    [
      "a negative settlement figure",
      () => {
        converted("BAD", {}, { ...CAD_HISTORY, location_total: -1 });
      },
      "no_rate",
      "a ResLab figure could not be converted",
    ],
  ];

  it.each(faultCases)("%s", async (_name, arrange, kind, reason) => {
    us();
    arrange();
    const r = await reconcileRevenue(OPTS);

    expect(r.canadian.faults).toBe(1);
    expect(r.canadian.reservations).toEqual([{ resNum: "BAD", kind, reason }]);
    expect(r.reslab.dataIncomplete).toBe(true);
    expect(r.triplyNet.total).toBeNull();
    expect(r.triplyNet.totalReason).toBe(
      "missing ResLab data for 1 of 2 confirmed bookings (1 with a currency problem: see Canadian lots)"
    );
    expect(r.takeRates.stripeTakeRate).toBeNull();
    // Its ResLab figures are in no US-dollar sum.
    expect(r.reslab.sumAmountOwed).toBe(86);
    expect(r.confirmed.channelTotal).toBe(18);
    const bad = r.bookings.find((b) => b.reslab_reservation_number === "BAD");
    expect(bad?.reslab_channel_total).toBeNull();
    expect(bad?.note).toContain(`ResLab side left out: ${reason}`);
  });

  it("a conflict is in no Canadian-dollar sum either", async () => {
    converted("BAD", {}, { ...CAD_HISTORY, ...USD });
    const r = await reconcileRevenue({ ...OPTS, invoiceCadRate: 0.72 });

    expect(r.canadian.noRateOwedCad).toBe(0);
    expect(r.canadian.settlementRows).toBe(0);
    expect(r.reslab.canadianInvoiceUsd).toBe(0);
  });
});

describe("with the ResLab cross-check off", () => {
  it("a marked row has no ResLab figures to convert and nothing is claimed", async () => {
    converted();
    const r = await reconcileRevenue({ ...OPTS, includeReslab: false });

    expect(r.canadian.reservations).toEqual([]);
    expect(r.triplyNet.total).toBeNull();
    expect(r.reslab.canadianInvoiceUsd).toBeNull();
    expect(r.reslab.varianceInclCanadian).toBeNull();
    expect(r.bookings[0].fx).toBeUndefined();
  });
});

describe("classifyRowCurrency", () => {
  const before = "2026-10-31T15:00:00+00:00";
  const after = "2026-12-02T12:00:00+00:00";

  it("an unmarked row is US dollars when ResLab says USD or nothing", () => {
    expect(classifyRowCurrency({ created_at: after }, null)).toEqual({ kind: "usd" });
    expect(classifyRowCurrency({ created_at: after, reslab_currency: null, fx_rate: null }, "USD")).toEqual({ kind: "usd" });
  });

  it("reads the rate from a string or a number", () => {
    expect(classifyRowCurrency({ created_at: after, reslab_currency: "CAD", fx_rate: "0.725000" }, "CAD")).toMatchObject({ kind: "cad", rateText: "0.725000" });
    expect(classifyRowCurrency({ created_at: after, reslab_currency: "CAD", fx_rate: 0.725 }, null)).toMatchObject({ kind: "cad", rate: { micros: 725_000 } });
  });

  it("legacy means booked before conversion went live, and nothing else", () => {
    expect(classifyRowCurrency({ created_at: before }, "CAD")).toMatchObject({ kind: "cad_no_rate", legacy: true });
    expect(classifyRowCurrency({ created_at: after }, "CAD")).toMatchObject({ kind: "cad_no_rate", legacy: false });
    expect(classifyRowCurrency({ created_at: CONVERSION_LIVE_FROM }, "CAD")).toMatchObject({ legacy: false });
    expect(classifyRowCurrency({ created_at: "not a date" }, "CAD")).toMatchObject({ kind: "cad_no_rate", legacy: false });
    expect(classifyRowCurrency({ created_at: before, reslab_currency: "CAD", fx_rate: 1 }, "CAD")).toMatchObject({ kind: "cad_no_rate", legacy: true });
    // An unreadable rate is never legacy, however old the row.
    expect(classifyRowCurrency({ created_at: before, reslab_currency: "CAD", fx_rate: "0.4" }, "CAD")).toMatchObject({ kind: "cad_no_rate", legacy: false });
  });

  it("any disagreement is a conflict", () => {
    expect(classifyRowCurrency({ created_at: after, reslab_currency: "CAD", fx_rate: "0.75" }, "USD").kind).toBe("conflict");
    expect(classifyRowCurrency({ created_at: after, reslab_currency: "EUR", fx_rate: "0.75" }, "CAD").kind).toBe("conflict");
    expect(classifyRowCurrency({ created_at: before }, "MXN").kind).toBe("conflict");
  });
});
