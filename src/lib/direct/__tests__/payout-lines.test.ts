import { describe, it, expect } from "vitest";
import { buildLedgerLines, decisionSchema, type PayoutDecision } from "../payout-lines";
import type { StatementItem } from "../payout-statement";
import type { PayoutBasis } from "../payout";

const basis: PayoutBasis = {
  subtotalCents: 3980,
  taxCents: 637,
  shareBp: 8000,
  taxCollectedBy: "lot",
  amountReceivedCents: 5212,
  amountRefundedCents: 0,
  status: "confirmed",
  cancelState: null,
  cancelClaimedAt: null,
  piStatus: "succeeded",
  stripeDisputed: false,
  stripeDisputes: "",
  serviceFeeCents: 595,
  pgWholesaleCents: 0,
  checkIn: "2026-10-20 10:00:00",
  timezone: "America/New_York",
  checkOut: "2026-10-24 10:00:00",
};

const item = (o: Partial<StatementItem> & { piId: string }): StatementItem => ({
  reservationNumber: `TRP-${o.piId.slice(3).toUpperCase()}`,
  checkIn: "2026-10-20 10:00:00",
  checkOut: "2026-10-24 10:00:00",
  status: "confirmed",
  lineKind: "payout",
  class: "payable",
  suggestedCents: 3821,
  reason: null,
  priorLinesCents: null,
  priorLinesCount: o.lineKind === "adjustment" ? 1 : null,
  basis,
  margin: { stripeFeeCents: 181, pgWholesaleCents: 0, marginCents: 1210 },
  ...o,
});

const pay = (amountCents: number, note = "agreed with the lot"): PayoutDecision => ({ action: "pay", amountCents, note });

