import { z } from "zod";
import type { StatementItem } from "./payout-statement";

/**
 * Statement → ledger lines (Phase 6a, plan §3 "Mark paid"). Pure.
 *
 * payable / zero payout rows are written automatically at the rules' amount.
 * Every manual payout row and every adjustment candidate needs a person's
 * decision: pay an amount (with a note) or defer — a deferred row has no line,
 * so it comes back on the next statement. Missing decisions refuse the whole
 * statement; nothing is ever paid by default. A $0 adjustment records "reviewed,
 * the payout stands" — it binds the decision to the current basis, so the row is
 * not raised again until something changes. A typed amount is bounded: an
 * increase never takes a booking's total above its LIST-price parking + tax
 * (a "3821" typed for "38.21"; the most the rules could ever owe, share ≤ 100 %
 * — never the amount received, which a promo Triply absorbs can push below what
 * the lot is owed), and nothing takes it below $0.
 */

export const decisionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("pay"),
    amountCents: z.number().int().safe(),
    note: z.string().trim().min(1).max(500),
  }),
  z.object({ action: z.literal("defer") }),
]);
export type PayoutDecision = z.infer<typeof decisionSchema>;

export interface LedgerLine {
  stripe_payment_intent_id: string;
  reservation_number: string;
  kind: "payout" | "adjustment";
  amount_cents: number;
  basis: Record<string, unknown>;
  decision: "auto" | "manual";
  note: string | null;
  /** Adjustments only: the booking's line sum and line count the delta was computed against. */
  prior_lines_cents?: number;
  prior_lines_count?: number;
}

export type BuildLinesResult =
  | { ok: true; lines: LedgerLine[]; totalCents: number }
  | { ok: false; error: string };

/** The most a booking's lines may total: list-price parking + tax; only when that is unreadable, what Stripe received. */
function bookingCeiling(i: StatementItem): number | null {
  const { amountReceivedCents: received, subtotalCents, taxCents } = i.basis;
  return subtotalCents !== null && taxCents !== null ? subtotalCents + taxCents : received;
}

/** Shared with the browser form (payout-form.ts) so both refuse the same amounts. */
export function amountBoundError(i: StatementItem, amountCents: number): string | null {
  const before = i.lineKind === "payout" ? 0 : i.priorLinesCents;
  if (before === null) return "no baseline for the adjustment";
  const after = before + amountCents;
  if (after < 0) return i.lineKind === "payout" ? "a payout cannot be negative" : "would take back more than was ever paid for this booking";
  // Only an increase can create an excess; a $0 review or a claw-back never does.
  const ceiling = bookingCeiling(i);
  if (amountCents > 0 && ceiling === null) return "parking, tax and the Stripe amount are all unreadable — defer it until they read";
  if (amountCents > 0 && ceiling !== null && after > ceiling) {
    return `would bring this booking above its parking + tax at list price (${(ceiling / 100).toFixed(2)}) — check the amount (dollars and cents)`;
  }
  return null;
}

export function buildLedgerLines(items: StatementItem[], decisions: Record<string, PayoutDecision>): BuildLinesResult {
  const lines: LedgerLine[] = [];
  const known = new Set(items.map((i) => i.piId));
  const stray = Object.keys(decisions).filter((pi) => !known.has(pi));
  if (stray.length) return { ok: false, error: `decisions for bookings not on this statement: ${stray.join(", ")}` };

  for (const i of items) {
    const basis: Record<string, unknown> = { ...i.basis };
    const needsPerson = i.lineKind === "adjustment" || i.class === "manual";
    if (!needsPerson) {
      if (i.suggestedCents === null) return { ok: false, error: `${i.reservationNumber}: no amount` };
      if (decisions[i.piId]) return { ok: false, error: `${i.reservationNumber} is decided by the rules, not by hand` };
      lines.push({
        stripe_payment_intent_id: i.piId,
        reservation_number: i.reservationNumber,
        kind: "payout",
        amount_cents: i.suggestedCents,
        basis,
        decision: "auto",
        note: null,
      });
      continue;
    }
    const d = decisions[i.piId];
    if (!d) return { ok: false, error: `${i.reservationNumber} needs a decision (pay an amount or defer)` };
    if (d.action === "defer") continue;
    const bound = amountBoundError(i, d.amountCents);
    if (bound) return { ok: false, error: `${i.reservationNumber}: ${bound}` };
    if (i.lineKind === "payout") {
      lines.push({
        stripe_payment_intent_id: i.piId,
        reservation_number: i.reservationNumber,
        kind: "payout",
        amount_cents: d.amountCents,
        basis,
        decision: "manual",
        note: d.note,
      });
    } else {
      if (i.priorLinesCents === null || i.priorLinesCount === null) {
        return { ok: false, error: `${i.reservationNumber}: no baseline for the adjustment` };
      }
      lines.push({
        stripe_payment_intent_id: i.piId,
        reservation_number: i.reservationNumber,
        kind: "adjustment",
        amount_cents: d.amountCents,
        basis: { ...basis, priorLinesCents: i.priorLinesCents, priorLinesCount: i.priorLinesCount },
        decision: "manual",
        note: d.note,
        prior_lines_cents: i.priorLinesCents,
        prior_lines_count: i.priorLinesCount,
      });
    }
  }
  if (lines.length === 0) return { ok: false, error: "nothing to pay on this statement" };
  const totalCents = lines.reduce((s, l) => s + l.amount_cents, 0);
  return { ok: true, lines, totalCents };
}
