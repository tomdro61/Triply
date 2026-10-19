import type { StatementItem } from "./payout-statement";

/**
 * The two payout CSVs (Phase 6a, plan §3). Pure.
 *   lot-facing  built from the LEDGER lines of a paid statement — what was
 *               actually recorded, never a recomputation. No notes, margin,
 *               Stripe fees, promo or Park Guard figures.
 *   internal    built from the statement view, for Triply's own books.
 */

/** A ledger line as read back from direct_lot_payout_lines. */
export interface PaidLineRow {
  reservation_number: string;
  kind: "payout" | "adjustment";
  amount_cents: number;
  decision: "auto" | "manual";
  basis: Record<string, unknown>;
  /** Internal only — never in the lot-facing CSV. */
  note: string | null;
  decided_by: string | null;
}

const dollars = (cents: number) => (cents / 100).toFixed(2);

/** Text cell: quoted, and a leading = + - @ neutralised so a spreadsheet never runs it as a formula. */
function text(v: string): string {
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return `"${safe.replace(/"/g, '""')}"`;
}

/** Number cell from integer cents; unknown → empty, never 0. */
function money(cents: number | null | undefined): string {
  return typeof cents === "number" && Number.isSafeInteger(cents) ? dollars(cents) : "";
}

const intField = (basis: Record<string, unknown>, key: string): number | null => {
  const v = basis[key];
  return typeof v === "number" && Number.isSafeInteger(v) ? v : null;
};
const strField = (basis: Record<string, unknown>, key: string): string => {
  const v = basis[key];
  return typeof v === "string" ? v : "";
};

const row = (cells: string[]) => cells.join(",");

export function lotStatementCsv(lines: PaidLineRow[], totalCents: number): string {
  const out = [row(["Confirmation", "Check-out", "Type", "Parking subtotal", "Lot share %", "Tax passed through", "Amount"].map(text))];
  for (const l of lines) {
    const b = l.basis;
    const isAdjustment = l.kind === "adjustment";
    const shareBp = intField(b, "shareBp");
    const collector = strField(b, "taxCollectedBy");
    const tax = collector === "lot" ? intField(b, "taxCents") : collector === "triply" ? 0 : null;
    out.push(
      row([
        text(l.reservation_number),
        text(strField(b, "checkOut").slice(0, 10)),
        text(isAdjustment ? "Adjustment" : l.decision === "manual" ? "Payout (reviewed)" : "Payout"),
        // An adjustment changes an earlier payout; the rule's figures belong to that payout's row.
        isAdjustment ? "" : money(intField(b, "subtotalCents")),
        isAdjustment || shareBp === null ? "" : (shareBp / 100).toFixed(2),
        isAdjustment ? "" : money(tax),
        money(l.amount_cents),
      ])
    );
  }
  out.push(row([text("Total"), "", "", "", "", "", money(totalCents)]));
  return out.join("\r\n") + "\r\n";
}

export function internalStatementCsv(items: StatementItem[]): string {
  const header = [
    "Confirmation", "Check-in", "Check-out", "Status", "Row", "Class", "Reason", "Suggested",
    "Parking subtotal", "Share %", "Tax", "Tax collected by", "Received", "Refunded",
    "Stripe fee", "Park Guard wholesale", "Margin",
  ];
  const out = [row(header.map(text))];
  for (const i of items) {
    const b = i.basis;
    out.push(
      row([
        text(i.reservationNumber),
        text(i.checkIn),
        text(i.checkOut),
        text(i.status),
        text(i.lineKind),
        text(i.class),
        text(i.reason ?? ""),
        money(i.suggestedCents),
        money(b.subtotalCents),
        b.shareBp === null ? "" : (b.shareBp / 100).toFixed(2),
        money(b.taxCents),
        text(b.taxCollectedBy ?? ""),
        money(b.amountReceivedCents),
        money(b.amountRefundedCents),
        money(i.margin.stripeFeeCents),
        money(i.margin.pgWholesaleCents),
        money(i.margin.marginCents),
      ])
    );
  }
  return out.join("\r\n") + "\r\n";
}

/** Internal CSV of a PAID statement: what was recorded, with the decisions and notes. */
export function internalPaidCsv(lines: PaidLineRow[], totalCents: number): string {
  const out = [row(["Confirmation", "Check-out", "Kind", "Decision", "Decided by", "Note", "Amount"].map(text))];
  for (const l of lines) {
    out.push(
      row([
        text(l.reservation_number),
        text(strField(l.basis, "checkOut").slice(0, 10)),
        text(l.kind),
        text(l.decision),
        text(l.decided_by ?? ""),
        text(l.note ?? ""),
        money(l.amount_cents),
      ])
    );
  }
  out.push(row([text("Total"), "", "", "", "", "", money(totalCents)]));
  return out.join("\r\n") + "\r\n";
}
