import type { StatementItem } from "./payout-statement";
import { amountBoundError, type PayoutDecision } from "./payout-lines";

/**
 * Browser-side helpers for the payout section (Phase 6a). Pure; the server
 * rebuilds and re-checks everything — these only shape what the admin sends.
 */

export interface DecisionDraft {
  action: "" | "pay" | "defer";
  /** Dollars as typed, e.g. "38.21" or "-12.50". */
  amount: string;
  note: string;
}

/** "38.21" → 3821, "-12.5" → -1250; anything else → null. String maths, no floats. */
export function dollarsToCents(input: string): number | null {
  const m = /^\s*(-)?(\d{1,7})(?:\.(\d{1,2}))?\s*$/.exec(input);
  if (!m) return null;
  const cents = Number(m[2]) * 100 + Number((m[3] ?? "").padEnd(2, "0"));
  return m[1] && cents !== 0 ? -cents : cents;
}

export const needsPerson = (i: StatementItem) => i.lineKind === "adjustment" || i.class === "manual";

export type DecisionPayload = PayoutDecision;

/**
 * The decisions to send and the total they imply (auto rows at the rules'
 * amount + every "pay" decision). Mirrors buildLedgerLines, which the server
 * runs again; an error names the first row that is not ready.
 */
export function prepareMarkPaid(
  items: StatementItem[],
  drafts: Record<string, DecisionDraft>
): { ok: true; decisions: Record<string, DecisionPayload>; totalCents: number; lineCount: number } | { ok: false; error: string } {
  const decisions: Record<string, DecisionPayload> = {};
  let totalCents = 0;
  let lineCount = 0;
  for (const i of items) {
    if (!needsPerson(i)) {
      if (i.suggestedCents === null) return { ok: false, error: `${i.reservationNumber}: no amount` };
      totalCents += i.suggestedCents;
      lineCount++;
      continue;
    }
    const d = drafts[i.piId];
    if (!d || d.action === "") return { ok: false, error: `${i.reservationNumber} needs a decision (pay or defer)` };
    if (d.action === "defer") {
      decisions[i.piId] = { action: "defer" };
      continue;
    }
    const cents = dollarsToCents(d.amount);
    if (cents === null) return { ok: false, error: `${i.reservationNumber}: enter an amount like 38.21` };
    const bound = amountBoundError(i, cents);
    if (bound) return { ok: false, error: `${i.reservationNumber}: ${bound}` };
    if (d.note.trim().length === 0) return { ok: false, error: `${i.reservationNumber}: add a note saying why` };
    decisions[i.piId] = { action: "pay", amountCents: cents, note: d.note.trim() };
    totalCents += cents;
    lineCount++;
  }
  if (lineCount === 0) return { ok: false, error: "Nothing to pay on this statement." };
  return { ok: true, decisions, totalCents, lineCount };
}

/** The calendar month before `nowMs` in the browser's zone, "YYYY-MM". */
export function previousMonth(nowMs: number): string {
  const d = new Date(nowMs);
  const y = d.getMonth() === 0 ? d.getFullYear() - 1 : d.getFullYear();
  const m = d.getMonth() === 0 ? 12 : d.getMonth();
  return `${y}-${String(m).padStart(2, "0")}`;
}
