import { createAdminClient } from "@/lib/supabase/server";
import { classifyPayout, adjustmentCandidate, directMargin, type PayoutClass } from "@/lib/direct/payout";
import { summariseLines, type LineRow, type LinesSummary } from "@/lib/direct/payout-statement";
import type { PayoutStripeRead } from "@/lib/direct/payout-stripe";
import type { DirectBookingDetail, DirectDetail, DirectSum } from "./types";

/**
 * Direct-lot bookings in the accounting report: what Triply made on each one,
 * by the same rules as the payout statement (`classifyPayout`, the ledger,
 * `directMargin`). Integer cents. Read-only.
 *
 * What the lot is owed for a booking:
 *   - it has ledger lines and nothing changed since (`adjustmentCandidate` is
 *     null) → what was recorded as paid (the ledger sum);
 *   - it has ledger lines and something changed → "adjustment pending", no figure;
 *   - no ledger lines → the rules' amount, or "needs a decision" for a row only
 *     a person can decide.
 * A row whose payment could not be read from Stripe is "not read": no figure,
 * never an estimate of Triply's revenue.
 */

/** The columns of a direct booking the report's shared select already carries. */
export interface DirectRowInput {
  id: string;
  reslab_reservation_number: string;
  status: string;
  check_in: string;
  check_out: string;
  location_name: string | null;
  stripe_payment_intent_id: string | null;
  direct_lot_id: string | null;
  livemode: boolean | null;
  subtotal: string | number | null;
  triply_service_fee: string | number | null;
  protection_plan_wholesale: string | number | null;
}

/** The extra columns the payout rules need, read by id for direct rows only. */
interface ExtraRow {
  id: string;
  cancel_state: string | null;
  cancel_claimed_at: string | null;
  location_timezone: string | null;
  lot_snapshot: { timezone?: unknown } | null;
  tax_total: string | number | null;
}

interface TermsRow {
  stripe_payment_intent_id: string;
  direct_lot_id: string;
  livemode: boolean;
  partner_share_percent: string | number;
  tax_collected_by: string;
}

/** Ids per `.in()` request (URL length) and rows per page (PostgREST's cap). */
const IN_CHUNK = 100;
const PAGE = 1_000;
const DB_TIMEOUT_MS = 10_000;

type PageResult<T> = PromiseLike<{ data: T[] | null; error: { message: string; code?: string } | null }>;

/** Every row for every id, chunk by chunk and page by page; throws rather than truncate. */
async function readByIds<T>(
  label: string,
  ids: string[],
  page: (chunk: string[], from: number, to: number) => PageResult<T>
): Promise<T[]> {
  const out: T[] = [];
  for (let c = 0; c < ids.length; c += IN_CHUNK) {
    const chunk = ids.slice(c, c + IN_CHUNK);
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await page(chunk, from, from + PAGE - 1);
      if (error) throw new Error(`${label} read failed: ${error.code ?? "?"} ${error.message}`);
      const rows = data ?? [];
      out.push(...rows);
      if (rows.length < PAGE) break;
    }
  }
  return out;
}

const wallClock = (v: string) => v.replace("T", " ").slice(0, 19);

/**
 * One booking's figures. Pure.
 * `read`: the strict Stripe reading, or null when Stripe was not read for this
 * row (`notReadReason` says why).
 */
