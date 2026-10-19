/**
 * The statement builder against the shared Supabase fake: which bookings land
 * on a month's statement, which become adjustment candidates, and what the
 * view hash notices.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { PayoutStripeRead } from "../payout-stripe";

const { db, stripeReads } = await vi.hoisted(async () => {
  const { FakeSupabase } = await import("@/lib/booking/__tests__/supabase-fake");
  return { db: new FakeSupabase(), stripeReads: new Map<string, PayoutStripeRead>() };
});

vi.mock("@/lib/supabase/server", () => ({ createAdminClient: async () => db }));
vi.mock("../payout-stripe", () => ({
  readPayoutStripeMany: async (ids: string[]) => new Map(ids.map((id) => [id, stripeReads.get(id) ?? { error: "not read", amountReceivedCents: null, amountRefundedCents: null, piStatus: null, feeCents: null }])),
}));

import { buildStatementView, nextMonthStart, localDate } from "../payout-statement";

const okRead = (o: Partial<PayoutStripeRead> = {}): PayoutStripeRead => ({ error: null, amountReceivedCents: 5212, amountRefundedCents: 0, piStatus: "succeeded", disputed: false, disputes: "", feeCents: 181, ...o });

function booking(pi: string, o: Record<string, unknown> = {}) {
  return {
    inventory_source: "direct",
    stripe_payment_intent_id: pi,
    reslab_reservation_number: `TRP-${pi.slice(3).toUpperCase()}`,
    direct_lot_id: "1",
    livemode: true,
    status: "confirmed",
    cancel_state: null,
    cancel_claimed_at: null,
    check_in: "2026-10-20T10:00:00",
    check_out: "2026-10-24T10:00:00",
    location_timezone: "America/New_York",
    lot_snapshot: null,
    subtotal: "39.80",
    tax_total: "6.37",
    triply_service_fee: "5.95",
    protection_plan_wholesale: null,
    ...o,
  };
}
const terms = (pi: string, o: Record<string, unknown> = {}) => ({
  stripe_payment_intent_id: pi,
  direct_lot_id: "1",
  livemode: true,
  partner_share_percent: "80.00",
  tax_collected_by: "lot",
  ...o,
});

// 1 Nov 2026 05:00 New York = after the October month ends there.
const NOV_1_NY = Date.parse("2026-11-01T09:00:00Z");
const OCT_31_NY = Date.parse("2026-11-01T03:00:00Z"); // still 31 Oct 23:00 in New York

const build = (o: Partial<Parameters<typeof buildStatementView>[0]> = {}) =>
  buildStatementView({ lotId: "1", month: "2026-10", livemode: true, lotTimezone: "America/New_York", nowMs: NOV_1_NY, ...o });

beforeEach(() => {
  db.tables = { bookings: [], direct_booking_terms: [], direct_lot_payout_lines: [], direct_lot_statements: [] };
  db.clearFailures();
  stripeReads.clear();
});

describe("buildStatementView", () => {
  it("puts an unpaid booking that checked out in the month on the statement at 80 % + tax", async () => {
    db.seed("bookings", [booking("pi_a")]).seed("direct_booking_terms", [terms("pi_a")]);
    stripeReads.set("pi_a", okRead());
    const v = await build();
    expect(v.items).toEqual([expect.objectContaining({ piId: "pi_a", lineKind: "payout", class: "payable", suggestedCents: 3821 })]);
    expect(v.totals).toMatchObject({ autoCents: 3821, payableCount: 1 });
    // 5212 received − 3821 payout − 181 Stripe fee − 0 PG − 0 Triply tax
    expect(v.items[0].margin.marginCents).toBe(1210);
    expect(v.monthClosed).toBe(true);
    expect(v.paid).toBeNull();
  });

  it("includes an earlier month's unpaid booking (late fulfilment) and leaves next month's out", async () => {
    db.seed("bookings", [
      booking("pi_old", { check_out: "2026-09-10T10:00:00" }),
      booking("pi_next", { check_out: "2026-11-01T10:00:00" }),
    ]).seed("direct_booking_terms", [terms("pi_old"), terms("pi_next")]);
    stripeReads.set("pi_old", okRead()).set("pi_next", okRead());
    const v = await build();
    expect(v.items.map((i) => i.piId)).toEqual(["pi_old"]);
  });

  it("sees only this lot and this Stripe mode", async () => {
    db.seed("bookings", [booking("pi_a"), booking("pi_test", { livemode: false }), booking("pi_lot2", { direct_lot_id: "2" }), booking("pi_reslab", { inventory_source: "reslab" })]);
    db.seed("direct_booking_terms", [terms("pi_a"), terms("pi_test", { livemode: false }), terms("pi_lot2", { direct_lot_id: "2" })]);
    stripeReads.set("pi_a", okRead()).set("pi_test", okRead()).set("pi_lot2", okRead());
    expect((await build()).items.map((i) => i.piId)).toEqual(["pi_a"]);
    expect((await build({ livemode: false })).items.map((i) => i.piId)).toEqual(["pi_test"]);
  });

  it("an already-paid booking with nothing changed is not listed again", async () => {
    db.seed("bookings", [booking("pi_a")]).seed("direct_booking_terms", [terms("pi_a")]);
    db.seed("direct_lot_payout_lines", [{ stripe_payment_intent_id: "pi_a", kind: "payout", amount_cents: "3821", direct_lot_id: "1", livemode: true }]);
    stripeReads.set("pi_a", okRead());
    expect((await build()).items).toEqual([]);
  });

  it("a refund after payment becomes an adjustment candidate against the current line sum", async () => {
    db.seed("bookings", [booking("pi_a", { status: "refunded", cancel_state: "refund_issued", cancel_claimed_at: "2026-10-19T12:00:00Z" })]);
    db.seed("direct_booking_terms", [terms("pi_a")]);
    db.seed("direct_lot_payout_lines", [{ stripe_payment_intent_id: "pi_a", kind: "payout", amount_cents: 3821, direct_lot_id: "1", livemode: true }]);
    stripeReads.set("pi_a", okRead({ amountRefundedCents: 5212 }));
    const v = await build();
    expect(v.items).toEqual([expect.objectContaining({ lineKind: "adjustment", suggestedCents: -3821, priorLinesCents: 3821 })]);
    expect(v.totals.adjustmentCount).toBe(1);
  });

  it("a booking with no PaymentIntent is blocked, never paid", async () => {
    db.seed("bookings", [booking("pi_a", { stripe_payment_intent_id: null })]);
    const v = await build();
    expect(v.items).toEqual([]);
    expect(v.blocked).toEqual([expect.objectContaining({ reason: "no PaymentIntent on the booking" })]);
  });

  it("a failed Stripe read routes the booking to a person, never $0", async () => {
    db.seed("bookings", [booking("pi_a")]).seed("direct_booking_terms", [terms("pi_a")]);
    const v = await build();
    expect(v.items[0]).toMatchObject({ class: "manual", suggestedCents: null });
    expect(v.totals.autoCents).toBe(0);
  });

  it("the month closes at lot-local midnight", async () => {
    db.seed("bookings", [booking("pi_a")]).seed("direct_booking_terms", [terms("pi_a")]);
    stripeReads.set("pi_a", okRead());
    expect((await build({ nowMs: OCT_31_NY })).monthClosed).toBe(false);
    expect((await build({ nowMs: NOV_1_NY })).monthClosed).toBe(true);
  });

  it("the hash changes when a refund lands", async () => {
    db.seed("bookings", [booking("pi_a")]).seed("direct_booking_terms", [terms("pi_a")]);
    stripeReads.set("pi_a", okRead());
    const before = (await build()).viewHash;
    expect((await build()).viewHash).toBe(before);
    stripeReads.set("pi_a", okRead({ amountRefundedCents: 100 }));
    expect((await build()).viewHash).not.toBe(before);
  });

  it("reports the paid statement", async () => {
    db.seed("direct_lot_statements", [{ id: "st_1", direct_lot_id: "1", period_month: "2026-10-01", livemode: true, total_cents: "3821", paid_at: "2026-11-05T15:00:00Z", paid_by: "tom@triplypro.com", statement_email_id: null, statement_attempts: 0 }]);
    expect((await build()).paid).toMatchObject({ id: "st_1", totalCents: 3821, emailId: null });
  });

  it("refuses rather than build a partial statement when a read fails", async () => {
    db.failOnce("direct_lot_payout_lines", "select", "boom");
    await expect(build()).rejects.toThrow("ledger read failed");
  });

  it("refuses a malformed month", async () => {
    await expect(build({ month: "2026-13" })).rejects.toThrow("invalid month");
  });
});

describe("review pass 1 fixes", () => {
  const line = (pi: string, kind: "payout" | "adjustment", amount: number, o: Record<string, unknown> = {}) => ({
    stripe_payment_intent_id: pi, kind, amount_cents: amount, direct_lot_id: "1", livemode: true, decision: "auto", basis: {}, ...o,
  });

  it("a claw-back already recorded is never raised again", async () => {
    db.seed("bookings", [booking("pi_a", { status: "refunded", cancel_state: "refund_issued", cancel_claimed_at: "2026-10-19T12:00:00Z" })]);
    db.seed("direct_booking_terms", [terms("pi_a")]);
    db.seed("direct_lot_payout_lines", [line("pi_a", "payout", 3821), line("pi_a", "adjustment", -3821, { decision: "manual" })]);
    stripeReads.set("pi_a", okRead({ amountRefundedCents: 5212 }));
    expect((await build()).items).toEqual([]);
  });

  it("a partial claw-back: the next delta is against the current line sum", async () => {
    db.seed("bookings", [booking("pi_a", { status: "refunded", cancel_state: "refund_issued", cancel_claimed_at: "2026-10-19T12:00:00Z" })]);
    db.seed("direct_booking_terms", [terms("pi_a")]);
    db.seed("direct_lot_payout_lines", [line("pi_a", "payout", 3821), line("pi_a", "adjustment", -1000, { decision: "manual", basis: { stale: true } })]);
    stripeReads.set("pi_a", okRead({ amountRefundedCents: 5212 }));
    expect((await build()).items).toEqual([expect.objectContaining({ lineKind: "adjustment", suggestedCents: -2821, priorLinesCents: 2821, priorLinesCount: 2 })]);
  });

  it("a $0 review changes the line count (and the hash) though not the sum", async () => {
    db.seed("bookings", [booking("pi_a", { status: "refunded", cancel_state: "refund_issued", cancel_claimed_at: "2026-10-19T12:00:00Z" })]);
    db.seed("direct_booking_terms", [terms("pi_a")]);
    stripeReads.set("pi_a", okRead({ amountRefundedCents: 5212 }));
    db.seed("direct_lot_payout_lines", [line("pi_a", "payout", 3821, { created_at: "2026-10-05T10:00:00Z", id: "a" })]);
    const before = await build();
    expect(before.items).toEqual([expect.objectContaining({ priorLinesCents: 3821, priorLinesCount: 1 })]);
    db.seed("direct_lot_payout_lines", [
      line("pi_a", "payout", 3821, { created_at: "2026-10-05T10:00:00Z", id: "a" }),
      line("pi_a", "adjustment", 0, { decision: "manual", basis: { stale: true }, created_at: "2026-11-05T10:00:00Z", id: "b" }),
    ]);
    const after = await build();
    expect(after.items).toEqual([expect.objectContaining({ priorLinesCents: 3821, priorLinesCount: 2 })]);
    expect(after.viewHash).not.toBe(before.viewHash);
  });

  it("the LATEST line decides (by created_at, not seed order)", async () => {
    db.seed("bookings", [booking("pi_a", { status: "disputed" })]).seed("direct_booking_terms", [terms("pi_a")]);
    stripeReads.set("pi_a", okRead());
    const basis = (await build()).items[0].basis;
    // The person's decision is the NEWER line but is seeded first.
    db.seed("direct_lot_payout_lines", [
      line("pi_a", "adjustment", 0, { decision: "manual", basis, created_at: "2026-11-05T10:00:00Z", id: "b" }),
      line("pi_a", "payout", 3821, { created_at: "2026-10-05T10:00:00Z", id: "a" }),
    ]);
    expect((await build()).items).toEqual([]);
    // An automatic line after the person's decision binds nothing.
    db.seed("direct_lot_payout_lines", [
      line("pi_a", "payout", 3821, { decision: "manual", basis, created_at: "2026-10-05T10:00:00Z", id: "a" }),
      line("pi_a", "adjustment", 0, { decision: "auto", created_at: "2026-11-05T10:00:00Z", id: "b" }),
    ]);
    expect((await build()).items).toEqual([expect.objectContaining({ lineKind: "adjustment" })]);
  });

  it("a booking a person paid by hand is not raised while its basis is unchanged", async () => {
    db.seed("bookings", [booking("pi_a", { status: "disputed" })]).seed("direct_booking_terms", [terms("pi_a")]);
    stripeReads.set("pi_a", okRead());
    const first = await build();
    expect(first.items[0]).toMatchObject({ class: "manual", lineKind: "payout" });
    db.seed("direct_lot_payout_lines", [line("pi_a", "payout", 3821, { decision: "manual", basis: first.items[0].basis })]);
    expect((await build()).items).toEqual([]);
    stripeReads.set("pi_a", okRead({ amountRefundedCents: 500 }));
    expect((await build()).items).toEqual([expect.objectContaining({ lineKind: "adjustment", suggestedCents: null })]);
  });

  it("a payout line moved to a later month is never listed again", async () => {
    db.seed("bookings", [booking("pi_a", { check_out: "2026-11-03T10:00:00" })]).seed("direct_booking_terms", [terms("pi_a")]);
    db.seed("direct_lot_payout_lines", [line("pi_a", "payout", 3821)]);
    stripeReads.set("pi_a", okRead());
    expect((await build({ month: "2026-11", nowMs: Date.parse("2026-12-02T12:00:00Z") })).items).toEqual([]);
  });

  it("a booking with no terms row is blocked, not offered for payment", async () => {
    db.seed("bookings", [booking("pi_a")]);
    const v = await build();
    expect(v.items).toEqual([]);
    expect(v.blocked).toEqual([expect.objectContaining({ reason: "no terms row for this booking in this lot and mode" })]);
  });

  it("lines without a payout line block the booking", async () => {
    db.seed("bookings", [booking("pi_a")]).seed("direct_booking_terms", [terms("pi_a")]);
    db.seed("direct_lot_payout_lines", [line("pi_a", "adjustment", -100, { decision: "manual" })]);
    stripeReads.set("pi_a", okRead());
    expect((await build()).blocked).toEqual([expect.objectContaining({ reason: "ledger has adjustment lines but no payout line" })]);
  });

  it("look-back: a paid booking older than 180 days is not re-read; an unpaid one of any age still is", async () => {
    db.seed("bookings", [booking("pi_old_paid", { check_out: "2026-04-01T10:00:00" }), booking("pi_old_unpaid", { check_out: "2025-10-01T10:00:00" })]);
    db.seed("direct_booking_terms", [terms("pi_old_paid"), terms("pi_old_unpaid")]);
    db.seed("direct_lot_payout_lines", [line("pi_old_paid", "payout", 3821)]);
    stripeReads.set("pi_old_paid", okRead({ amountRefundedCents: 5212 })).set("pi_old_unpaid", okRead());
    expect((await build()).items.map((i) => i.piId)).toEqual(["pi_old_unpaid"]);
  });

  it("reads past PostgREST's 1,000-row page — nothing is cut off", async () => {
    const pis = Array.from({ length: 1205 }, (_, i) => `pi_${String(i).padStart(5, "0")}`);
    db.seed("bookings", pis.map((pi, i) => booking(pi, { id: i })));
    db.seed("direct_booking_terms", pis.map((pi) => terms(pi)));
    for (const pi of pis) stripeReads.set(pi, okRead());
    const v = await build();
    expect(v.items).toHaveLength(1205);
    expect(v.totals.autoCents).toBe(1205 * 3821);
  });

  it("the hash does not depend on row order", async () => {
    const { hashItems } = await import("../payout-statement");
    db.seed("bookings", [booking("pi_a", { id: 1 }), booking("pi_b", { id: 2 })]).seed("direct_booking_terms", [terms("pi_a"), terms("pi_b")]);
    stripeReads.set("pi_a", okRead()).set("pi_b", okRead());
    const v = await build();
    expect(hashItems([...v.items].reverse(), v.blocked)).toBe(v.viewHash);
  });

  it("the hash changes when a $0 row appears (the total alone would not)", async () => {
    db.seed("bookings", [booking("pi_a")]).seed("direct_booking_terms", [terms("pi_a"), terms("pi_z")]);
    stripeReads.set("pi_a", okRead()).set("pi_z", okRead({ amountRefundedCents: 5212 }));
    const before = await build();
    db.tables.bookings.push(booking("pi_z", { status: "refunded", cancel_state: "refund_issued", cancel_claimed_at: "2026-10-19T12:00:00Z" }));
    const after = await build();
    expect(after.totals.autoCents).toBe(before.totals.autoCents);
    expect(after.viewHash).not.toBe(before.viewHash);
  });
});

describe("month helpers", () => {
  it("nextMonthStart rolls the year", () => {
    expect(nextMonthStart("2026-12")).toBe("2027-01-01");
    expect(nextMonthStart("2026-01")).toBe("2026-02-01");
  });
  it("localDate is null for an unknown zone", () => {
    expect(localDate(NOV_1_NY, "Not/AZone")).toBeNull();
  });
});
