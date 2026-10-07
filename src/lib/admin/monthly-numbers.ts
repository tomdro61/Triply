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

/**
 * Which date a booking is filed under — the same three choices as
 * /admin/accounting's "Date field", with the same meanings:
 *   created   when the customer booked (general reporting — the default)
 *   checkin   trip start
 *   checkout  trip completion — what ResLab SETTLES on, so the month a booking
 *             shows up on their invoice
 */
export const DATE_AXES = ["created", "checkout", "checkin"] as const; // same order as /admin/accounting's selector
export type DateAxis = (typeof DATE_AXES)[number];
export const DATE_AXIS_LABELS: Record<DateAxis, string> = {
  created: "Booking created (general reports)",
  checkout: "Trip checkout (ResLab invoice)",
  checkin: "Trip check-in",
};

/**
 * "2026-10-31 23:00:00" → "2026-10". check_in / check_out are LITERAL
 * airport-local wall-clock strings (TIMESTAMP, migration 007) — the month is
 * the string's own prefix, never `new Date()` math, which would shift a late
 * evening into the next month on any non-airport clock.
 */
export function literalMonthKey(value: string | null | undefined): string | null {
  const m = /^(\d{4}-\d{2})-\d{2}/.exec(value ?? "");
  return m ? m[1] : null;
}

export interface NumbersBookingRow {
  created_at: string;
  status: string;
  email: string | null;
  /** Literal "YYYY-MM-DD HH:mm:ss" strings; null on malformed legacy rows. */
  check_in?: string | null;
  check_out?: string | null;
}

/** The month a row is filed under for the chosen axis. */
export function bookingMonthKey(r: NumbersBookingRow, axis: DateAxis): string | null {
  if (axis === "created") return monthKeyOf(r.created_at);
  return literalMonthKey(axis === "checkin" ? r.check_in : r.check_out);
}

/**
 * Paid bookings filed AFTER the last month in the window — on the trip axes
 * these are booked trips that start/end next month or later (the booking
 * window is 100 days), which a "last N months" view would otherwise hide
 * without a trace. Always 0 on the created axis (nothing is booked in the
 * future).
 */
export function paidAfterWindow(rows: NumbersBookingRow[], months: MonthWindow[], axis: DateAxis): number {
  const last = months[months.length - 1]?.key;
  if (!last) return 0;
  let n = 0;
  for (const r of rows) {
    if (!isPaid(r.status)) continue;
    const key = bookingMonthKey(r, axis);
    if (key !== null && key > last) n++;
  }
  return n;
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
 *
 * `axis` picks the month a booking is FILED under (created / check-in /
 * check-out). "Returning customer" is always decided in booking order
 * (created_at), whatever the axis — a July trip booked in March was a repeat
 * or not when it was booked.
 */
export function bookingsByMonth(
  rows: NumbersBookingRow[],
  months: MonthWindow[],
  axis: DateAxis = "created"
): MonthBookings[] {
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
    const bucket = byKey.get(bookingMonthKey(r, axis) ?? "");
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

/**
 * The two figures /admin/accounting shows, under the SAME names, so the two
 * pages never disagree on a month (Tom compared them on 2026-10-07 and they
 * did — this page was leading with the after-Stripe figure while accounting's
 * headline tile is the gross one):
 *   gross = triplyNet.total      "Triply revenue (gross)": channel commission −
 *                                ResLab channel fee + service fee + Park Guard
 *                                margin — accounting's headline tile
 *   cash  = triplyNet.cashTotal  "net cash … after Stripe fees" — accounting's
 *                                subtitle and its P&L bottom line
 */
export interface NetTake {
  /** Accounting's headline "Triply revenue (gross)"; null when the reconciler couldn't say. */
  gross: number | null;
  /** Accounting's "net cash after Stripe fees"; null when Stripe fee data is incomplete. */
  cash: number | null;
  /** gross / confirmed bookings; null when either is missing or zero bookings. */
  perBooking: number | null;
  /** Why gross is null, from the reconciler, when it says. */
  reason: string | null;
}

/**
 * Per booking divides GROSS by CONFIRMED bookings — the ones whose commission
 * is in the number.
 */
export function netTakeFrom(a: AccountingSlice): NetTake {
  const { cashTotal, total, totalReason } = a.triplyNet;
  const confirmed = a.counts.confirmed;
  return {
    gross: total,
    cash: cashTotal,
    perBooking: total !== null && confirmed > 0 ? total / confirmed : null,
    reason: total === null ? (totalReason ?? "reconciler returned no total") : null,
  };
}

// ---- Sellable lots (counted server-side in ./airport-lots.ts) ----

/** 0 = nothing to sell, 1 = one lot away from nothing. */
export function lotsSeverity(lots: number): "none" | "thin" | "ok" {
  return lots === 0 ? "none" : lots === 1 ? "thin" : "ok";
}
