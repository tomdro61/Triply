import { createHash } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/server";
import { toCents } from "@/lib/booking/cost-breakdown";
import { classifyPayout, adjustmentCandidate, type PayoutBasis, type PayoutClass } from "./payout";
import { readPayoutStripeMany, type PayoutStripeRead } from "./payout-stripe";

/**
 * The statement for one direct lot and one check-out month (Phase 6a — plan
 * notes/2026-10-12-direct-lots-phase6-plan.md §3 + §3.1), computed server-side
 * from the bookings, their terms, the ledger and a fresh Stripe read:
 *   (a) every booking of the lot, in this Stripe mode, that checked out before
 *       the end of the month and has NO payout line yet — so a late fulfilment
 *       or a check-out moved across months lands on the next open statement;
 *   (b) every booking that HAS lines (checked out within the look-back) whose
 *       amount now due differs from what its lines sum to, or whose state now
 *       needs a person — unless a person already decided it on the same basis.
 *       Always a person's decision.
 * Every read is paged (PostgREST returns at most 1,000 rows per request, with
 * no error), so nothing is silently cut off. The view carries a hash of
 * everything an amount depends on; mark-paid refuses when the hash it was
 * shown no longer matches (a refund landed).
 */

/** Adjustments are looked for on bookings that checked out within this window before the month ends. */
export const ADJUSTMENT_LOOKBACK_DAYS = 180;
/** PostgREST's per-request row cap; every read pages at this size. */
const PAGE = 1_000;
/** A read that would exceed this many rows is refused, never truncated. */
const MAX_READ_ROWS = 100_000;
/** One Stripe read per booking on the statement; above this it is refused (admin request time). */
const MAX_STRIPE_READS = 1_500;
const DB_TIMEOUT_MS = 10_000;

export const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export interface StatementBooking {
  piId: string;
  reservationNumber: string;
  checkIn: string;
  checkOut: string;
  status: string;
}

export interface StatementItem extends StatementBooking {
  /** payout = no payout line yet; adjustment = has lines and the amount due changed. */
  lineKind: "payout" | "adjustment";
  class: PayoutClass["kind"];
  /** Payout rows: what the rules say is due. Adjustment rows: the delta (null = a person must decide). */
  suggestedCents: number | null;
  reason: string | null;
  /** Adjustment rows: what the booking's lines sum to now (sent to the database as the baseline). */
  priorLinesCents: number | null;
  /** How many lines the booking had — a $0 review changes the count, not the sum. */
  priorLinesCount: number | null;
  basis: PayoutBasis;
  /** Internal only — never in the lot-facing CSV. */
  margin: { stripeFeeCents: number | null; pgWholesaleCents: number | null; marginCents: number | null };
}

export interface StatementView {
  lotId: string;
  month: string;
  livemode: boolean;
  /** Lot-local "now" (the lot's CMS timezone) is on or after the first day of the next month. */
  monthClosed: boolean;
  timezone: string;
  paid: { id: string; totalCents: number; paidAt: string; paidBy: string; emailId: string | null; attempts: number } | null;
  items: StatementItem[];
  /** Bookings that cannot be put on a statement at all (no PaymentIntent, no terms row, a broken ledger). */
  blocked: Array<StatementBooking & { reason: string }>;
  totals: { autoCents: number; payableCount: number; zeroCount: number; manualCount: number; adjustmentCount: number };
  viewHash: string;
}

interface BookingRow {
  stripe_payment_intent_id: string | null;
  reslab_reservation_number: string;
  direct_lot_id: string;
  livemode: boolean;
  status: string;
  cancel_state: string | null;
  cancel_claimed_at: string | null;
  check_in: string;
  check_out: string;
  location_timezone: string | null;
  lot_snapshot: { timezone?: unknown } | null;
  subtotal: string | number | null;
  tax_total: string | number | null;
  triply_service_fee: string | number | null;
  protection_plan_wholesale: string | number | null;
}

