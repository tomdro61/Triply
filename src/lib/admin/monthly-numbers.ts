/**
 * Pure calculations behind /admin/numbers ("Monthly numbers", marketing-plan
 * rank 23). No I/O here: the route fetches, these functions count. Kept pure
 * so every number on the page has a unit test. Client-safe (the page imports
 * the accounting parser from here); the server-only lot counter lives in
 * ./airport-lots.ts so search.ts never reaches the browser bundle.
 *
 * Month and day buckets are UTC, matching /api/admin/accounting (which
 * filters `${from}T00:00:00Z`..`${to}T23:59:59.999Z`). A booking made at 9pm
 * Eastern on the last day of a month lands in the next month here and there
 * alike, so the booking count and the net take for a month cover the same rows.
 */
import { z } from "zod";

export interface MonthWindow {
  /** "2026-09" */
  key: string;
  /** "Sep 2026" */
  label: string;
  /** First day, "2026-09-01" */
  from: string;
  /** Last day, "2026-09-30" */
  to: string;
  /** True for the month that contains `now` (numbers still moving). */
  partial: boolean;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => String(n).padStart(2, "0");

/** The `n` calendar months ending with the one containing `now`, oldest first. */
export function lastNMonths(now: Date, n: number): MonthWindow[] {
  const out: MonthWindow[] = [];
  const y0 = now.getUTCFullYear();
  const m0 = now.getUTCMonth();
  for (let i = n - 1; i >= 0; i--) {
    const first = new Date(Date.UTC(y0, m0 - i, 1));
    const y = first.getUTCFullYear();
    const m = first.getUTCMonth();
    const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    out.push({
      key: `${y}-${pad(m + 1)}`,
      label: `${MONTHS[m]} ${y}`,
      from: `${y}-${pad(m + 1)}-01`,
      to: `${y}-${pad(m + 1)}-${pad(lastDay)}`,
      partial: i === 0,
    });
  }
  return out;
}

/** The `n` UTC days ending with today, oldest first, as "YYYY-MM-DD". */
export function lastNDays(now: Date, n: number): string[] {
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/** "2026-09-28T13:00:00Z" → "2026-09" (UTC). null for an unparseable value. */
export function monthKeyOf(createdAt: string): string | null {
  const d = new Date(createdAt);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
}

/**
 * The email key a repeat is matched on. `customers.email` is compared
 * case-sensitively everywhere else in the app, so "Jo@X.com" and "jo@x.com"
 * would read as two people and every repeat rate would be a floor. PostgREST
 * cannot apply lower() in a select without an RPC (i.e. a migration), so the
 * lowercasing happens here, once, for every row.
 */
export function emailKey(email: string | null | undefined): string | null {
  const k = (email ?? "").trim().toLowerCase();
  return k === "" ? null : k;
}

export interface NumbersBookingRow {
  created_at: string;
  status: string;
  email: string | null;
}

/** A booking the customer actually paid for (kept or later refunded). */
const isPaid = (status: string) => status === "confirmed" || status === "refunded";

export interface MonthBookings {
  key: string;
  /** status = confirmed — the bookings we kept. The headline count. */
  confirmed: number;
  /** status = refunded — paid, then cancelled. */
  refunded: number;
  /** confirmed + refunded: every paid booking, the repeat-rate denominator. */
  paid: number;
  /** Paid bookings whose (lowercased) email had an EARLIER CONFIRMED booking. */
  repeat: number;
  /** repeat / paid; null when there were no paid bookings. */
  repeatRate: number | null;
}

/**
 * Bookings and repeat rate per month.
 *
 * `rows` must be the FULL history (all months, test lots and staging rows
 * already removed), not just the window: a September booking is a repeat when
 * the same email booked in March, so the "seen before" set has to be built
 * from the beginning.
 *
 * Repeat = a paid booking by an email that already had a CONFIRMED booking
 * before it (earlier month OR earlier the same month). History is seeded the
 * same way as the daily digest's repeatByEmail (src/lib/digest/collect.ts):
 * only an earlier CONFIRMED booking makes a later one a repeat — a customer
 * who cancels and rebooks, or retries after a price-drift refund, is not a
 * "returning customer". The two numbers are related, not identical: this one
 * counts per BOOKING over all paid bookings in the month, the digest counts
 * distinct CUSTOMERS per day with a prior booking before that day. The rate
 * reads as "what share of this month's bookings came from returning
 * customers". Rows with no email count toward `paid` but can never be a repeat.
 */
export function bookingsByMonth(rows: NumbersBookingRow[], months: MonthWindow[]): MonthBookings[] {
  const byKey = new Map<string, MonthBookings>(
    months.map((m) => [m.key, { key: m.key, confirmed: 0, refunded: 0, paid: 0, repeat: 0, repeatRate: null }])
  );
  const sorted = rows
    .map((r) => ({ r, t: new Date(r.created_at).getTime() }))
    .filter((x) => !Number.isNaN(x.t))
    .sort((a, b) => a.t - b.t);
  const seen = new Set<string>();
  for (const { r } of sorted) {
    if (!isPaid(r.status)) continue;
    const email = emailKey(r.email);
    const bucket = byKey.get(monthKeyOf(r.created_at) ?? "");
    if (bucket) {
      if (r.status === "confirmed") bucket.confirmed++;
      else bucket.refunded++;
      bucket.paid++;
      if (email !== null && seen.has(email)) bucket.repeat++;
    }
    if (email !== null && r.status === "confirmed") seen.add(email);
  }
  const out = months.map((m) => byKey.get(m.key) as MonthBookings);
  for (const b of out) b.repeatRate = b.paid > 0 ? b.repeat / b.paid : null;
  return out;
}

// ---- Net take (from the reconciler, via /api/admin/accounting) -------------

/**
 * The slice of the /api/admin/accounting response the page reads. Parsed at
 * the boundary so a shape change in the reconciler fails loudly as "net take
 * unavailable" instead of rendering NaN.
 */
export const accountingSliceSchema = z.object({
  counts: z.object({ confirmed: z.number() }),
  triplyNet: z.object({
    total: z.number().nullable(),
    cashTotal: z.number().nullable(),
    totalReason: z.string().nullable(),
  }),
});
export type AccountingSlice = z.infer<typeof accountingSliceSchema>;

export interface NetTake {
  /** What Triply keeps for the month; null when the reconciler couldn't say. */
  net: number | null;
  /** net / confirmed bookings; null when either is missing or zero bookings. */
  perBooking: number | null;
  /** "cash" = after Stripe fees (cashTotal); "pre-stripe" = before them. */
  basis: "cash" | "pre-stripe" | null;
  /** Why net is null, from the reconciler, when it says. */
  reason: string | null;
}

/**
 * Pick the reconciler's closest-to-cash figure. `cashTotal` (channel
 * commission − ResLab channel fee + service fee + Park Guard margin − Stripe
 * processing fees) when Stripe fees are known; otherwise `total` (same, before
 * Stripe fees), flagged so the page says so. Per booking divides by CONFIRMED
 * bookings — the ones whose commission is in the number.
 */
export function netTakeFrom(a: AccountingSlice): NetTake {
  const { cashTotal, total, totalReason } = a.triplyNet;
  const net = cashTotal ?? total;
  const basis = cashTotal !== null ? "cash" : total !== null ? "pre-stripe" : null;
  const confirmed = a.counts.confirmed;
  return {
    net,
    perBooking: net !== null && confirmed > 0 ? net / confirmed : null,
    basis,
    reason: net === null ? (totalReason ?? "reconciler returned no total") : null,
  };
}

// ---- Sellable lots (counted server-side in ./airport-lots.ts) ----

/** 0 = nothing to sell, 1 = one lot away from nothing. */
export function lotsSeverity(lots: number): "none" | "thin" | "ok" {
  return lots === 0 ? "none" : lots === 1 ? "thin" : "ok";
}
