/**
 * More cases for src/lib/accounting/__tests__/direct-detail.test.ts.
 * Same helpers as that file (copied); only the import paths differ.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { PayoutStripeRead } from "@/lib/direct/payout-stripe";
import type { LinesSummary } from "@/lib/direct/payout-statement";

const { db } = await vi.hoisted(async () => {
  const { FakeSupabase } = await import("@/lib/booking/__tests__/supabase-fake");
  return { db: new FakeSupabase() };
});
vi.mock("@/lib/supabase/server", () => ({ createAdminClient: async () => db }));

import { buildDirectDetail, directTotals, resolveDirectRow, type DirectRowInput } from "@/lib/accounting/direct-detail";

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
// The basis classifyPayout stores, rebuilt from the same inputs (as in the existing file).
const decidedBasis = (s: PayoutStripeRead, x: Record<string, unknown>, status: string, tax = "lot") => ({
  subtotalCents: 3980, taxCents: 637, shareBp: 8000, taxCollectedBy: tax,
  amountReceivedCents: s.amountReceivedCents, amountRefundedCents: s.amountRefundedCents, piStatus: s.piStatus,
  stripeDisputed: s.disputed, stripeDisputes: s.disputes, serviceFeeCents: 595, pgWholesaleCents: 0,
  status, cancelState: x.cancel_state ?? null, cancelClaimedAt: x.cancel_claimed_at ?? null,
  checkIn: "2026-10-20T10:00:00", checkOut: "2026-10-24T10:00:00", timezone: "America/New_York",
});

describe("resolveDirectRow (more cases)", () => {
  it("X1 a booking the rules would pay, paid by hand at another amount: the figure uses what the ledger paid", () => {
    const s = read();
    const lines = paid({ sumCents: 3500, lastPersonBasis: decidedBasis(s, {}, "confirmed") });
    // 5212 − 3500 − 181
    expect(resolve({ s, lines })).toMatchObject({ state: "ok", owedToLotCents: 3500, owedSource: "ledger", netCents: 1531, grossCents: 1712 });
  });

  it.each([
    ["Stripe's flag alone (our row still confirmed)", "confirmed", { disputed: true, disputes: "dp_1:won:5212" }],
    ["our row alone (Stripe's flag false)", "disputed", { disputed: false, disputes: "" }],
  ])("X2 a decided booking disputed by %s has no figure", (_label, status, stripe) => {
    const s = read(stripe);
    const lines = paid({ lastPersonBasis: decidedBasis(s, {}, status) });
    expect(resolve({ b: { status }, s, lines })).toMatchObject({
      state: "no_figure", reason: "disputed: the dispute's outcome is not in these figures", owedToLotCents: 3821, netCents: null, grossCents: null,
    });
  });

  it("X3 a decided booking with Park Guard: the wholesale comes off", () => {
    const s = read({ amountRefundedCents: 500 });
    const lines = paid({ sumCents: 3400, lastPersonBasis: { ...decidedBasis(s, {}, "confirmed"), pgWholesaleCents: 400 } });
    // 5212 − 500 − 3400 − 181 − 400
    expect(resolve({ b: { protection_plan_wholesale: "4.00" }, s, lines })).toMatchObject({ state: "ok", netCents: 731, grossCents: 912 });
  });

  it("X4 a decided booking with an unknown Stripe fee: no figure, never a fee of $0", () => {
    const s = read({ amountRefundedCents: 500, feeCents: null });
    const lines = paid({ sumCents: 3400, lastPersonBasis: decidedBasis(s, {}, "confirmed") });
    expect(resolve({ s, lines })).toMatchObject({ state: "no_figure", owedToLotCents: 3400, stripeFeeCents: null, netCents: null, grossCents: null });
  });

  it("X5 a released hold a person decided to pay anyway: Triply is out what the ledger paid", () => {
    const s = read({ amountReceivedCents: 0, amountRefundedCents: 5212, piStatus: "canceled", feeCents: null });
    const lines = paid({ sumCents: 1000, lastPersonBasis: decidedBasis(s, selfCancelled, "refunded") });
    expect(resolve({ b: { status: "refunded" }, x: selfCancelled, s, lines })).toMatchObject({ state: "ok", owedToLotCents: 1000, owedSource: "ledger", netCents: -1000, grossCents: -1000 });
  });

  it("X6 a pre-015 row (livemode NULL) is live: it gets a figure, not a person", () => {
    expect(resolve({ b: { livemode: null } })).toMatchObject({ state: "ok", netCents: 1210 });
  });

  it("X7 the cancel is judged in the lot snapshot's zone when the booking has none", () => {
    const x = { ...selfCancelled, location_timezone: null, lot_snapshot: { timezone: "America/New_York" } };
    expect(resolve({ b: { status: "refunded" }, x, s: read({ amountRefundedCents: 5212 }) })).toMatchObject({ state: "ok", owedToLotCents: 0, netCents: -181 });
  });
});

describe("directTotals (more cases)", () => {
  it("X8 owed to lots and Stripe fees count only rows with a net figure", () => {
    const ok = resolve();
    const pending = resolve({ lines: paid({ sumCents: 3000 }) }); // owed 3000 (ledger), fee 181, no net
    const noFee = resolve({ s: read({ feeCents: null }) }); // owed 3821 (rule), no net
    const t = directTotals([ok, pending, noFee]);
    expect(t.owedToLots).toEqual({ cents: 3821, known: 1, of: 3 });
    expect(t.stripeFees).toEqual({ cents: 181, known: 1, of: 3 });
    expect(t.net).toEqual({ cents: 1210, known: 1, of: 3 });
  });
});

describe("buildDirectDetail (more cases)", () => {
  beforeEach(() => {
    db.tables = { bookings: [], direct_booking_terms: [], direct_lot_payout_lines: [] };
    db.clearFailures();
    db.maxRows = null;
  });

  it("X9 each row gets its own Stripe reading", async () => {
    db.seed("bookings", [extra(), extra({ id: "b2" })]);
    db.seed("direct_booking_terms", [terms(), terms({ stripe_payment_intent_id: "pi_2" })]);
    const rows = [row(), row({ id: "b2", reslab_reservation_number: "TRP-BBBB2222", stripe_payment_intent_id: "pi_2" })];
    const d = await buildDirectDetail(rows, [null, read()], "payment not read from Stripe");
    expect(d.bookings.map((b) => b.state)).toEqual(["not_read", "ok"]);
  });

  it("X10 reads past PostgREST's 1,000-row page: a payout line on page two still counts", async () => {
    db.maxRows = 1000;
    db.seed("bookings", [extra()]).seed("direct_booking_terms", [terms()]);
    const reviews = Array.from({ length: 1000 }, (_, i) => ({
      id: `r${String(i).padStart(4, "0")}`, created_at: "2026-11-01T00:00:00Z", stripe_payment_intent_id: "pi_1",
      kind: "adjustment", amount_cents: 0, decision: "auto", basis: {},
    }));
    db.seed("direct_lot_payout_lines", [
      ...reviews,
      { id: "z", created_at: "2026-11-02T00:00:00Z", stripe_payment_intent_id: "pi_1", kind: "payout", amount_cents: 3821, decision: "auto", basis: {} },
    ]);
    const d = await buildDirectDetail([row()], [read()], "n/a");
    expect(d.bookings[0]).toMatchObject({ state: "ok", owedSource: "ledger", owedToLotCents: 3821, netCents: 1210 });
  });

  it("X11 more than 100 bookings: read in chunks, each booking's ledger counted once", async () => {
    const n = 101;
    const ix = Array.from({ length: n }, (_, i) => i);
    db.seed("bookings", ix.map((i) => extra({ id: `b${i}` })));
    db.seed("direct_booking_terms", ix.map((i) => terms({ stripe_payment_intent_id: `pi_${i}` })));
    db.seed("direct_lot_payout_lines", ix.map((i) => ({
      id: `l${i}`, created_at: "2026-11-01T00:00:00Z", stripe_payment_intent_id: `pi_${i}`, kind: "payout", amount_cents: 3821, decision: "auto", basis: {},
    })));
    const rows = ix.map((i) => row({ id: `b${i}`, reslab_reservation_number: `TRP-${i}`, stripe_payment_intent_id: `pi_${i}` }));
    const d = await buildDirectDetail(rows, ix.map(() => read()), "n/a");
    expect(d.bookings.filter((b) => b.state !== "ok")).toEqual([]);
    expect(d.totals.owedToLots).toEqual({ cents: 3821 * n, known: n, of: n });
  });

  it("X12 the latest ledger line (by created_at, not seed order) decides whether a person's decision stands", async () => {
    const s = read({ amountRefundedCents: 500 });
    db.seed("bookings", [extra()]).seed("direct_booking_terms", [terms()]);
    db.seed("direct_lot_payout_lines", [
      { id: "b", created_at: "2026-11-05T00:00:00Z", stripe_payment_intent_id: "pi_1", kind: "adjustment", amount_cents: 0, decision: "manual", basis: decidedBasis(s, {}, "confirmed") },
      { id: "a", created_at: "2026-10-05T00:00:00Z", stripe_payment_intent_id: "pi_1", kind: "payout", amount_cents: 3400, decision: "auto", basis: {} },
    ]);
    const d = await buildDirectDetail([row()], [s], "n/a");
    // 5212 − 500 − 3400 − 181
    expect(d.bookings[0]).toMatchObject({ state: "ok", owedToLotCents: 3400, netCents: 1131 });
  });
});
