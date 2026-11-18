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
import { canadianKindOf, classifyRowCurrency, CONVERSION_LIVE_FROM, isCurrencyFault } from "../reslab-currency";

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
      if (typeof data === "object" && data !== null && "__httpStatus" in data) {
        return { ok: false, status: (data as { __httpStatus: number }).__httpStatus, json: async () => ({}) } as unknown as Response;
      }
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
    expect(r.confirmed.commissionsTotal).toBe(56.25);
    expect(r.confirmed.reslabSubtotal).toBe(75);
    expect(r.confirmed.stripeParkingCollected).toBeCloseTo(92.25, 10);
    expect(r.takeRates.channelCommissionRate).toBeCloseTo(0.2, 10);
    expect(r.takeRates.stripeTakeRate).toBeCloseTo(17.95 / 98.2, 10);
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
    expect(r.canadian.convertedOwed).toEqual({ rows: 1, cad: 99, usdAtBookingRates: 74.25 }); // C$95 + C$4
    expect(r.canadian.legacyOwed).toEqual({ rows: 0, cad: 0 });
    expect(r.canadian.keepEstimate).toBe(12);
    expect(r.canadian.reservations).toEqual([{ resNum: "CA1", kind: "converted", reason: null }]);

    // No invoice rate: the Canadian part of the invoice is the booking-rate estimate.
    expect(r.reslab.canadianInvoice).toEqual({ basis: "booking_rates", usd: 74.25, exchangeDifference: null, unpriced: 0 });
    expect(r.reslab.varianceInclCanadian).toBeCloseTo(4.25, 10);
  });

  it("with ResLab's invoice rate: every Canadian dollar at that rate, and the exchange difference", async () => {
    converted();
    const r = await reconcileRevenue({ ...OPTS, invoiceAmount: 70, invoiceCadRate: 0.72 });

    // C$99 × 0.72 = 71.28; against 74.25 at the booking rate: 2.97 cheaper.
    expect(r.reslab.canadianInvoice).toEqual({ basis: "invoice_rate", usd: 71.28, exchangeDifference: -2.97, unpriced: 0 });
    expect(r.reslab.varianceInclCanadian).toBeCloseTo(1.28, 10);
    // The invoice rate never moves what Triply kept.
    expect(r.triplyNet.total).toBeCloseTo(17.95, 10);
    expect(r.bookings[0].reslab_channel_total).toBe(15);
  });

  it("no exchange difference at equal rates even when no amount converts to an exact cent", async () => {
    // Each row owes C$100.01: 10001 × 0.725 = 7250.725 → 7251. As ONE total, 20002 × 0.725 = 14501.45 → 14501:
    // a cent short of 7251 + 7251, which is rounding, not an exchange effect.
    for (const n of ["CA1", "CA2"]) {
      row(n, { grand_total: 25.05, subtotal: 21.71, reslab_currency: "CAD", fx_rate: "0.725000" });
      pi(n, 3100);
      reservation(n, { ...CAD_HISTORY, subtotal: 29.95, total_fees: 1.5, total_tax: 3.11, grand_total: 34.56, location_total: 100.01, fees: [] });
    }
    const r = await reconcileRevenue({ ...OPTS, invoiceCadRate: 0.725 });

    expect(r.canadian.convertedOwed).toEqual({ rows: 2, cad: 200.02, usdAtBookingRates: 145.02 });
    expect(r.reslab.canadianInvoice?.exchangeDifference).toBe(0);
    // The invoice itself is ResLab's one conversion of the total.
    expect(r.reslab.canadianInvoice?.usd).toBe(145.01);
    // A different rate still shows: each row at 0.72 is 7200.72 → 7201; 2 × (7201 − 7251) = −100.
    expect((await reconcileRevenue({ ...OPTS, invoiceCadRate: 0.72 })).reslab.canadianInvoice?.exchangeDifference).toBe(-1);
  });

  it("no exchange difference when ResLab's rate is the booking's rate, whatever the cents", async () => {
    // Location C$33.33 + fee C$0.67 at 0.725: converted separately the two round to 24.16 + 0.49 = 24.65;
    // as one amount C$34.00 → 24.65. Three such rows must not show a rounding cent as an exchange effect.
    for (const n of ["CA1", "CA2", "CA3"]) {
      row(n, { grand_total: 25.05, subtotal: 21.71, reslab_currency: "CAD", fx_rate: "0.725000" });
      pi(n, 3100);
      reservation(n, { ...CAD_HISTORY, subtotal: 29.95, total_fees: 1.5, total_tax: 3.11, grand_total: 34.56, location_total: 33.33, fees: [{ fee_type: "channel_fee", dollar_amount: 0.67 }] });
    }
    const r = await reconcileRevenue({ ...OPTS, invoiceCadRate: 0.725 });

    expect(r.canadian.convertedOwed).toEqual({ rows: 3, cad: 102, usdAtBookingRates: 73.95 });
    expect(r.reslab.canadianInvoice).toEqual({ basis: "invoice_rate", usd: 73.95, exchangeDifference: 0, unpriced: 0 });
  });

  it("prices the invoice in whole cents, half-up: C$41.40 at 0.725 is US$30.02, not 30.01", async () => {
    // 4140 × 0.725 = 3001.5 cents. Floating-point dollars round it down.
    converted("CA1", {}, { ...CAD_HISTORY, location_total: 41.4, fees: [] });
    const r = await reconcileRevenue({ ...OPTS, invoiceCadRate: 0.725 });

    expect(r.canadian.convertedOwed.cad).toBe(41.4);
    expect(r.reslab.canadianInvoice?.usd).toBe(30.02);
    // The booking-rate side is one conversion of the same total: 4140 × 0.75 = 3105.
    expect(r.canadian.convertedOwed.usdAtBookingRates).toBe(31.05);
    // 41.40 at the booking's 0.75 is 31.05.
    expect(r.reslab.canadianInvoice?.exchangeDifference).toBe(-1.03);
  });

  it.each([1.38, 1, 0.5, 0.4, 0, -0.72, Number.NaN, 0.7212345])("refuses the invoice rate %s before reading anything", async (bad) => {
    converted();
    await expect(reconcileRevenue({ ...OPTS, invoiceCadRate: bad })).rejects.toThrow("invoiceCadRate must be above 0.5 and below 1");
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
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

  it("reports a booking two cents off its stamped rate (one cent is the check's tolerance)", async () => {
    converted("CA1", { grand_total: 92.27 });
    const r = await reconcileRevenue(OPTS);

    expect(r.reslab.grandTotalMismatches).toHaveLength(1);
    expect(r.reslab.grandTotalMismatches[0]).toMatchObject({ resNum: "CA1", supabase: 92.27, reslab: 92.25 });
    expect(r.reslab.grandTotalMismatches[0].note).toBe("ResLab C$123.00 at the booking's rate 0.750000");
  });

  it("reports parts that do not add up, even when the single total happens to match", async () => {
    converted("CA1", {}, { ...CAD_HISTORY, total_tax: 12 }); // 100 + 10 + 12 ≠ 123
    const r = await reconcileRevenue(OPTS);

    expect(r.reslab.grandTotalMismatches).toHaveLength(1);
    expect(r.reslab.grandTotalMismatches[0].note).toBe("ResLab's Canadian parts do not convert at the booking's rate 0.750000");
    // The settlement figures still convert: the row stays in the totals.
    expect(r.triplyNet.total).toBeCloseTo(17.95, 10);
  });

  it("accepts ResLab figures sent as strings", async () => {
    converted("CA1", {}, { ...CAD_HISTORY, location_total: "95.00", channel_total: "20.00", subtotal: "100.00", grand_total: "123.00", total_fees: "10.00", total_tax: "13.00" });
    const r = await reconcileRevenue(OPTS);

    expect(r.bookings[0].reslab_location_total).toBe(71.25);
    expect(r.bookings[0].fx?.grand_total_cad).toBe(123);
    expect(r.reslab.grandTotalMismatches).toEqual([]);
  });

  it("is still converted when ResLab states no currency: the row is the witness", async () => {
    const noCurrency: Record<string, unknown> = { ...CAD_HISTORY };
    delete noCurrency.location;
    converted("CA1", {}, noCurrency);
    const r = await reconcileRevenue(OPTS);

    expect(r.canadian.converted).toBe(1);
    expect(r.bookings[0].reslab_channel_total).toBe(15);
  });

  it("a reservation with nothing due at the lot stated at all is read as 0 due, like fulfilment", async () => {
    const noDue: Record<string, unknown> = { ...CAD_HISTORY };
    delete noDue.due_at_location_total;
    converted("CA1", {}, noDue);
    const r = await reconcileRevenue(OPTS);

    expect(r.canadian.faults).toBe(0);
    expect(r.bookings[0].reslab_location_total).toBe(71.25);
  });

  it("an unreadable commissions or refund figure is unknown, and so is the period's commissions total: never $0", async () => {
    converted("CA1", {}, { ...CAD_HISTORY, refund_amount: -5, commissions_total: 75.123 });
    const r = await reconcileRevenue(OPTS);

    expect(r.bookings[0].reslab_refund_amount).toBeNull();
    expect(r.bookings[0].reslab_commissions_total).toBeNull();
    expect(r.bookings[0].fx?.commissions_total_cad).toBeNull();
    expect(r.confirmed.commissionsTotal).toBeNull();
    // Triply's keep does not use it.
    expect(r.canadian.faults).toBe(0);
    expect(r.triplyNet.total).toBeCloseTo(17.95, 10);
  });

  it("refunded, with ResLab's history zeroed: no mismatch, nothing owed, fee kept", async () => {
    converted("CA1", { status: "refunded" }, { ...CAD_HISTORY, grand_total: 0, location_total: 0, channel_total: 0 });
    h.reservations.set("CA1", { ...(h.reservations.get("CA1") as object), cancelled: 1 });
    pi("CA1", 9820, 9225);
    const r = await reconcileRevenue(OPTS);

    expect(r.reslab.grandTotalMismatches).toEqual([]);
    expect(r.canadian.convertedOwed).toEqual({ rows: 0, cad: 0, usdAtBookingRates: 0 });
    expect(r.reslab.canadianInvoice?.unpriced).toBe(0);
    expect(r.triplyNet.total).toBeCloseTo(5.95, 10);
  });

  it("part due at the lot: owed is the location total less what the lot collects, in both currencies", async () => {
    // C$20 of the C$123 is paid at the lot: US$15 at 0.75. The card paid 92.25 − 15 + 5.95.
    row("CA1", { grand_total: 92.25, subtotal: 75, due_at_location: 15, reslab_currency: "CAD", fx_rate: "0.750000" });
    pi("CA1", 8320);
    reservation("CA1", { ...CAD_HISTORY, due_at_location_total: 20 });
    const r = await reconcileRevenue(OPTS);
    const b = r.bookings[0];

    expect(b.reslab_location_total).toBe(56.25); // (95 − 20) × 0.75
    expect(b.fx).toMatchObject({ location_total_cad: 75, due_at_location_cad: 20 });
    expect(r.confirmed.locationTotalOwed).toBe(56.25);
    expect(r.confirmed.reslabDueAtLot).toBe(15);
    expect(r.canadian.convertedOwed).toEqual({ rows: 1, cad: 79, usdAtBookingRates: 59.25 }); // C$75 + C$4
    expect(r.integrity.parkingFlowMismatches).toEqual([]);
    expect(r.integrity.chargeMismatches).toEqual([]);
    expect(r.reslab.grandTotalMismatches).toEqual([]);
  });

  it("a partial refund ResLab reports is converted too", async () => {
    converted("CA1", {}, { ...CAD_HISTORY, partial_refund: 10, refund_amount: 10 });
    const r = await reconcileRevenue(OPTS);

    expect(r.bookings[0].reslab_partial_refund).toBe(7.5);
    expect(r.bookings[0].reslab_refund_amount).toBe(7.5);
  });

  it("confirmed by us but cancelled at ResLab: ResLab bills no fee, so none comes off the estimate", async () => {
    converted();
    h.reservations.set("CA1", { ...(h.reservations.get("CA1") as object), cancelled: 1 });
    const r = await reconcileRevenue(OPTS);

    expect(r.canadian.keepEstimate).toBe(15);
    expect(r.triplyNet.total).toBeCloseTo(20.95, 10);
    expect(r.canadian.convertedOwed.rows).toBe(0);
  });

  it("a disputed booking ResLab has not cancelled is still billed", async () => {
    converted("CA1", { status: "disputed" });
    const r = await reconcileRevenue(OPTS);

    expect(r.canadian.convertedOwed).toEqual({ rows: 1, cad: 99, usdAtBookingRates: 74.25 });
    expect(r.canadian.confirmedConverted).toBe(0);
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
    expect(r.canadian.billedFaults).toBe(0);
    expect(r.canadian.reservations).toEqual([
      { resNum: "OLD1", kind: "no_rate_legacy", reason: "booked before conversion: charged the Canadian figure one-for-one" },
    ]);
    expect(r.canadian.legacyOwed).toEqual({ rows: 1, cad: 99 });
    expect(r.canadian.convertedOwed).toEqual({ rows: 0, cad: 0, usdAtBookingRates: 0 });

    // Nothing of ResLab's CAD reaches a US-dollar figure.
    expect(old?.reslab_location_total).toBeNull();
    expect(old?.reslab_channel_total).toBeNull();
    expect(old?.triply_total).toBeNull();
    expect(old?.fx).toEqual({
      kind: "no_rate_legacy",
      rate: null,
      location_total_cad: 95,
      due_at_location_cad: 0,
      channel_fee_cad: 4,
      channel_total_cad: 20,
      commissions_total_cad: 75,
      grand_total_cad: 123,
    });
    expect(r.reslab.sumAmountOwed).toBe(86);
    expect(r.confirmed.channelTotal).toBe(18);
    expect(r.confirmed.locationTotalOwed).toBe(82);

    // The headline is a figure: the US row in full, the old row's service fee only.
    expect(r.reslab.dataIncomplete).toBe(false);
    expect(r.reslab.confirmedExpected).toBe(1);
    expect(r.reslab.fetched).toBe(1);
    expect(r.triplyNet.total).toBeCloseTo(18 - 4 + 5.95 + 5.95, 10);
    expect(r.triplyNet.canadianLeftOut).toBe(1);

    // The lot commission across confirmed bookings is not known without its ResLab side.
    expect(r.confirmed.commissionsTotal).toBeNull();
    // Its Stripe parking (128.95 − 5.95) IS in what Stripe collected, so "how
    // customers paid" still adds up to the parking value; the page takes it
    // out of "net parking cash". It is out of both sides of the take rates.
    expect(r.grossRevenue).toBe(223);
    expect(r.confirmed.stripeParkingCollected).toBe(223);
    expect(r.canadian.leftOutConfirmed).toBe(1);
    expect(r.canadian.leftOutStripeParking).toBe(123);
    expect(r.takeRates.stripeTakeRate).toBeCloseTo(19.95 / 105.95, 10);

    // It was charged the Canadian figure, so the raw comparison holds.
    expect(r.reslab.grandTotalMismatches).toEqual([]);
  });

  it("without ResLab's rate the invoice comparison is withheld, never shown short", async () => {
    us();
    legacy();
    const r = await reconcileRevenue({ ...OPTS, invoiceAmount: 157.28 });

    expect(r.reslab.canadianInvoice).toEqual({ basis: "booking_rates", usd: 0, exchangeDifference: null, unpriced: 1 });
    expect(r.reslab.varianceInclCanadian).toBeNull();
    // The US-only figure is still there under its own name.
    expect(r.reslab.variance).toBeCloseTo(86 - 157.28, 10);
  });

  it("ResLab's invoice rate prices what is owed for it", async () => {
    us();
    legacy();
    const r = await reconcileRevenue({ ...OPTS, invoiceAmount: 157.28, invoiceCadRate: 0.72 });

    // C$99 × 0.72 = 71.28, + US$86.
    expect(r.reslab.canadianInvoice).toEqual({ basis: "invoice_rate", usd: 71.28, exchangeDifference: 0, unpriced: 0 });
    expect(r.reslab.varianceInclCanadian).toBeCloseTo(0, 10);
    // Entering the rate does not bring the row back into Triply's keep.
    expect(r.triplyNet.total).toBeCloseTo(18 - 4 + 5.95 + 5.95, 10);
  });

  it("part due at the lot: only the rest is owed", async () => {
    legacy("OLD1", { due_at_location: 20 });
    pi("OLD1", 10895); // 123 − 20 + 5.95
    reservation("OLD1", { ...CAD_HISTORY, due_at_location_total: 20 });
    const r = await reconcileRevenue({ ...OPTS, invoiceCadRate: 0.72 });

    expect(r.canadian.legacyOwed).toEqual({ rows: 1, cad: 79 });
    expect(r.bookings[0].fx).toMatchObject({ location_total_cad: 75, due_at_location_cad: 20 });
    expect(r.reslab.canadianInvoice?.usd).toBe(56.88); // C$79 × 0.72
  });

  it("the same booking after the data fix (marked CAD at rate 1)", async () => {
    legacy("OLD1", { reslab_currency: "CAD", fx_rate: "1.000000" });
    const r = await reconcileRevenue(OPTS);

    expect(r.canadian.noRateLegacy).toBe(1);
    expect(r.canadian.faults).toBe(0);
    expect(r.bookings[0].fx?.kind).toBe("no_rate_legacy");
    expect(r.triplyNet.total).toBeCloseTo(5.95, 10);
    expect(r.takeRates.stripeTakeRate).toBeNull(); // nothing left to measure
  });

  it("refunded by us but not cancelled at ResLab: still billed, and the row says so for the page's warning", async () => {
    legacy("OLD1", { status: "refunded" });
    pi("OLD1", 12895, 12300);
    const r = await reconcileRevenue(OPTS);

    expect(r.canadian.legacyOwed).toEqual({ rows: 1, cad: 99 });
    expect(r.bookings[0]).toMatchObject({ status: "refunded", reslab_cancelled: false, reslab_location_total: null });
    expect(r.bookings[0].fx?.location_total_cad).toBe(95);
    // ResLab's figure does not match a refund: reported.
    expect(r.reslab.grandTotalMismatches).toHaveLength(0);
  });

  it("cancelled at ResLab: not billed, with or without the invoice rate", async () => {
    legacy("OLD1", { status: "refunded" });
    h.reservations.set("OLD1", { ...(h.reservations.get("OLD1") as object), cancelled: 1 });
    const r = await reconcileRevenue({ ...OPTS, invoiceCadRate: 0.72 });

    expect(r.canadian.legacyOwed).toEqual({ rows: 0, cad: 0 });
    expect(r.reslab.canadianInvoice).toEqual({ basis: "invoice_rate", usd: 0, exchangeDifference: 0, unpriced: 0 });
    expect(r.bookings[0].reslab_cancelled).toBe(true);
    expect(r.reslab.grandTotalMismatches).toEqual([]);
    expect((await reconcileRevenue(OPTS)).reslab.canadianInvoice?.unpriced).toBe(0);
  });

  it("reports Stripe refunds on a confirmed Canadian booking; unknown when Stripe did not answer", async () => {
    legacy();
    pi("OLD1", 12895, 3432);
    expect((await reconcileRevenue(OPTS)).canadian.stripeRefunded).toBe(34.32);

    h.pis.delete("pi_OLD1");
    expect((await reconcileRevenue(OPTS)).canadian.stripeRefunded).toBeNull();
    expect((await reconcileRevenue({ ...OPTS, includeStripe: false })).canadian.stripeRefunded).toBeNull();
  });

  it("a row whose charge was not the Canadian figure is still a mismatch", async () => {
    legacy("OLD1", { grand_total: 120 });
    const r = await reconcileRevenue(OPTS);

    expect(r.reslab.grandTotalMismatches).toEqual([
      { resNum: "OLD1", supabase: 120, reslab: 123, diff: -3, note: "ResLab figure is Canadian dollars, compared one-for-one" },
    ]);
  });

  it("a left-out row with Park Guard and a promo: exactly its keep leaves the take rate", async () => {
    us();
    legacy("OLD1", { protection_plan: "Plan A", protection_plan_price: 12.99, protection_plan_wholesale: 6, discount_amount: 5 });
    pi("OLD1", 13694); // 123 + 5.95 + 12.99 − 5
    const r = await reconcileRevenue(OPTS);

    // Only the US row is measured: (18 − 4 + 5.95) ÷ 105.95.
    expect(r.takeRates.stripeTakeRate).toBeCloseTo(19.95 / 105.95, 10);
    expect(r.takeRates.totalTakeRate).toBeCloseTo(19.95 / 105.95, 10);
    // Fees: 300 per payment in the fixture; only the US row's counts.
    expect(r.takeRates.netStripeTakeRate).toBeCloseTo((19.95 - 3) / 105.95, 10);
  });
});