describe("buildLedgerLines", () => {
  it("writes payable and zero rows automatically at the rules' amount", () => {
    const r = buildLedgerLines([item({ piId: "pi_a" }), item({ piId: "pi_b", class: "zero", suggestedCents: 0 })], {});
    expect(r).toEqual({
      ok: true,
      totalCents: 3821,
      lines: [
        expect.objectContaining({ stripe_payment_intent_id: "pi_a", kind: "payout", amount_cents: 3821, decision: "auto", note: null }),
        expect.objectContaining({ stripe_payment_intent_id: "pi_b", kind: "payout", amount_cents: 0, decision: "auto" }),
      ],
    });
  });

  it("refuses a hand decision on a row the rules decide", () => {
    const r = buildLedgerLines([item({ piId: "pi_a" })], { pi_a: pay(100) });
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("decided by the rules") });
  });

  it("refuses decisions for bookings that are not on the statement", () => {
    const r = buildLedgerLines([item({ piId: "pi_a" })], { pi_zzz: { action: "defer" } });
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("pi_zzz") });
  });

  it("never pays a manual row by default", () => {
    const r = buildLedgerLines([item({ piId: "pi_a" }), item({ piId: "pi_m", class: "manual", suggestedCents: null, reason: "disputed" })], {});
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("needs a decision") });
  });

  it("a deferred manual row gets no line (it comes back next month)", () => {
    const r = buildLedgerLines([item({ piId: "pi_a" }), item({ piId: "pi_m", class: "manual", suggestedCents: null })], { pi_m: { action: "defer" } });
    expect(r).toMatchObject({ ok: true, totalCents: 3821 });
    if (r.ok) expect(r.lines.map((l) => l.stripe_payment_intent_id)).toEqual(["pi_a"]);
  });

  it("a paid manual row is a manual payout line with its note", () => {
    const r = buildLedgerLines([item({ piId: "pi_m", class: "manual", suggestedCents: null })], { pi_m: pay(2000, "half — partial stay") });
    expect(r).toMatchObject({
      ok: true,
      totalCents: 2000,
      lines: [{ kind: "payout", amount_cents: 2000, decision: "manual", note: "half — partial stay" }],
    });
  });

  it("refuses a negative payout", () => {
    const r = buildLedgerLines([item({ piId: "pi_m", class: "manual", suggestedCents: null })], { pi_m: pay(-1) });
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("negative") });
  });

  it("an adjustment carries its baseline, in the line and in the basis", () => {
    const adj = item({ piId: "pi_x", lineKind: "adjustment", class: "zero", suggestedCents: -3821, priorLinesCents: 3821, reason: "refunded" });
    const r = buildLedgerLines([adj], { pi_x: pay(-3821, "refunded after payout") });
    expect(r).toMatchObject({
      ok: true,
      totalCents: -3821,
      lines: [{ kind: "adjustment", amount_cents: -3821, decision: "manual", prior_lines_cents: 3821, prior_lines_count: 1, basis: expect.objectContaining({ priorLinesCents: 3821, priorLinesCount: 1 }) }],
    });
  });

  it("an adjustment without its line count has no baseline", () => {
    const adj = item({ piId: "pi_x", lineKind: "adjustment", class: "zero", suggestedCents: -3821, priorLinesCents: 3821, priorLinesCount: null });
    expect(buildLedgerLines([adj], { pi_x: pay(-3821) })).toEqual({ ok: false, error: "TRP-X: no baseline for the adjustment" });
  });

  it("a $0 adjustment records 'reviewed, the payout stands'", () => {
    const adj = item({ piId: "pi_x", lineKind: "adjustment", class: "manual", suggestedCents: null, priorLinesCents: 3821 });
    expect(buildLedgerLines([adj], { pi_x: pay(0, "dispute won") })).toMatchObject({
      ok: true,
      totalCents: 0,
      lines: [{ kind: "adjustment", amount_cents: 0, decision: "manual", note: "dispute won", prior_lines_cents: 3821 }],
    });
  });

  it("caps a booking's total at what the customer paid for parking + tax (a '3821' typed for '38.21')", () => {
    const m = item({ piId: "pi_m", class: "manual", suggestedCents: null });
    // ceiling = list-price subtotal + tax = 3980 + 637 = 4617 (received 5212 is not used when they read)
    expect(buildLedgerLines([m], { pi_m: pay(4617) })).toMatchObject({ ok: true });
    expect(buildLedgerLines([m], { pi_m: pay(4618) })).toMatchObject({ ok: false, error: expect.stringContaining("above its parking + tax") });
    const unknownStripe = item({ piId: "pi_u", class: "manual", suggestedCents: null, basis: { ...basis, amountReceivedCents: null } });
    expect(buildLedgerLines([unknownStripe], { pi_u: pay(382100) })).toMatchObject({ ok: false });
    // Tax unreadable → the Stripe amount is the ceiling.
    const noTax = item({ piId: "pi_t", class: "manual", suggestedCents: null, basis: { ...basis, taxCents: null } });
    expect(buildLedgerLines([noTax], { pi_t: pay(5212) })).toMatchObject({ ok: true });
    expect(buildLedgerLines([noTax], { pi_t: pay(5213) })).toMatchObject({ ok: false });
    // Nothing readable → no increase at all; defer instead.
    const blind = item({ piId: "pi_b", class: "manual", suggestedCents: null, basis: { ...basis, taxCents: null, amountReceivedCents: null } });
    expect(buildLedgerLines([blind], { pi_b: pay(100) })).toMatchObject({ ok: false, error: expect.stringContaining("defer") });
    const adj = item({ piId: "pi_x", lineKind: "adjustment", class: "manual", suggestedCents: null, priorLinesCents: 3821 });
    expect(buildLedgerLines([adj], { pi_x: pay(796) })).toMatchObject({ ok: true });
    expect(buildLedgerLines([adj], { pi_x: pay(797) })).toMatchObject({ ok: false });
    expect(buildLedgerLines([adj], { pi_x: pay(-3822) })).toMatchObject({ ok: false, error: expect.stringContaining("more than was ever paid") });
  });

  it("a big promo (Triply absorbs it) never blocks paying the lot its list-price share", () => {
    // $100 list, 16 % tax, 40 % promo, $6 fee → received $82, lot owed $96 (80 % + tax).
    const promo: PayoutBasis = { ...basis, subtotalCents: 10000, taxCents: 1600, amountReceivedCents: 8200 };
    const m = item({ piId: "pi_m", class: "manual", suggestedCents: null, basis: promo });
    expect(buildLedgerLines([m], { pi_m: pay(9600) })).toMatchObject({ ok: true, totalCents: 9600 });
    // Auto-paid $96 earlier; a later review keeps it ($0) or claws a little back.
    const adj = item({ piId: "pi_x", lineKind: "adjustment", class: "manual", suggestedCents: null, priorLinesCents: 9600, basis: promo });
    expect(buildLedgerLines([adj], { pi_x: pay(0, "dispute won") })).toMatchObject({ ok: true });
    expect(buildLedgerLines([adj], { pi_x: pay(-800, "partial refund") })).toMatchObject({ ok: true });
    expect(buildLedgerLines([adj], { pi_x: pay(2001) })).toMatchObject({ ok: false });
  });

  it("an adjustment is never written without being decided, even when the delta is known", () => {
    const adj = item({ piId: "pi_x", lineKind: "adjustment", class: "zero", suggestedCents: -3821, priorLinesCents: 3821 });
    expect(buildLedgerLines([adj], {})).toMatchObject({ ok: false, error: expect.stringContaining("needs a decision") });
  });

  it("nothing to pay when every row is deferred", () => {
    const r = buildLedgerLines([item({ piId: "pi_m", class: "manual", suggestedCents: null })], { pi_m: { action: "defer" } });
    expect(r).toEqual({ ok: false, error: "nothing to pay on this statement" });
  });

  it("a month of only claw-backs nets below zero", () => {
    const a = item({ piId: "pi_x", lineKind: "adjustment", class: "zero", suggestedCents: -3821, priorLinesCents: 3821 });
    const b = item({ piId: "pi_y", lineKind: "adjustment", class: "zero", suggestedCents: -1000, priorLinesCents: 1000 });
    expect(buildLedgerLines([a, b], { pi_x: pay(-3821), pi_y: pay(-1000) })).toMatchObject({ ok: true, totalCents: -4821 });
  });
});

describe("decisionSchema", () => {
  it.each([
    [{ action: "pay", amountCents: 1.5, note: "x" }],
    [{ action: "pay", amountCents: 100, note: "   " }],
    [{ action: "pay", amountCents: 100 }],
    [{ action: "pay", amountCents: 100, note: "x".repeat(501) }],
    [{ action: "skip" }],
  ])("rejects %j", (d) => {
    expect(decisionSchema.safeParse(d).success).toBe(false);
  });
  it("trims the note", () => {
    expect(decisionSchema.parse({ action: "pay", amountCents: 5, note: "  ok  " })).toEqual({ action: "pay", amountCents: 5, note: "ok" });
  });
});
