import { describe, it, expect } from "vitest";
import { dollarsToCents, prepareMarkPaid, previousMonth } from "../payout-form";
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