describe("a currency fault withholds the headline and is in no figure", () => {
  const unreadable = "a ResLab settlement figure is missing or could not be read";
  const without = (key: string) => {
    const hist: Record<string, unknown> = { ...CAD_HISTORY };
    delete hist[key];
    return hist;
  };
  // [name, arrange, kind, reason, the rate the row's fx reports]
  const faultCases: Array<[string, () => void, string, string, string | null]> = [
    [
      "an unmarked Canadian reservation booked after conversion went live",
      () => {
        row("BAD");
        pi("BAD", 10595);
        reservation("BAD", CAD_HISTORY);
      },
      "no_rate",
      "ResLab reports CAD but the booking is not marked as converted",
      null,
    ],
    ["a row marked CAD that ResLab says is US dollars", () => converted("BAD", {}, { ...CAD_HISTORY, ...USD }), "conflict", "the booking is marked CAD but ResLab reports USD", "0.750000"],
    [
      "a third currency",
      () => {
        row("BAD");
        pi("BAD", 10595);
        reservation("BAD", { ...CAD_HISTORY, location: { currency: { code: "eur " } } });
      },
      "conflict",
      "ResLab reports EUR",
      null,
    ],
    ["a rate that cannot be read", () => converted("BAD", { fx_rate: null }), "no_rate", "the booking's rate cannot be read", null],
    ["rate 1 on a booking made after conversion went live", () => converted("BAD", { fx_rate: 1 }), "no_rate", "marked at rate 1 after conversion went live", null],
    ["a settlement figure that is not whole cents", () => converted("BAD", {}, { ...CAD_HISTORY, channel_total: 20.005 }), "no_rate", unreadable, "0.750000"],
    ["a negative settlement figure", () => converted("BAD", {}, { ...CAD_HISTORY, location_total: -1 }), "no_rate", unreadable, "0.750000"],
    ["no channel_total in ResLab's answer", () => converted("BAD", {}, without("channel_total")), "no_rate", unreadable, "0.750000"],
    ["no location_total in ResLab's answer", () => converted("BAD", {}, without("location_total")), "no_rate", unreadable, "0.750000"],
    ["no subtotal in ResLab's answer", () => converted("BAD", {}, without("subtotal")), "no_rate", unreadable, "0.750000"],
    ["a null settlement figure", () => converted("BAD", {}, { ...CAD_HISTORY, channel_total: null }), "no_rate", unreadable, "0.750000"],
    ["text where a settlement figure belongs", () => converted("BAD", {}, { ...CAD_HISTORY, location_total: "n/a" }), "no_rate", unreadable, "0.750000"],
    ["an unreadable amount due at the lot", () => converted("BAD", {}, { ...CAD_HISTORY, due_at_location_total: "x" }), "no_rate", unreadable, "0.750000"],
    ["no grand total at all", () => converted("BAD", {}, without("grand_total")), "no_rate", unreadable, "0.750000"],
    ["a grand total that is not whole cents", () => converted("BAD", {}, { ...CAD_HISTORY, grand_total: 123.005 }), "no_rate", unreadable, "0.750000"],
    ["a subtotal that is not whole cents", () => converted("BAD", {}, { ...CAD_HISTORY, subtotal: 100.005 }), "no_rate", unreadable, "0.750000"],
    ["an amount due at the lot that is not whole cents", () => converted("BAD", {}, { ...CAD_HISTORY, due_at_location_total: 20.005 }), "no_rate", unreadable, "0.750000"],
    ["a negative ResLab fee line", () => converted("BAD", {}, { ...CAD_HISTORY, fees: [{ fee_type: "channel_fee", dollar_amount: -4 }] }), "no_rate", unreadable, "0.750000"],
    ["a ResLab fee line with no amount", () => converted("BAD", {}, { ...CAD_HISTORY, fees: [{ fee_type: "channel_fee", dollar_amount: null }] }), "no_rate", unreadable, "0.750000"],
    ["text in a ResLab fee line", () => converted("BAD", {}, { ...CAD_HISTORY, fees: [{ fee_type: "channel_fee", dollar_amount: 4 }, { fee_type: "channel_fee", dollar_amount: "n/a" }] }), "no_rate", unreadable, "0.750000"],
    ["a fee list that is not a list", () => converted("BAD", {}, { ...CAD_HISTORY, fees: { fee_type: "channel_fee", dollar_amount: 4 } }), "no_rate", unreadable, "0.750000"],
    ["a fee line that does not say what it is", () => converted("BAD", {}, { ...CAD_HISTORY, fees: [{ dollar_amount: 4 }] }), "no_rate", unreadable, "0.750000"],
    ["a ResLab fee line that is not whole cents", () => converted("BAD", {}, { ...CAD_HISTORY, fees: [{ fee_type: "channel_fee", dollar_amount: 4.004 }] }), "no_rate", unreadable, "0.750000"],
    [
      "an old booking whose ResLab total cannot be read",
      () => {
        legacy("BAD");
        reservation("BAD", { ...CAD_HISTORY, grand_total: "n/a" });
      },
      "no_rate",
      unreadable,
      null,
    ],
    [
      "an old booking with an unreadable settlement figure",
      () => {
        legacy("BAD");
        reservation("BAD", without("location_total"));
      },
      "no_rate",
      unreadable,
      null,
    ],
  ];

  it.each(faultCases)("%s", async (_name, arrange, kind, reason, rate) => {
    us();
    arrange();
    const r = await reconcileRevenue({ ...OPTS, invoiceAmount: 100, invoiceCadRate: 0.72 });

    expect(r.canadian.faults).toBe(1);
    expect(r.canadian.noRateLegacy).toBe(0);
    expect(r.canadian.converted).toBe(0);
    expect(r.canadian.billedFaults).toBe(1);
    expect(r.canadian.reservations).toEqual([{ resNum: "BAD", kind, reason }]);
    expect(r.reslab.dataIncomplete).toBe(true);
    expect(r.triplyNet.total).toBeNull();
    expect(r.triplyNet.totalReason).toBe(
      "missing ResLab data for 1 of 2 confirmed bookings (1 with a currency problem: see Canadian lots)"
    );
    expect(r.takeRates.stripeTakeRate).toBeNull();

    // In no sum, in either currency, with or without ResLab's rate.
    expect(r.reslab.sumAmountOwed).toBe(86);
    expect(r.confirmed.channelTotal).toBe(18);
    expect(r.canadian.convertedOwed).toEqual({ rows: 0, cad: 0, usdAtBookingRates: 0 });
    expect(r.canadian.legacyOwed).toEqual({ rows: 0, cad: 0 });
    expect(r.canadian.keepEstimate).toBe(0);
    expect(r.reslab.canadianInvoice).toEqual({ basis: "invoice_rate", usd: 0, exchangeDifference: 0, unpriced: 1 });
    // ResLab bills it and it is in no figure: no variance is claimed.
    expect(r.reslab.varianceInclCanadian).toBeNull();

    const bad = r.bookings.find((b) => b.reslab_reservation_number === "BAD");
    expect(bad?.reslab_channel_total).toBeNull();
    expect(bad?.reslab_location_total).toBeNull();
    expect(bad?.triply_total).toBeNull();
    expect(bad?.fx).toEqual({
      kind,
      rate,
      location_total_cad: null,
      due_at_location_cad: null,
      channel_fee_cad: null,
      channel_total_cad: null,
      commissions_total_cad: null,
      grand_total_cad: null,
    });
    expect(bad?.note).toContain(`ResLab side left out: ${reason}`);
  });

  it.each([
    ["a 503", { __httpStatus: 503 }, "ResLab 503 on BAD"],
    ["an empty history", { cancelled: 0, history: [] }, "no history[0] in response"],
  ])("a marked Canadian booking ResLab cannot be read for (%s) is not priced, and says so", async (_name, answer, error) => {
    us();
    converted("BAD");
    h.reservations.set("BAD", answer);
    const r = await reconcileRevenue({ ...OPTS, invoiceAmount: 86 });

    // Without this the invoice would look matched to the cent with the booking missing.
    expect(r.reslab.canadianInvoice).toEqual({ basis: "booking_rates", usd: 0, exchangeDifference: null, unpriced: 1 });
    expect(r.reslab.varianceInclCanadian).toBeNull();
    expect(r.canadian.reservations).toEqual([
      { resNum: "BAD", kind: "unread", reason: "ResLab could not be read for this Canadian booking: run the report again" },
    ]);
    // A failed read is not a currency problem, and nothing says ResLab bills it.
    expect(r.canadian.unread).toBe(1);
    expect(r.canadian.faults).toBe(0);
    expect(r.canadian.billedFaults).toBe(0);
    expect(r.triplyNet.total).toBeNull();
    expect(r.triplyNet.totalReason).toBe("missing ResLab data for 1 of 2 confirmed bookings");
    // With ResLab's rate entered it is still unpriced.
    expect((await reconcileRevenue({ ...OPTS, invoiceAmount: 86, invoiceCadRate: 0.72 })).reslab.varianceInclCanadian).toBeNull();
    // Its Stripe parking has nothing owed to set against: out of net parking cash and the take rates.
    expect(r.canadian.leftOutConfirmed).toBe(1);
    expect(r.canadian.leftOutStripeParking).toBeCloseTo(92.25, 10);
    const bad = r.bookings.find((b) => b.reslab_reservation_number === "BAD");
    expect(bad?.fx).toMatchObject({ kind: "unread", rate: "0.750000", location_total_cad: null });
    expect(bad?.reslab_error).toBe(error);
    expect(r.reslab.fetchErrors.map((e) => e.resNum)).toEqual(["BAD"]);
  });

  it("an unmarked US booking ResLab cannot be read for is exactly as before: not Canadian", async () => {
    us();
    h.reservations.set("US1", { __httpStatus: 503 });
    const r = await reconcileRevenue(OPTS);

    expect(r.canadian.reservations).toEqual([]);
    expect(r.reslab.canadianInvoice?.unpriced).toBe(0);
    expect(r.bookings[0].fx).toBeUndefined();
  });

  it("a fault on a refunded booking is reported but does not take the blame for missing confirmed data", async () => {
    us();
    h.reservations.set("US1", { __httpStatus: 503 });
    converted("BAD", { status: "refunded" }, { ...CAD_HISTORY, ...USD });
    const r = await reconcileRevenue(OPTS);

    expect(r.canadian.faults).toBe(1);
    expect(r.triplyNet.totalReason).toBe("missing ResLab data for 1 of 1 confirmed bookings");
  });

  it("a fault ResLab has cancelled is not billed, so it does not withhold the invoice comparison", async () => {
    us();
    converted("BAD", { status: "refunded" }, { ...CAD_HISTORY, ...USD });
    h.reservations.set("BAD", { ...(h.reservations.get("BAD") as object), cancelled: 1 });
    const r = await reconcileRevenue({ ...OPTS, invoiceAmount: 86 });

    expect(r.canadian.faults).toBe(1);
    expect(r.canadian.billedFaults).toBe(0);
    expect(r.reslab.varianceInclCanadian).toBeCloseTo(0, 10);
  });
});

