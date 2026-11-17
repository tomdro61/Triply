/**
 * Direct-lot bookings in the accounting report: one booking's figures
 * (`resolveDirectRow`), the totals, and the reads against the shared Supabase fake.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { PayoutStripeRead } from "@/lib/direct/payout-stripe";
import type { LinesSummary } from "@/lib/direct/payout-statement";

const { db } = await vi.hoisted(async () => {
  const { FakeSupabase } = await import("@/lib/booking/__tests__/supabase-fake");
  return { db: new FakeSupabase() };
});
vi.mock("@/lib/supabase/server", () => ({ createAdminClient: async () => db }));

import { buildDirectDetail, directTotals, resolveDirectRow, type DirectRowInput } from "../direct-detail";

// 4 days × $9.95 = $39.80 parking, 16 % tax $6.37, fee $5.95 → $52.12 charged. Lot: 80 % + tax = $38.21.
const row = (o: Partial<DirectRowInput> = {}): DirectRowInput => ({
  id: "b1",
  reslab_reservation_number: "TRP-AAAA1111",
  status: "confirmed",
  check_in: "2026-10-20T10:00:00",
  check_out: "2026-10-24T10:00:00",
  location_name: "Test Lot JFK",
  stripe_payment_intent_id: "pi_1",
  direct_lot_id: "1",
  livemode: true,
  subtotal: "39.80",
  triply_service_fee: "5.95",
  protection_plan_wholesale: null,
  ...o,
});
const extra = (o: Record<string, unknown> = {}) => ({
  id: "b1",
  cancel_state: null as string | null,
  cancel_claimed_at: null as string | null,
  location_timezone: "America/New_York",
  lot_snapshot: null,
  tax_total: "6.37",
  ...o,
});
const terms = (o: Record<string, unknown> = {}) => ({
  stripe_payment_intent_id: "pi_1",
  direct_lot_id: "1",
  livemode: true,
  partner_share_percent: "80.00",
  tax_collected_by: "lot",
  ...o,
});
const read = (o: Partial<PayoutStripeRead> = {}): PayoutStripeRead => ({
  error: null, amountReceivedCents: 5212, amountRefundedCents: 0, piStatus: "succeeded", disputed: false, disputes: "", feeCents: 181, ...o,
});
const paid = (o: Partial<LinesSummary> = {}): LinesSummary => ({ hasPayout: true, sumCents: 3821, count: 1, lastPersonBasis: null, ...o });
const selfCancelled = { cancel_state: "refund_issued", cancel_claimed_at: "2026-10-19T12:00:00Z" };
const resolve = (p: {
  b?: Partial<DirectRowInput>; x?: Record<string, unknown> | null; t?: Record<string, unknown> | null; lines?: LinesSummary; s?: PayoutStripeRead | null;
} = {}) =>
  resolveDirectRow(
    row(p.b),
    p.x === null ? undefined : extra(p.x),
    p.t === null ? undefined : terms(p.t),
    p.lines,
    p.s === undefined ? read() : p.s,
    "payment not read from Stripe"
  );

describe("resolveDirectRow", () => {
  it("a confirmed, unpaid booking: owed by the rule, gross before and net after the Stripe fee", () => {
    expect(resolve()).toMatchObject({
      state: "ok", reason: null, receivedCents: 5212, refundedCents: 0,
      owedToLotCents: 3821, owedSource: "rule", stripeFeeCents: 181, grossCents: 1391, netCents: 1210,
      checkOut: "2026-10-24 10:00:00", lotName: "Test Lot JFK",
    });
  });

  it("a booking already paid to the lot uses what the ledger recorded", () => {
    // Paid $30.00 by an automatic line; the rule says $38.21 now, so it is an adjustment candidate.
    expect(resolve({ lines: paid({ sumCents: 3000 }) })).toMatchObject({ state: "adjustment_pending", owedToLotCents: 3000, owedSource: "ledger", netCents: null, grossCents: null });
    // Paid exactly what the rule says: settled.
    expect(resolve({ lines: paid() })).toMatchObject({ state: "ok", owedToLotCents: 3821, owedSource: "ledger", netCents: 1210, grossCents: 1391 });
  });

  it("a self-cancel refunded in full: Triply is out the Stripe fee", () => {
    const r = resolve({ b: { status: "refunded" }, x: selfCancelled, s: read({ amountRefundedCents: 5212 }) });
    expect(r).toMatchObject({ state: "ok", owedToLotCents: 0, owedSource: "rule", refundedCents: 5212, netCents: -181, grossCents: 0 });
  });

  it("refunded after the lot was paid: an adjustment is pending, no figure", () => {
    const r = resolve({ b: { status: "refunded" }, x: selfCancelled, s: read({ amountRefundedCents: 5212 }), lines: paid() });
    expect(r).toMatchObject({ state: "adjustment_pending", reason: "refunded or cancelled after payment", owedToLotCents: 3821, netCents: null, grossCents: null });
  });

  it("a released hold (nothing received, Stripe says refunded): $0 everywhere, no fee needed", () => {
    const r = resolve({ b: { status: "refunded" }, x: selfCancelled, s: read({ amountReceivedCents: 0, amountRefundedCents: 5212, piStatus: "canceled", feeCents: null }) });
    expect(r).toMatchObject({ state: "ok", receivedCents: 0, refundedCents: 0, stripeFeeCents: 0, owedToLotCents: 0, netCents: 0, grossCents: 0 });
  });

  it("a row only a person can decide has no figure", () => {
    const r = resolve({ s: read({ amountRefundedCents: 500 }) });
    expect(r).toMatchObject({ state: "needs_decision", reason: "partially refunded while still confirmed", owedToLotCents: null, netCents: null, grossCents: null, receivedCents: 5212, refundedCents: 500 });
  });

  it("Stripe not read: no figure and no estimate", () => {
    expect(resolve({ s: null })).toMatchObject({ state: "not_read", reason: "payment not read from Stripe", receivedCents: null, netCents: null, grossCents: null, owedToLotCents: null });
    const failed = read({ error: "read failed (StripeConnectionError)", amountReceivedCents: null, amountRefundedCents: null, piStatus: null, disputed: null, disputes: null, feeCents: null });
    expect(resolve({ s: failed })).toMatchObject({ state: "not_read", reason: "Stripe could not be read (read failed (StripeConnectionError))", netCents: null });
  });

  it("an unknown Stripe fee gives no figure, never a fee of $0", () => {
    expect(resolve({ s: read({ feeCents: null }) })).toMatchObject({ state: "no_figure", owedToLotCents: 3821, netCents: null, grossCents: null, stripeFeeCents: null });
  });

  it("no PaymentIntent, no terms, or a ledger without a payout line: blocked", () => {
    expect(resolve({ b: { stripe_payment_intent_id: null } })).toMatchObject({ state: "blocked", reason: "no PaymentIntent on the booking" });
    expect(resolve({ t: null })).toMatchObject({ state: "blocked", reason: "no terms row for this booking", receivedCents: 5212 });
    expect(resolve({ x: null })).toMatchObject({ state: "blocked" });
    expect(resolve({ lines: paid({ hasPayout: false, sumCents: -100 }) })).toMatchObject({ state: "blocked", netCents: null });
  });

  it("tax Triply remits comes off (a liability, not revenue)", () => {
    // Lot is owed 80 % of 3980 = 3184, no tax: 5212 − 3184 − 637 tax − 181 fee.
    expect(resolve({ t: { tax_collected_by: "triply" } })).toMatchObject({ owedToLotCents: 3184, netCents: 1210, grossCents: 1391 });
  });

  describe("a booking a person decided, unchanged since", () => {
    const decidedBasis = (r: ReturnType<typeof resolve>, s: PayoutStripeRead, x: Record<string, unknown>, status: string, tax = "lot") => ({
      // The basis classifyPayout stores, rebuilt here from the same inputs.
      subtotalCents: 3980, taxCents: 637, shareBp: 8000, taxCollectedBy: tax,
      amountReceivedCents: s.amountReceivedCents, amountRefundedCents: s.amountRefundedCents, piStatus: s.piStatus,
      stripeDisputed: s.disputed, stripeDisputes: s.disputes, serviceFeeCents: 595, pgWholesaleCents: 0,
      status, cancelState: x.cancel_state ?? null, cancelClaimedAt: x.cancel_claimed_at ?? null,
      checkIn: "2026-10-20T10:00:00", checkOut: "2026-10-24T10:00:00", timezone: "America/New_York",
    });

    it("a partial refund settled by hand: the figure uses the ledger amount", () => {
      const s = read({ amountRefundedCents: 500 });
      const lines = paid({ sumCents: 3400, lastPersonBasis: decidedBasis(resolve(), s, {}, "confirmed") });
      // 5212 − 500 − 3400 − 181
      expect(resolve({ s, lines })).toMatchObject({ state: "ok", owedToLotCents: 3400, owedSource: "ledger", netCents: 1131, grossCents: 1312 });
    });

    it("a disputed booking never gets a figure: the dispute's outcome is not in received / refunded", () => {
      const s = read({ disputed: true, disputes: "dp_1:lost:5212" });
      const lines = paid({ sumCents: 0, lastPersonBasis: decidedBasis(resolve(), s, {}, "disputed") });
      expect(resolve({ b: { status: "disputed" }, s, lines })).toMatchObject({ state: "no_figure", owedToLotCents: 0, netCents: null, grossCents: null });
    });

    it("decided by hand where Triply remits the tax: no figure", () => {
      const s = read({ amountRefundedCents: 500 });
      const lines = paid({ sumCents: 3000, lastPersonBasis: decidedBasis(resolve(), s, {}, "confirmed", "triply") });
      expect(resolve({ t: { tax_collected_by: "triply" }, s, lines })).toMatchObject({ state: "no_figure", netCents: null });
    });
  });
});

describe("directTotals", () => {
  it("adds only what is known and says how many rows that is", () => {
    const ok = resolve();
    const loss = resolve({ b: { status: "refunded" }, x: selfCancelled, s: read({ amountRefundedCents: 5212 }) });
    const waiting = resolve({ s: read({ amountRefundedCents: 500 }) });
    const unread = resolve({ s: null });
    const t = directTotals([ok, loss, waiting, unread]);
    expect(t.collected).toEqual({ cents: 5212 + 0 + 4712, known: 3, of: 4 });
    expect(t.net).toEqual({ cents: 1210 - 181, known: 2, of: 4 });
    expect(t.gross).toEqual({ cents: 1391, known: 2, of: 4 });
    expect(t.stripeFees).toEqual({ cents: 362, known: 2, of: 4 });
    expect(t.owedToLots).toEqual({ cents: 3821, known: 2, of: 4 });
    // The columns add up over the rows that have a figure: gross − fees = net.
    expect(t.gross.cents - t.stripeFees.cents).toBe(t.net.cents);
  });

  it("no rows", () => {
    expect(directTotals([]).net).toEqual({ cents: 0, known: 0, of: 0 });
  });
});

describe("buildDirectDetail", () => {
  beforeEach(() => {
    db.tables = { bookings: [], direct_booking_terms: [], direct_lot_payout_lines: [] };
    db.clearFailures();
  });

  it("reads the terms, the ledger and the extra columns for the report's rows only", async () => {
    db.seed("bookings", [extra(), extra({ id: "b2" }), extra({ id: "other" })]);
    db.seed("direct_booking_terms", [terms(), terms({ stripe_payment_intent_id: "pi_2" })]);
    db.seed("direct_lot_payout_lines", [
      { id: "l1", created_at: "2026-11-01T00:00:00Z", stripe_payment_intent_id: "pi_2", kind: "payout", amount_cents: "3821", decision: "auto", basis: {} },
    ]);
    const d = await buildDirectDetail([row(), row({ id: "b2", reslab_reservation_number: "TRP-BBBB2222", stripe_payment_intent_id: "pi_2" })], [read(), read()], "n/a");
    expect(d.bookings.map((b) => [b.reservationNumber, b.state, b.owedSource, b.netCents])).toEqual([
      ["TRP-AAAA1111", "ok", "rule", 1210],
      ["TRP-BBBB2222", "ok", "ledger", 1210],
    ]);
    expect(d.totals.net).toEqual({ cents: 2420, known: 2, of: 2 });
  });

  it("no direct rows: no reads, empty totals", async () => {
    db.failOnce("bookings", "select", "must not be read");
    expect(await buildDirectDetail([], [], "n/a")).toEqual({ bookings: [], totals: directTotals([]) });
  });

  it("a failed read throws (the caller reports it; a partial ledger is never used)", async () => {
    db.seed("bookings", [extra()]).seed("direct_booking_terms", [terms()]);
    db.failOnce("direct_lot_payout_lines", "select", "boom");
    await expect(buildDirectDetail([row()], [read()], "n/a")).rejects.toThrow("direct ledger read failed");
  });

  it("a ledger amount that is not an integer throws", async () => {
    db.seed("bookings", [extra()]).seed("direct_booking_terms", [terms()]);
    db.seed("direct_lot_payout_lines", [{ id: "l1", created_at: "2026-11-01T00:00:00Z", stripe_payment_intent_id: "pi_1", kind: "payout", amount_cents: "38.21", decision: "auto", basis: {} }]);
    await expect(buildDirectDetail([row()], [read()], "n/a")).rejects.toThrow("ledger amount unreadable");
  });
});