export function resolveDirectRow(
  b: DirectRowInput,
  extra: ExtraRow | undefined,
  terms: TermsRow | undefined,
  lines: LinesSummary | undefined,
  read: PayoutStripeRead | null,
  notReadReason: string
): DirectBookingDetail {
  const base: DirectBookingDetail = {
    reservationNumber: b.reslab_reservation_number,
    status: b.status,
    checkIn: wallClock(b.check_in),
    checkOut: wallClock(b.check_out),
    lotName: b.location_name ?? "",
    state: "ok",
    reason: null,
    receivedCents: null,
    refundedCents: null,
    owedToLotCents: null,
    owedSource: null,
    stripeFeeCents: null,
    grossCents: null,
    netCents: null,
  };
  const pi = b.stripe_payment_intent_id;
  if (!pi) return { ...base, state: "blocked", reason: "no PaymentIntent on the booking" };
  if (!extra) return { ...base, state: "blocked", reason: "booking columns could not be read" };
  if (!read) return { ...base, state: "not_read", reason: notReadReason };
  if (read.error !== null) return { ...base, state: "not_read", reason: `Stripe could not be read (${read.error})` };

  const received = read.amountReceivedCents;
  const refundedRaw = read.amountRefundedCents;
  // Stripe reports a released hold as "refunded" though nothing was received: cap at what was received.
  const refunded = received === null || refundedRaw === null ? null : Math.min(refundedRaw, received);
  const money = { ...base, receivedCents: received, refundedCents: refunded };
  if (!terms) return { ...money, state: "blocked", reason: "no terms row for this booking" };

  const snapTz = extra.lot_snapshot && typeof extra.lot_snapshot.timezone === "string" ? extra.lot_snapshot.timezone : null;
  const cls: PayoutClass = classifyPayout({
    stripePaymentIntentId: pi,
    reservationNumber: b.reslab_reservation_number,
    directLotId: b.direct_lot_id ?? "",
    // Test-mode rows never reach the report (isTestBooking); NULL = a pre-015 row, which is live.
    livemode: b.livemode !== false,
    status: b.status,
    cancelState: extra.cancel_state,
    cancelClaimedAt: extra.cancel_claimed_at,
    checkIn: b.check_in,
    checkOut: b.check_out,
    timezone: extra.location_timezone ?? snapTz,
    subtotal: b.subtotal,
    taxTotal: extra.tax_total,
    serviceFee: b.triply_service_fee,
    pgWholesale: b.protection_plan_wholesale,
    terms: { directLotId: terms.direct_lot_id, livemode: terms.livemode, sharePercent: terms.partner_share_percent, taxCollectedBy: terms.tax_collected_by },
    stripe: read,
  });
  // Nothing received = no charge, so no fee (a released hold).
  const fee = read.feeCents ?? (received === 0 ? 0 : null);
  const withFigures = (owed: number, source: "rule" | "ledger", net: number | null): DirectBookingDetail => ({
    ...money,
    owedToLotCents: owed,
    owedSource: source,
    stripeFeeCents: fee,
    netCents: net,
    grossCents: net !== null && fee !== null ? net + fee : null,
    ...(net === null ? { state: "no_figure" as const, reason: "a figure it needs is unknown (e.g. the Stripe fee)" } : {}),
  });

  if (!lines) {
    if (cls.kind === "manual") return { ...money, stripeFeeCents: fee, state: "needs_decision", reason: cls.reason };
    return withFigures(cls.amountCents, "rule", directMargin(cls, fee));
  }
  if (!lines.hasPayout) return { ...money, state: "blocked", reason: "ledger has adjustment lines but no payout line" };
  const adj = adjustmentCandidate(cls, lines.sumCents, lines.lastPersonBasis);
  if (adj) {
    return { ...money, owedToLotCents: lines.sumCents, owedSource: "ledger", stripeFeeCents: fee, state: "adjustment_pending", reason: adj.reason };
  }
  if (cls.kind !== "manual") return withFigures(lines.sumCents, "ledger", directMargin(cls, fee, lines.sumCents));
  // A person decided this booking and nothing changed since. Its figure is only safe when the
  // money Stripe shows is the whole story: a dispute's outcome is not in received / refunded,
  // and whether Triply still remits the tax on such a booking is not recorded.
  const basis = cls.basis;
  if (basis.stripeDisputed !== false || b.status === "disputed") {
    return { ...money, owedToLotCents: lines.sumCents, owedSource: "ledger", stripeFeeCents: fee, state: "no_figure", reason: "disputed: the dispute's outcome is not in these figures" };
  }
  if (basis.taxCollectedBy !== "lot") {
    return { ...money, owedToLotCents: lines.sumCents, owedSource: "ledger", stripeFeeCents: fee, state: "no_figure", reason: "decided by hand; the tax Triply remits on it is not recorded" };
  }
  const net =
    received === null || refunded === null || fee === null || basis.pgWholesaleCents === null
      ? null
      : received - refunded - lines.sumCents - fee - basis.pgWholesaleCents;
  return withFigures(lines.sumCents, "ledger", net);
}

