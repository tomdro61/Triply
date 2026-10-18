/**
 * The money behind the admin revenue charts (/admin "This month so far" and
 * /admin/numbers "Revenue and what we kept"). Pure and client-safe: the pages
 * fetch, these functions shape. Every figure comes from an existing source and
 * is never re-derived here:
 *
 *   paid  — what customers paid, split by product. From the reconciler
 *           (/api/admin/accounting) on /admin/numbers, from /api/admin/stats on
 *           the dashboard (instant; the reconciler is one ResLab + one Stripe
 *           lookup per booking).
 *   kept  — what Triply kept. ONLY from the reconciler's `triplyNet` — the same
 *           figures /admin/accounting shows — because the parking commission
 *           needs ResLab's per-reservation channel total.
 */
import { z } from "zod";

/** What customers paid, confirmed bookings only. */
export interface PaidMix {
  /** Parking incl. the part paid at the lot (grand_total) — mostly the lot's money. */
  parking: number;
  serviceFee: number;
  parkGuard: number;
  /** parking + serviceFee + parkGuard — the dashboard's "Gross Revenue". */
  total: number;
  /** Confirmed bookings behind the figures; null when the source doesn't say. */
  bookings: number | null;
  /** Confirmed bookings that bought Park Guard; null when the source doesn't say. */
  pgOptIns: number | null;
}

/** What Triply kept — accounting's `triplyNet`, under its own definitions. */
export interface KeptMix {
  /** Gross channel commission on parking (the contract figure). */
  parkingCommission: number;
  /** ResLab's channel fee ("RL Fee"), a cost against the commission. */
  reslabFee: number;
  /** Includes the service fee kept on refunded bookings. */
  serviceFee: number;
  /** Premiums − Park Guard wholesale (refunded opt-ins included; can be negative). */
  pgMargin: number;
  /** = commission − ResLab fee + service fee + PG margin. Accounting's "Triply revenue (gross)". */
  total: number;
  /** null when Stripe fee data is incomplete for the period. */
  stripeFees: number | null;
  /** total − Stripe fees: accounting's "net cash". null when stripeFees is null. */
  net: number | null;
}

export interface MoneyMix {
  paid: PaidMix;
  /** null when the reconciler couldn't produce a total — see keptReason. */
  kept: KeptMix | null;
  keptReason: string | null;
  /** Confirmed direct-lot bookings, which the reconciler keeps OUT of every figure. */
  directConfirmed: number;
}

/**
 * The slice of /api/admin/accounting the charts read. Separate from
 * monthly-numbers' accountingSliceSchema so a reconciler shape change breaks
 * the chart ("breakdown unavailable") without blanking the numbers table.
 */
export const accountingMixSchema = z.object({
  counts: z.object({ confirmed: z.number() }),
  grossRevenue: z.number(),
  confirmed: z.object({
    serviceFee: z.number(),
    pgPremium: z.number(),
    pgOptIns: z.number(),
  }),
  triplyNet: z.object({
    serviceFee: z.number(),
    pgMargin: z.number(),
    parkingChannelCommission: z.number().nullable(),
    reslabChannelFee: z.number().nullable(),
    total: z.number().nullable(),
    cashTotal: z.number().nullable(),
    stripeProcessingFees: z.number().nullable(),
    totalReason: z.string().nullable(),
  }),
  direct: z.object({ confirmed: z.number() }),
});
export type AccountingMix = z.infer<typeof accountingMixSchema>;

export function mixFromAccounting(a: AccountingMix): MoneyMix {
  const paid: PaidMix = {
    parking: a.grossRevenue,
    serviceFee: a.confirmed.serviceFee,
    parkGuard: a.confirmed.pgPremium,
    total: a.grossRevenue + a.confirmed.serviceFee + a.confirmed.pgPremium,
    bookings: a.counts.confirmed,
    pgOptIns: a.confirmed.pgOptIns,
  };
  const t = a.triplyNet;
  const kept: KeptMix | null =
    t.total !== null && t.parkingChannelCommission !== null && t.reslabChannelFee !== null
      ? {
          parkingCommission: t.parkingChannelCommission,
          reslabFee: t.reslabChannelFee,
          serviceFee: t.serviceFee,
          pgMargin: t.pgMargin,
          total: t.total,
          stripeFees: t.stripeProcessingFees,
          net: t.cashTotal,
        }
      : null;
  return {
    paid,
    kept,
    keptReason: kept ? null : (t.totalReason ?? "the reconciler returned no total"),
    directConfirmed: a.direct.confirmed,
  };
}

/**
 * The dashboard's this-month figures from /api/admin/stats: gross =
 * grand_total + service fee + PG premium over confirmed bookings, so parking is
 * what's left after the other two.
 */
export function paidFromStats(s: {
  gross: number;
  serviceFee: number;
  pgRevenue: number;
  confirmed: number;
  pgOptIns: number;
}): PaidMix {
  return {
    parking: s.gross - s.serviceFee - s.pgRevenue,
    serviceFee: s.serviceFee,
    parkGuard: s.pgRevenue,
    total: s.gross,
    bookings: s.confirmed,
    pgOptIns: s.pgOptIns,
  };
}

/** part ÷ whole, or null when whole isn't positive. */
export function share(part: number, whole: number): number | null {
  return whole > 0 ? part / whole : null;
}

/** The parking slice of what we kept: commission after ResLab's fee. */
export const netCommission = (k: KeptMix) => k.parkingCommission - k.reslabFee;

/** What we finally keep: net cash when Stripe fees are known, else the pre-Stripe total. */
export const bottomLine = (k: KeptMix) => k.net ?? k.total;

/**
 * Clean axis ticks from 0 up to at least `max`: steps of 1/2/2.5/5 × 10^n,
 * about `target` of them. Always starts at 0 and ends at or above `max`.
 */
export function niceTicks(max: number, target = 4): number[] {
  if (!(max > 0)) return [0, 1];
  const rough = max / target;
  const pow = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= rough) ?? 10 * pow;
  const ticks: number[] = [];
  for (let v = 0; v < max + step * 1e-9; v += step) ticks.push(Math.round(v * 100) / 100);
  if (ticks[ticks.length - 1] < max) ticks.push(Math.round((ticks[ticks.length - 1] + step) * 100) / 100);
  return ticks;
}

/** "$0", "$850", "$1.2K", "$12K" — for axis ticks and bar caps. */
export function compactMoney(n: number): string {
  const sign = n < 0 ? "−" : "";
  const a = Math.abs(n);
  if (a >= 1000) {
    const k = a / 1000;
    return `${sign}$${k >= 10 ? Math.round(k) : Math.round(k * 10) / 10}K`;
  }
  return `${sign}$${Math.round(a)}`;
}
