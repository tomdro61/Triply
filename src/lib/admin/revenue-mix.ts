/**
 * The money behind the admin revenue charts (/admin "This month so far" and
 * /admin/numbers "Revenue and what we kept"). Pure and client-safe: the pages
 * fetch, these functions shape.
 *
 *   paid  — what customers paid, split by product. From the reconciler
 *           (/api/admin/accounting) — the same booking set as `kept`. The
 *           dashboard shows /api/admin/stats' figures only while the
 *           reconciler loads; those INCLUDE direct-lot bookings, which the
 *           reconciler leaves out, so they're never put next to `kept`.
 *   kept  — what Triply kept. ONLY from the reconciler's `triplyNet`, the
 *           figures /admin/accounting shows, never re-derived here: the
 *           parking commission needs ResLab's per-reservation channel total.
 */
import { z } from "zod";
import { formatPrice } from "@/lib/utils";

/** What customers paid, confirmed bookings only. */
export interface PaidMix {
  /** Parking incl. the part paid at the lot (grand_total) — mostly the lot's money. */
  parking: number;
  serviceFee: number;
  parkGuard: number;
  /** What customers paid in all (accounting's grossCustomerSpend). */
  total: number;
  /** Confirmed bookings behind the figures. */
  bookings: number;
  /** Confirmed bookings that bought Park Guard. */
  pgOptIns: number;
}

/** What Triply kept — accounting's `triplyNet`, under its own definitions. */
export interface KeptMix {
  /** Gross channel commission on parking (the contract figure). */
  parkingCommission: number;
  /** ResLab's channel fee ("RL Fee"), a cost against the commission. */
  reslabFee: number;
  /** Includes the service fee kept on refunded bookings. */
  serviceFee: number;
  /** Premiums − Park Guard wholesale, refunded opt-ins included; can be negative. */
  pgMargin: number;
  /** = commission − ResLab fee + service fee + PG margin. Accounting's "Triply revenue (gross)". */
  total: number;
  /** null when Stripe fee data is incomplete for the period. */
  stripeFees: number | null;
  /** total − Stripe fees: accounting's "net cash". null when stripeFees is null. */
  net: number | null;
}

interface MoneyMixBase {
  paid: PaidMix;
  /** Confirmed direct-lot bookings, which the reconciler keeps OUT of every figure. */
  directConfirmed: number;
  /**
   * Park Guard opt-ins with no wholesale on the row (pre-migration-022): they
   * count $0 cost, so PG margin and every kept total are OVER-stated until
   * repaired. Accounting warns about the same rows.
   */
  pgWholesaleMissing: number;
}
export type MoneyMix = MoneyMixBase &
  ({ kept: KeptMix; keptReason: null } | { kept: null; keptReason: string });

/** What the "What we kept" side shows: figures, still loading, or why not. */
export type KeptState = KeptMix | "loading" | { unavailable: string };

export const keptStateOf = (mix: MoneyMix): KeptState => mix.kept ?? { unavailable: mix.keptReason };

/**
 * A result safe to keep for later: profit known, no Park Guard rows known to
 * overstate it. Anything else is usually a transient ResLab/Stripe miss or a
 * data repair in progress — ask again rather than serve it from a cache.
 */
export const isDefinitive = (mix: MoneyMix): boolean => mix.kept !== null && mix.pgWholesaleMissing === 0;

/**
 * The slice of /api/admin/accounting the charts read. Separate from
 * monthly-numbers' accountingSliceSchema so a reconciler shape change breaks
 * the chart ("breakdown unavailable") without blanking the numbers table.
 */
export const accountingMixSchema = z.object({
  counts: z.object({ confirmed: z.number() }),
  grossRevenue: z.number(),
  grossCustomerSpend: z.number(),
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
  pgWholesaleMissingReservations: z.array(z.string()),
});
export type AccountingMix = z.infer<typeof accountingMixSchema>;

/** Where a failed parse broke — a few field paths, for the message and Sentry. */
export const schemaIssuePaths = (error: z.ZodError): string =>
  error.issues
    .slice(0, 3)
    .map((i) => i.path.join(".") || "(root)")
    .join(", ");