interface TermsRow {
  stripe_payment_intent_id: string;
  direct_lot_id: string;
  livemode: boolean;
  partner_share_percent: string | number;
  tax_collected_by: string;
}

interface PaidRow {
  id: string;
  total_cents: number | string;
  paid_at: string;
  paid_by: string;
  statement_email_id: string | null;
  statement_attempts: number;
}

interface LineRow {
  stripe_payment_intent_id: string;
  kind: "payout" | "adjustment";
  amount_cents: number | string;
  decision: "auto" | "manual";
  basis: Record<string, unknown>;
}

type PageResult<T> = PromiseLike<{ data: T[] | null; error: { message: string; code?: string } | null }>;

/** Every row, page by page under a stable order; refuses rather than truncate. */
async function readAll<T>(label: string, page: (from: number, to: number) => PageResult<T>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    if (from >= MAX_READ_ROWS) throw new Error(`${label}: more than ${MAX_READ_ROWS} rows — refusing to build a truncated statement`);
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) throw new Error(`${label} read failed: ${error.code ?? "?"} ${error.message}`);
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

export function nextMonthStart(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
}

/** Lot-local calendar date "YYYY-MM-DD"; null for an unknown zone. */
export function localDate(nowMs: number, timeZone: string): string | null {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(nowMs);
  } catch {
    return null;
  }
}

function minusDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`); // calendar arithmetic on a date-only value, no wall clock involved
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/** Canonical JSON (sorted keys) so the hash does not depend on property order. */
function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
}

/** Order-independent: rows are sorted before hashing, so tied check-out times can never change it. */
export function hashItems(items: StatementItem[], blocked: StatementView["blocked"]): string {
  const key = (i: StatementItem) => `${i.piId}:${i.lineKind}`;
  const material = {
    items: [...items]
      .sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0))
      .map((i) => [i.piId, i.lineKind, i.class, i.suggestedCents, i.priorLinesCents, i.priorLinesCount, i.basis]),
    blocked: blocked.map((b) => `${b.piId || b.reservationNumber}:${b.reason}`).sort(),
  };
  return createHash("sha256").update(canonical(material)).digest("hex");
}

const wallClock = (v: string) => v.replace("T", " ").slice(0, 19);

export async function buildStatementView(opts: {
  lotId: string;
  month: string;
  livemode: boolean;
  /** The lot's own timezone (CMS) — decides when the month is over. */
  lotTimezone: string;
  nowMs: number;
}): Promise<StatementView> {
  const { lotId, month, livemode } = opts;
  if (!MONTH_PATTERN.test(month)) throw new Error(`invalid month '${month}'`);
  const next = nextMonthStart(month);
  const supabase = await createAdminClient();
  const signal = () => AbortSignal.timeout(DB_TIMEOUT_MS);

  const [bookings, termsRows, lineRows, paidRes] = await Promise.all([
    readAll<BookingRow>("bookings", (from, to) =>
      supabase
        .from("bookings")
        .select(
          "stripe_payment_intent_id, reslab_reservation_number, direct_lot_id, livemode, status, cancel_state, cancel_claimed_at, check_in, check_out, location_timezone, lot_snapshot, subtotal, tax_total, triply_service_fee, protection_plan_wholesale"
        )
        .eq("inventory_source", "direct")
        .eq("direct_lot_id", lotId)
        .eq("livemode", livemode)
        // TIMESTAMP (wall clock) column: a literal compare, no timezone applied.
        .lt("check_out", `${next}T00:00:00`)
        .order("check_out", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to)
        .abortSignal(signal())
        .returns<BookingRow[]>()
    ),
    readAll<TermsRow>("terms", (from, to) =>
      supabase
        .from("direct_booking_terms")
        .select("stripe_payment_intent_id, direct_lot_id, livemode, partner_share_percent, tax_collected_by")
        .eq("direct_lot_id", lotId)
        .eq("livemode", livemode)
        .order("stripe_payment_intent_id", { ascending: true })
        .range(from, to)
        .abortSignal(signal())
        .returns<TermsRow[]>()
    ),
    readAll<LineRow>("ledger", (from, to) =>
      supabase
        .from("direct_lot_payout_lines")
        .select("stripe_payment_intent_id, kind, amount_cents, decision, basis")
        .eq("direct_lot_id", lotId)
        .eq("livemode", livemode)
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to)
        .abortSignal(signal())
        .returns<LineRow[]>()
    ),
    supabase
      .from("direct_lot_statements")
      .select("id, total_cents, paid_at, paid_by, statement_email_id, statement_attempts")
      .eq("direct_lot_id", lotId)
      .eq("period_month", `${month}-01`)
      .eq("livemode", livemode)
      .abortSignal(signal())
      .maybeSingle<PaidRow>(),
  ]);
  if (paidRes.error) throw new Error(`statement read failed: ${paidRes.error.message}`);

  const terms = new Map(termsRows.map((t) => [t.stripe_payment_intent_id, t]));
  // Lines come oldest first, so the last one seen per booking is its latest.
  const linesByPi = new Map<string, { hasPayout: boolean; sumCents: number; count: number; lastPersonBasis: Record<string, unknown> | null }>();
  for (const l of lineRows) {
    const amount = Number(l.amount_cents); // BIGINT may arrive as a string; integer by construction
    if (!Number.isSafeInteger(amount)) throw new Error(`ledger amount unreadable for ${l.stripe_payment_intent_id}`);
    const cur = linesByPi.get(l.stripe_payment_intent_id) ?? { hasPayout: false, sumCents: 0, count: 0, lastPersonBasis: null };
    cur.sumCents += amount;
    cur.count += 1;
    if (l.kind === "payout") cur.hasPayout = true;
    cur.lastPersonBasis = l.decision === "manual" ? l.basis : null;
    linesByPi.set(l.stripe_payment_intent_id, cur);
  }

  const lookbackFloor = minusDays(next, ADJUSTMENT_LOOKBACK_DAYS);
  const blocked: StatementView["blocked"] = [];
  const toRead: Array<{ b: BookingRow; pi: string; t: TermsRow }> = [];
  for (const b of bookings) {
    const pi = b.stripe_payment_intent_id;
    const base = { piId: pi ?? "", reservationNumber: b.reslab_reservation_number, checkIn: wallClock(b.check_in), checkOut: wallClock(b.check_out), status: b.status };
    if (!pi) {
      blocked.push({ ...base, reason: "no PaymentIntent on the booking" });
      continue;
    }
    const lines = linesByPi.get(pi);
    if (lines && wallClock(b.check_out).slice(0, 10) < lookbackFloor) continue; // settled long ago
    const t = terms.get(pi);
    // Without its terms row a booking cannot be put on the ledger at all (the
    // line's foreign key) — a person must restore the terms first.
    if (!t) {
      blocked.push({ ...base, reason: "no terms row for this booking in this lot and mode" });
      continue;
    }
    toRead.push({ b, pi, t });
  }
  if (toRead.length > MAX_STRIPE_READS) {
    throw new Error(`${toRead.length} bookings to read from Stripe (more than ${MAX_STRIPE_READS}) — refusing`);
  }

  const stripeReads = await readPayoutStripeMany(toRead.map((r) => r.pi));

  const items: StatementItem[] = [];
  for (const { b, pi, t } of toRead) {
    const snapTz = b.lot_snapshot && typeof b.lot_snapshot.timezone === "string" ? b.lot_snapshot.timezone : null;
    const timezone = b.location_timezone ?? snapTz;
    const s: PayoutStripeRead | undefined = stripeReads.get(pi);
    const cls = classifyPayout({
      stripePaymentIntentId: pi,
      reservationNumber: b.reslab_reservation_number,
      directLotId: b.direct_lot_id,
      livemode: b.livemode,
      status: b.status,
      cancelState: b.cancel_state,
      cancelClaimedAt: b.cancel_claimed_at,
      checkIn: b.check_in,
      checkOut: b.check_out,
      timezone,
      subtotal: b.subtotal,
      taxTotal: b.tax_total,
      serviceFee: b.triply_service_fee,
      pgWholesale: b.protection_plan_wholesale,
      terms: { directLotId: t.direct_lot_id, livemode: t.livemode, sharePercent: t.partner_share_percent, taxCollectedBy: t.tax_collected_by },
      stripe: s ?? null,
    });
    const base: StatementBooking = { piId: pi, reservationNumber: b.reslab_reservation_number, checkIn: wallClock(b.check_in), checkOut: wallClock(b.check_out), status: b.status };
    const pgWholesaleCents = toCents(b.protection_plan_wholesale ?? 0);
    const stripeFeeCents = s?.feeCents ?? null;
    const lines = linesByPi.get(pi);

    if (!lines) {
      const suggested = cls.kind === "manual" ? null : cls.amountCents;
      // Margin (payable rows only) = received − refunded − payout − Stripe fee − PG wholesale − tax Triply
      // owes the city (a liability, not margin). Zero / refunded rows show none (plan §3.1).
      const triplyTax = t.tax_collected_by === "triply" ? cls.basis.taxCents : 0;
      const marginCents =
        cls.kind === "payable" && s?.amountReceivedCents != null && stripeFeeCents !== null && pgWholesaleCents !== null && triplyTax !== null
          ? s.amountReceivedCents - (s.amountRefundedCents ?? 0) - cls.amountCents - stripeFeeCents - pgWholesaleCents - triplyTax
          : null;
      items.push({
        ...base,
        lineKind: "payout",
        class: cls.kind,
        suggestedCents: suggested,
        reason: cls.kind === "manual" ? cls.reason : null,
        priorLinesCents: null,
        priorLinesCount: null,
        basis: cls.basis,
        margin: { stripeFeeCents, pgWholesaleCents, marginCents },
      });
      continue;
    }
    if (!lines.hasPayout) {
      // Adjustments only ever follow a payout (the database enforces it); a
      // booking with lines but no payout line cannot exist — surface it.
      blocked.push({ ...base, reason: "ledger has adjustment lines but no payout line" });
      continue;
    }
    const adj = adjustmentCandidate(cls, lines.sumCents, lines.lastPersonBasis);
    if (!adj) continue;
    items.push({
      ...base,
      lineKind: "adjustment",
      class: cls.kind,
      suggestedCents: adj.deltaCents,
      reason: adj.reason,
      priorLinesCents: lines.sumCents,
      priorLinesCount: lines.count,
      basis: cls.basis,
      margin: { stripeFeeCents, pgWholesaleCents, marginCents: null },
    });
  }

  const today = localDate(opts.nowMs, opts.lotTimezone);
  const totals = { autoCents: 0, payableCount: 0, zeroCount: 0, manualCount: 0, adjustmentCount: 0 };
  for (const i of items) {
    if (i.lineKind === "adjustment") totals.adjustmentCount++;
    else if (i.class === "payable") {
      totals.payableCount++;
      totals.autoCents += i.suggestedCents ?? 0;
    } else if (i.class === "zero") totals.zeroCount++;
    else totals.manualCount++;
  }

  const p = paidRes.data;
  const paidTotal = p ? Number(p.total_cents) : null; // BIGINT may arrive as a string
  if (paidTotal !== null && !Number.isSafeInteger(paidTotal)) throw new Error("paid statement total unreadable");
  return {
    lotId,
    month,
    livemode,
    monthClosed: today !== null && today >= next,
    timezone: opts.lotTimezone,
    paid: p && paidTotal !== null
      ? { id: p.id, totalCents: paidTotal, paidAt: p.paid_at, paidBy: p.paid_by, emailId: p.statement_email_id, attempts: p.statement_attempts }
      : null,
    items,
    blocked,
    totals,
    viewHash: hashItems(items, blocked),
  };
}
