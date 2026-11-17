import { describe, it, expect } from "vitest";
import { dollarsToCents, prepareMarkPaid, previousMonth, statementTotals } from "../payout-form";
import { buildLedgerLines } from "../payout-lines";
import type { StatementItem } from "../payout-statement";

const item = (o: Partial<StatementItem> & { piId: string }): StatementItem => ({
  reservationNumber: `TRP-${o.piId}`,
  checkIn: "2026-09-20 10:00:00",
  checkOut: "2026-09-24 10:00:00",
  status: "confirmed",
  lineKind: "payout",
  class: "payable",
  suggestedCents: 3821,
  reason: null,
  priorLinesCents: null,
  priorLinesCount: o.lineKind === "adjustment" ? 1 : null,
  basis: { subtotalCents: 3980, taxCents: 637, shareBp: 8000, taxCollectedBy: "lot", amountReceivedCents: 5212, amountRefundedCents: 0, status: "confirmed", cancelState: null, cancelClaimedAt: null, piStatus: "succeeded", stripeDisputed: false,
  stripeDisputes: "", serviceFeeCents: 595, pgWholesaleCents: 0, checkIn: "2026-09-20 10:00:00", timezone: "America/New_York", checkOut: "2026-09-24 10:00:00" },
  margin: { stripeFeeCents: null, pgWholesaleCents: 0, marginCents: null },
  ...o,
});

describe("dollarsToCents", () => {
  it.each([
    ["38.21", 3821],
    ["38.2", 3820],
    ["38", 3800],
    ["-12.50", -1250],
    [" 0.07 ", 7],
    ["-0", 0],
  ])("%s → %i", (s, c) => expect(dollarsToCents(s)).toBe(c));
  it.each(["", "abc", "1.234", "$5", "1,000", "1e3", "12345678"])("rejects %j", (s) => expect(dollarsToCents(s)).toBeNull());
  it("no float error on cents", () => expect(dollarsToCents("0.29")).toBe(29));
});

describe("prepareMarkPaid", () => {
  const items = [item({ piId: "a" }), item({ piId: "z", class: "zero", suggestedCents: 0 }), item({ piId: "m", class: "manual", suggestedCents: null })];

  it("needs every manual row decided", () => {
    expect(prepareMarkPaid(items, {})).toMatchObject({ ok: false, error: expect.stringContaining("TRP-m") });
  });

  it("needs a note on a paid manual row", () => {
    expect(prepareMarkPaid(items, { m: { action: "pay", amount: "10", note: " " } })).toMatchObject({ ok: false, error: expect.stringContaining("note") });
  });

  it("agrees with the server's buildLedgerLines on total and decisions", () => {
    const r = prepareMarkPaid(items, { m: { action: "pay", amount: "10.05", note: "ok" } });
    expect(r).toMatchObject({ ok: true, totalCents: 3821 + 1005, lineCount: 3 });
    if (!r.ok) return;
    const server = buildLedgerLines(items, r.decisions);
    expect(server).toMatchObject({ ok: true, totalCents: r.totalCents });
    if (server.ok) expect(server.lines).toHaveLength(r.lineCount);
  });

  it("deferring leaves the row out", () => {
    expect(prepareMarkPaid(items, { m: { action: "defer", amount: "", note: "" } })).toMatchObject({ ok: true, totalCents: 3821, lineCount: 2 });
  });

  it("refuses a negative payout; a $0 adjustment is 'reviewed, no change'", () => {
    expect(prepareMarkPaid(items, { m: { action: "pay", amount: "-1", note: "x" } })).toMatchObject({ ok: false });
    const adj = [item({ piId: "x", lineKind: "adjustment", class: "zero", suggestedCents: -3821, priorLinesCents: 3821 })];
    expect(prepareMarkPaid(adj, { x: { action: "pay", amount: "0", note: "x" } })).toMatchObject({ ok: true, totalCents: 0, lineCount: 1 });
    expect(prepareMarkPaid(adj, { x: { action: "pay", amount: "-38.21", note: "refund" } })).toMatchObject({ ok: true, totalCents: -3821 });
  });

  it("nothing to pay", () => {
    expect(prepareMarkPaid([items[2]], { m: { action: "defer", amount: "", note: "" } })).toMatchObject({ ok: false });
  });
});

describe("browser and server agree on the amount bounds", () => {
  it("a 40 % promo: both accept the lot's list-price $96.00, both refuse a 10× typo", () => {
    const promo = item({
      piId: "p", class: "manual", suggestedCents: null,
      basis: { ...item({ piId: "x" }).basis, subtotalCents: 10000, taxCents: 1600, amountReceivedCents: 8200 },
    });
    const ok = prepareMarkPaid([promo], { p: { action: "pay", amount: "96.00", note: "list-price share" } });
    expect(ok).toMatchObject({ ok: true, totalCents: 9600 });
    if (ok.ok) expect(buildLedgerLines([promo], ok.decisions)).toMatchObject({ ok: true, totalCents: 9600 });
    expect(prepareMarkPaid([promo], { p: { action: "pay", amount: "960", note: "typo" } })).toMatchObject({ ok: false });
    expect(buildLedgerLines([promo], { p: { action: "pay", amountCents: 96000, note: "typo" } })).toMatchObject({ ok: false });
  });
});