describe("with the ResLab cross-check off", () => {
  it("a marked row has no ResLab figures to convert and nothing is claimed", async () => {
    converted();
    const r = await reconcileRevenue({ ...OPTS, includeReslab: false });

    expect(r.canadian.reservations).toEqual([]);
    expect(r.triplyNet.total).toBeNull();
    expect(r.reslab.canadianInvoice).toBeNull();
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

  it("legacy = booked before conversion went live AND unmarked or marked at rate 1", () => {
    expect(classifyRowCurrency({ created_at: before }, "CAD")).toMatchObject({ kind: "cad_no_rate", legacy: true });
    expect(classifyRowCurrency({ created_at: after }, "CAD")).toMatchObject({ kind: "cad_no_rate", legacy: false });
    expect(classifyRowCurrency({ created_at: CONVERSION_LIVE_FROM }, "CAD")).toMatchObject({ legacy: false });
    expect(classifyRowCurrency({ created_at: "2026-11-16T23:59:59.999Z" }, "CAD")).toMatchObject({ legacy: true });
    expect(classifyRowCurrency({ created_at: "not a date" }, "CAD")).toMatchObject({ kind: "cad_no_rate", legacy: false });
    expect(classifyRowCurrency({ created_at: before, reslab_currency: "CAD", fx_rate: 1 }, "CAD")).toMatchObject({ kind: "cad_no_rate", legacy: true });
    expect(classifyRowCurrency({ created_at: before, reslab_currency: "CAD", fx_rate: "1.000000" }, null)).toMatchObject({ kind: "cad_no_rate", legacy: true });
    // An unreadable rate is never legacy, however old the row.
    expect(classifyRowCurrency({ created_at: before, reslab_currency: "CAD", fx_rate: "0.4" }, "CAD")).toMatchObject({ kind: "cad_no_rate", legacy: false });
    expect(classifyRowCurrency({ created_at: before, reslab_currency: "CAD", fx_rate: null }, "CAD")).toMatchObject({ kind: "cad_no_rate", legacy: false });
  });

  it("any disagreement is a conflict", () => {
    expect(classifyRowCurrency({ created_at: after, reslab_currency: "CAD", fx_rate: "0.75" }, "USD").kind).toBe("conflict");
    expect(classifyRowCurrency({ created_at: after, reslab_currency: "EUR", fx_rate: "0.75" }, "CAD").kind).toBe("conflict");
    expect(classifyRowCurrency({ created_at: before }, "MXN").kind).toBe("conflict");
  });

  it("one mapping to the kind the result and the page report", () => {
    expect(canadianKindOf({ kind: "usd" })).toBeNull();
    expect(canadianKindOf(classifyRowCurrency({ created_at: after, reslab_currency: "CAD", fx_rate: "0.75" }, "CAD"))).toBe("converted");
    expect(canadianKindOf(classifyRowCurrency({ created_at: before }, "CAD"))).toBe("no_rate_legacy");
    expect(canadianKindOf(classifyRowCurrency({ created_at: after }, "CAD"))).toBe("no_rate");
    expect(canadianKindOf(classifyRowCurrency({ created_at: after }, "EUR"))).toBe("conflict");
    expect(canadianKindOf({ kind: "cad_no_rate", legacy: false, unread: true, reason: "x" })).toBe("unread");
    expect((["converted", "no_rate_legacy", "no_rate", "conflict", "unread"] as const).map((k) => isCurrencyFault(k))).toEqual([false, false, true, true, false]);
  });
});
