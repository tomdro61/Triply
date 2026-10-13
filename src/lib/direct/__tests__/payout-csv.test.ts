import { describe, it, expect } from "vitest";
import { lotStatementCsv, internalStatementCsv, type PaidLineRow } from "../payout-csv";
import type { StatementItem } from "../payout-statement";

const L = (o: Omit<PaidLineRow, "note" | "decided_by">): PaidLineRow => ({ note: null, decided_by: null, ...o });

const basis = { subtotalCents: 3980, taxCents: 637, shareBp: 8000, taxCollectedBy: "lot", checkOut: "2026-10-24 10:00:00", amountReceivedCents: 5212 };

describe("lotStatementCsv", () => {
  const lines: PaidLineRow[] = [
    L({ reservation_number: "TRP-AAAA1111", kind: "payout", amount_cents: 3821, decision: "auto", basis }),
    L({ reservation_number: "TRP-BBBB2222", kind: "payout", amount_cents: 2000, decision: "manual", basis: { ...basis, taxCollectedBy: "triply" } }),
    L({ reservation_number: "TRP-CCCC3333", kind: "adjustment", amount_cents: -3821, decision: "manual", basis: { ...basis, priorLinesCents: 3821 } }),
  ];
  const csv = lotStatementCsv(lines, 2000);
  const rows = csv.trimEnd().split("\r\n");

  it("one row per line plus header and total", () => {
    expect(rows).toHaveLength(5);
    expect(rows[0]).toBe('"Confirmation","Check-out","Type","Parking subtotal","Lot share %","Tax passed through","Amount"');
    expect(rows[1]).toBe('"TRP-AAAA1111","2026-10-24","Payout",39.80,80.00,6.37,38.21');
    expect(rows[4]).toBe('"Total",,,,,,20.00');
  });

  it("passes tax through only when the lot collects it", () => {
    expect(rows[2]).toBe('"TRP-BBBB2222","2026-10-24","Payout (reviewed)",39.80,80.00,0.00,20.00');
  });

  it("an adjustment shows only its amount", () => {
    expect(rows[3]).toBe('"TRP-CCCC3333","2026-10-24","Adjustment",,,,-38.21');
  });

  it("never carries internal figures", () => {
    expect(csv).not.toMatch(/margin|fee|promo|park guard|received|priorLines/i);
  });

  it("an unreadable figure is blank, never 0", () => {
    const r = lotStatementCsv([L({ reservation_number: "TRP-X", kind: "payout", amount_cents: 0, decision: "auto", basis: { checkOut: "2026-10-24" } })], 0);
    expect(r.split("\r\n")[1]).toBe('"TRP-X","2026-10-24","Payout",,,,0.00');
  });

  it("neutralises a cell a spreadsheet would run as a formula", () => {
    const r = lotStatementCsv([L({ reservation_number: '=HYPERLINK("x")', kind: "payout", amount_cents: 1, decision: "auto", basis })], 1);
    expect(r).toContain(`"'=HYPERLINK(""x"")"`);
  });
});

describe("internalStatementCsv", () => {
  it("carries margin and fees, unknown as blank", () => {
    const item: StatementItem = {
      piId: "pi_a",
      reservationNumber: "TRP-AAAA1111",
      checkIn: "2026-10-20 10:00:00",
      checkOut: "2026-10-24 10:00:00",
      status: "confirmed",
      lineKind: "payout",
      class: "payable",
      suggestedCents: 3821,
      reason: null,
      priorLinesCents: null,
      priorLinesCount: null,
      basis: { ...basis, amountRefundedCents: 0, status: "confirmed", cancelState: null, cancelClaimedAt: null, piStatus: "succeeded", stripeDisputed: false, stripeDisputes: "", serviceFeeCents: 595, pgWholesaleCents: 0, checkIn: "2026-10-20 10:00:00", timezone: "America/New_York" },
      margin: { stripeFeeCents: 181, pgWholesaleCents: 0, marginCents: null },
    };
    const [header, row] = internalStatementCsv([item]).split("\r\n");
    expect(header).toContain('"Margin"');
    expect(row).toBe('"TRP-AAAA1111","2026-10-20 10:00:00","2026-10-24 10:00:00","confirmed","payout","payable","",38.21,39.80,80.00,6.37,"lot",52.12,0.00,1.81,0.00,');
  });
});