function sum(rows: DirectBookingDetail[], pick: (r: DirectBookingDetail) => number | null): DirectSum {
  const known = rows.map(pick).filter((v): v is number => v !== null);
  return { cents: known.reduce((a, v) => a + v, 0), known: known.length, of: rows.length };
}

export function directTotals(rows: DirectBookingDetail[]): DirectDetail["totals"] {
  return {
    collected: sum(rows, (r) => (r.receivedCents === null || r.refundedCents === null ? null : r.receivedCents - r.refundedCents)),
    owedToLots: sum(rows, (r) => (r.netCents === null ? null : r.owedToLotCents)),
    gross: sum(rows, (r) => r.grossCents),
    stripeFees: sum(rows, (r) => (r.netCents === null ? null : r.stripeFeeCents)),
    net: sum(rows, (r) => r.netCents),
  };
}

/**
 * Reads the terms, ledger lines and extra booking columns for the report's
 * direct rows and resolves each one. Throws on a failed read (the caller turns
 * that into `detail: { error }`, never a 500 for the whole report).
 */
export async function buildDirectDetail(
  rows: DirectRowInput[],
  reads: Array<PayoutStripeRead | null>,
  notReadReason: string
): Promise<DirectDetail> {
  if (rows.length === 0) return { bookings: [], totals: directTotals([]) };
  const supabase = await createAdminClient();
  const signal = () => AbortSignal.timeout(DB_TIMEOUT_MS);
  const ids = rows.map((r) => r.id);
  const pis = [...new Set(rows.map((r) => r.stripe_payment_intent_id).filter((p): p is string => !!p))];

  const [extras, termsRows, lineRows] = await Promise.all([
    readByIds<ExtraRow>("direct bookings", ids, (chunk, from, to) =>
      supabase
        .from("bookings")
        .select("id, cancel_state, cancel_claimed_at, location_timezone, lot_snapshot, tax_total")
        .in("id", chunk)
        .order("id", { ascending: true })
        .range(from, to)
        .abortSignal(signal())
        .returns<ExtraRow[]>()
    ),
    readByIds<TermsRow>("direct terms", pis, (chunk, from, to) =>
      supabase
        .from("direct_booking_terms")
        .select("stripe_payment_intent_id, direct_lot_id, livemode, partner_share_percent, tax_collected_by")
        .in("stripe_payment_intent_id", chunk)
        .order("stripe_payment_intent_id", { ascending: true })
        .range(from, to)
        .abortSignal(signal())
        .returns<TermsRow[]>()
    ),
    // Oldest first: a booking's lines all fall in one chunk, so its latest line is seen last.
    readByIds<LineRow>("direct ledger", pis, (chunk, from, to) =>
      supabase
        .from("direct_lot_payout_lines")
        .select("stripe_payment_intent_id, kind, amount_cents, decision, basis")
        .in("stripe_payment_intent_id", chunk)
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to)
        .abortSignal(signal())
        .returns<LineRow[]>()
    ),
  ]);

  const extraById = new Map(extras.map((e) => [e.id, e]));
  const termsByPi = new Map(termsRows.map((t) => [t.stripe_payment_intent_id, t]));
  const linesByPi = summariseLines(lineRows);
  const bookings = rows.map((b, i) => {
    const pi = b.stripe_payment_intent_id;
    return resolveDirectRow(b, extraById.get(b.id), pi ? termsByPi.get(pi) : undefined, pi ? linesByPi.get(pi) : undefined, reads[i] ?? null, notReadReason);
  });
  return { bookings, totals: directTotals(bookings) };
}
