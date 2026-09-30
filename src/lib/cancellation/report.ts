/**
 * Pure aggregation for the admin cancellation report (migration 032). Kept out
 * of the stats route so the arithmetic is unit-testable (same split as
 * src/lib/attribution/report.ts).
 *
 * Rules:
 *  - A booking is CANCELLED when its status is `cancelled` or `refunded` — a
 *    refunding cancel writes `refunded`, so counting `cancelled` alone (what the
 *    dashboard's old "Cancelled" tile did) misses most of them.
 *  - The denominator is every booking that became a real reservation, i.e. all
 *    rows except `payment_failed` (never a reservation).
 *  - Months are the BOOKING's month (`created_at`, UTC `YYYY-MM`): "of the
 *    bookings made in May, how many were cancelled" — a cohort rate. There is
 *    no cancelled-at timestamp to bucket by.
 *  - NULL reason = `unknown` (every pre-032 row, and a customer who skipped
 *    the optional dropdown).
 */
import { CANCELLATION_REASONS, type CancellationReason } from "./reason-codes";

export interface CancellationReportRow {
  status: string;
  created_at: string;
  location_name: string | null;
  cancellation_reason: string | null;
  cancelled_by: string | null;
}

export type ReasonCounts = Record<CancellationReason, number>;

export interface CancellationMonth {
  month: string;
  bookings: number;
  cancelled: number;
  /** cancelled / bookings; 0 when there were no bookings. */
  rate: number;
  byReason: ReasonCounts;
}

export interface CancellationLot {
  lot: string;
  bookings: number;
  cancelled: number;
  rate: number;
  /** `lot_turned_away` + `lot_sold_out` — how often THIS lot turned our customer away. */
  lotFault: number;
}

export interface CancellationReport {
  totals: { bookings: number; cancelled: number; rate: number };
  byMonth: CancellationMonth[];
  byReason: Array<{ reason: CancellationReason; count: number }>;
  byCancelledBy: Array<{ by: string; count: number }>;
  byLot: CancellationLot[];
}

export const isCancelled = (status: string) => status === "cancelled" || status === "refunded";
const isBooking = (status: string) => status !== "payment_failed";

/** NULL or an unrecognised value → `unknown`. */
export function reasonOf(row: Pick<CancellationReportRow, "cancellation_reason">): CancellationReason {
  const r = row.cancellation_reason;
  return CANCELLATION_REASONS.find((k) => k === r) ?? "unknown";
}

const rate = (n: number, d: number) => (d === 0 ? 0 : n / d);

function emptyReasons(): ReasonCounts {
  const out = {} as ReasonCounts;
  for (const r of CANCELLATION_REASONS) out[r] = 0;
  return out;
}

export function buildCancellationReport(
  rows: CancellationReportRow[],
  { maxLots = 15 }: { maxLots?: number } = {},
): CancellationReport {
  const months = new Map<string, CancellationMonth>();
  const lots = new Map<string, CancellationLot>();
  const reasons = emptyReasons();
  const by = new Map<string, number>();
  let bookings = 0;
  let cancelled = 0;

  for (const row of rows) {
    if (!isBooking(row.status)) continue;
    const month = row.created_at.slice(0, 7);
    const lotName = row.location_name?.trim() || "Unknown lot";
    const m =
      months.get(month) ?? { month, bookings: 0, cancelled: 0, rate: 0, byReason: emptyReasons() };
    const l = lots.get(lotName) ?? { lot: lotName, bookings: 0, cancelled: 0, rate: 0, lotFault: 0 };
    bookings++;
    m.bookings++;
    l.bookings++;
    if (isCancelled(row.status)) {
      const reason = reasonOf(row);
      cancelled++;
      m.cancelled++;
      l.cancelled++;
      m.byReason[reason]++;
      reasons[reason]++;
      if (reason === "lot_turned_away" || reason === "lot_sold_out") l.lotFault++;
      const who = row.cancelled_by ?? "unknown";
      by.set(who, (by.get(who) ?? 0) + 1);
    }
    months.set(month, m);
    lots.set(lotName, l);
  }

  const byMonth = [...months.values()]
    .map((m) => ({ ...m, rate: rate(m.cancelled, m.bookings) }))
    .sort((a, b) => b.month.localeCompare(a.month));
  const byLot = [...lots.values()]
    .filter((l) => l.cancelled > 0)
    .map((l) => ({ ...l, rate: rate(l.cancelled, l.bookings) }))
    .sort((a, b) => b.cancelled - a.cancelled || b.rate - a.rate || a.lot.localeCompare(b.lot))
    .slice(0, maxLots);

  return {
    totals: { bookings, cancelled, rate: rate(cancelled, bookings) },
    byMonth,
    byReason: CANCELLATION_REASONS.map((reason) => ({ reason, count: reasons[reason] }))
      .filter((r) => r.count > 0)
      .sort((a, b) => b.count - a.count),
    byCancelledBy: [...by.entries()]
      .map(([k, count]) => ({ by: k, count }))
      .sort((a, b) => b.count - a.count),
    byLot,
  };
}