describe("previousMonth", () => {
  it("rolls back across the year", () => {
    expect(previousMonth(new Date(2027, 0, 15).getTime())).toBe("2026-12");
    expect(previousMonth(new Date(2026, 9, 12).getTime())).toBe("2026-09");
  });
});

describe("statementTotals", () => {
  const withMargin = (cents: number | null) => ({ stripeFeeCents: 181, pgWholesaleCents: 0, marginCents: cents });
  const basis = item({ piId: "x" }).basis;

  it("adds Triply keeps over every row that has a figure", () => {
    const t = statementTotals([item({ piId: "a", margin: withMargin(1210) }), item({ piId: "b", margin: withMargin(1375) })]);
    expect(t.margin).toEqual({ cents: 2585, known: 2, of: 2, excluded: 0 });
    expect(t.parking).toEqual({ cents: 7960, known: 2, of: 2, excluded: 0 });
    expect(t.tax.cents).toBe(1274);
    expect(t.received.cents).toBe(10424);
    expect(t.refunded.cents).toBe(0);
  });

  it("a row waiting on a decision is counted as missing, not as $0; its parking still counts", () => {
    const t = statementTotals([item({ piId: "a", margin: withMargin(1210) }), item({ piId: "m", class: "manual", suggestedCents: null })]);
    expect(t.margin).toEqual({ cents: 1210, known: 1, of: 2, excluded: 0 });
    expect(t.parking).toEqual({ cents: 7960, known: 2, of: 2, excluded: 0 });
  });

  it("a cancelled row adds what was kept on it but no parking or tax", () => {
    const t = statementTotals([
      item({ piId: "a", margin: withMargin(1210) }),
      item({ piId: "z", class: "zero", suggestedCents: 0, basis: { ...basis, amountRefundedCents: 4617 }, margin: withMargin(414) }),
    ]);
    expect(t.margin).toEqual({ cents: 1624, known: 2, of: 2, excluded: 0 });
    expect(t.parking).toEqual({ cents: 3980, known: 1, of: 1, excluded: 1 });
    expect(t.tax).toEqual({ cents: 637, known: 1, of: 1, excluded: 1 });
    expect(t.received.cents).toBe(10424);
    expect(t.refunded.cents).toBe(4617);
  });

  it("a $0 row is a known figure and a loss row lowers the total", () => {
    const t = statementTotals([
      item({ piId: "a", margin: withMargin(1210) }),
      item({ piId: "h", class: "zero", suggestedCents: 0, margin: withMargin(0) }),
      item({ piId: "r", class: "zero", suggestedCents: 0, margin: withMargin(-181) }),
    ]);
    expect(t.margin).toEqual({ cents: 1029, known: 3, of: 3, excluded: 0 });
  });

  it("an adjustment row adds nothing to the money columns and leaves Triply keeps incomplete", () => {
    const refundedLater = { ...basis, status: "refunded", amountRefundedCents: 5212 };
    const t = statementTotals([
      item({ piId: "a", margin: withMargin(1210) }),
      item({ piId: "j", lineKind: "adjustment", class: "zero", suggestedCents: -3821, basis: refundedLater }),
    ]);
    expect(t.parking).toEqual({ cents: 3980, known: 1, of: 1, excluded: 1 });
    expect(t.received).toEqual({ cents: 5212, known: 1, of: 1, excluded: 1 });
    expect(t.refunded).toEqual({ cents: 0, known: 1, of: 1, excluded: 1 });
    expect(t.margin).toEqual({ cents: 1210, known: 1, of: 2, excluded: 0 });
  });

  it("a released hold (received 0, Stripe says refunded) adds no refund", () => {
    const hold = { ...basis, amountReceivedCents: 0, amountRefundedCents: 5212 };
    const t = statementTotals([item({ piId: "a" }), item({ piId: "h", class: "zero", suggestedCents: 0, basis: hold })]);
    expect(t.refunded).toEqual({ cents: 0, known: 2, of: 2, excluded: 0 });
    expect(t.received.cents).toBe(5212);
  });

  it("an unread row leaves received and refunded incomplete, not $0", () => {
    const unread = { ...basis, amountReceivedCents: null, amountRefundedCents: null };
    const t = statementTotals([item({ piId: "a" }), item({ piId: "m", class: "manual", suggestedCents: null, basis: unread })]);
    expect(t.received).toEqual({ cents: 5212, known: 1, of: 2, excluded: 0 });
    expect(t.refunded).toEqual({ cents: 0, known: 1, of: 2, excluded: 0 });
  });

  it("no rows: nothing known", () => {
    expect(statementTotals([]).margin).toEqual({ cents: 0, known: 0, of: 0, excluded: 0 });
  });
});