export function mixFromAccounting(a: AccountingMix): MoneyMix {
  const base: MoneyMixBase = {
    paid: {
      parking: a.grossRevenue,
      serviceFee: a.confirmed.serviceFee,
      parkGuard: a.confirmed.pgPremium,
      total: a.grossCustomerSpend,
      bookings: a.counts.confirmed,
      pgOptIns: a.confirmed.pgOptIns,
    },
    directConfirmed: a.direct.confirmed,
    pgWholesaleMissing: a.pgWholesaleMissingReservations.length,
  };
  const t = a.triplyNet;
  if (t.total === null || t.parkingChannelCommission === null || t.reslabChannelFee === null) {
    return { ...base, kept: null, keptReason: t.totalReason ?? "the reconciler returned no total" };
  }
  return {
    ...base,
    kept: {
      parkingCommission: t.parkingChannelCommission,
      reslabFee: t.reslabChannelFee,
      serviceFee: t.serviceFee,
      pgMargin: t.pgMargin,
      total: t.total,
      stripeFees: t.stripeProcessingFees,
      net: t.cashTotal,
    },
    keptReason: null,
  };
}

/** The slice of /api/admin/stats the dashboard's instant revenue figures read. */
export interface StatsThisMonth {
  revenue: { gross: { thisMonth: number }; triply: { thisMonth: number } };
  parkGuard: {
    revenue: { thisMonth: number };
    count: { thisMonth: number };
    confirmedTotal: { thisMonth: number };
  };
}

/**
 * The dashboard's this-month figures from /api/admin/stats, shown only while
 * the reconciler loads. stats' gross = grand_total + service fee + PG premium
 * over confirmed bookings (direct lots INCLUDED), so parking is what's left.
 */
export function paidFromStats(s: StatsThisMonth): PaidMix {
  const gross = s.revenue.gross.thisMonth;
  const serviceFee = s.revenue.triply.thisMonth;
  const parkGuard = s.parkGuard.revenue.thisMonth;
  return {
    parking: gross - serviceFee - parkGuard,
    serviceFee,
    parkGuard,
    total: gross,
    bookings: s.parkGuard.confirmedTotal.thisMonth,
    pgOptIns: s.parkGuard.count.thisMonth,
  };
}

/** part ÷ whole, or null when whole isn't positive. */
export function share(part: number, whole: number): number | null {
  return whole > 0 ? part / whole : null;
}

/** The parking slice of what we kept: commission after ResLab's fee. Negative when the fee is bigger. */
export const netCommission = (k: KeptMix) => k.parkingCommission - k.reslabFee;

/** What we finally keep: net cash when Stripe fees are known, else the pre-Stripe total. */
export const bottomLine = (k: KeptMix) => k.net ?? k.total;

/** The three kept slices, bottom to top of a stack. They sum to `k.total`. */
export const keptSlices = (k: KeptMix) => ({
  commission: netCommission(k),
  serviceFee: k.serviceFee,
  pgMargin: k.pgMargin,
});

/** How far a signed stack reaches above and below zero. */
export function stackExtent(values: number[]): { up: number; down: number } {
  let up = 0;
  let down = 0;
  for (const v of values) {
    if (v > 0) up += v;
    else if (v < 0) down += v;
  }
  return { up, down };
}

/**
 * Clean axis ticks covering [lo, hi] (lo ≤ 0 ≤ hi): steps of 1/2/2.5/5 × 10^n,
 * about `target` intervals, always including 0. Never fewer than two ticks,
 * never a step under one dollar, never a non-finite value.
 */
export function axisTicks(lo: number, hi: number, target = 4): number[] {
  const top = Number.isFinite(hi) ? Math.max(0, hi) : 0;
  const bottom = Number.isFinite(lo) ? Math.min(0, lo) : 0;
  const span = Math.max(top - bottom, 1);
  const rough = span / target;
  const pow = 10 ** Math.floor(Math.log10(rough));
  const step = Math.max(1, [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= rough) ?? 10 * pow);
  const first = Math.floor(bottom / step + 1e-9);
  const last = Math.max(Math.ceil(top / step - 1e-9), first === 0 ? 1 : 0);
  const ticks: number[] = [];
  for (let i = first; i <= last; i++) ticks.push(Math.round(i * step * 100) / 100 + 0);
  return ticks;
}

/** "$0", "$850", "$1.2K", "$12K", "$1.4M" — for axis ticks and bar caps. */
export function compactMoney(n: number): string {
  const a = Math.abs(n);
  let body: string;
  if (Math.round(a) < 1000) body = `$${Math.round(a)}`;
  else if (Math.round(a / 1000) < 1000) {
    const k = a / 1000;
    body = k >= 9.95 ? `$${Math.round(k)}K` : `$${Math.round(k * 10) / 10}K`;
  } else {
    const m = a / 1e6;
    body = m >= 9.95 ? `$${Math.round(m)}M` : `$${Math.round(m * 10) / 10}M`;
  }
  return n < 0 && body !== "$0" ? `−${body}` : body;
}

/** "−$12.34" — a cost shown as a deduction, with a real minus sign. */
export const formatNegative = (amount: number) => `−${formatPrice(amount)}`;
