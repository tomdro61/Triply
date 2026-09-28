/**
 * Collectors for the daily digest (plan v2 §1–§2, §4). One per section; each
 * returns `{ ok, data } | { ok, error }` and never throws. Every row-fetching
 * query has a hard `.limit(N + 1)` and a section that hits the cap renders
 * "unavailable (row cap hit)" rather than aggregating a truncated set.
 * Every metric is `number | "unavailable"`.
 *
 * Bounded: every query carries an abort signal (QUERY_TIMEOUT_MS) and
 * `collectDigest` runs under one overall deadline, so a slow database turns
 * into "unavailable" sections instead of a lambda killed at maxDuration with
 * no post, no Sentry event and no run record.
 *
 * Definitions are imported from the modules that own them (plan Appendix B):
 * `isLive`/`airportKey`/`byChannel` from attribution/report, `isAtTestLot`
 * from config/admin, `sameEmail` from booking/customer-link, the snapshot
 * thresholds from reslab/location-snapshot.
 */

import { createAdminClient } from "@/lib/supabase/server";
import { isAtTestLot } from "@/config/admin";
import { isLive, airportKey, byChannel, type ReportRow } from "@/lib/attribution/report";
import { parseMoneyColumn } from "@/lib/utils/money";
import { sameEmail } from "@/lib/booking/customer-link";
import { isSnapshotEnabled, readSnapshotMeta, SNAPSHOT_WARN_MS, SNAPSHOT_MAX_AGE_MS } from "@/lib/reslab/location-snapshot";
import { redactForDigest } from "./redact";
import { calendarDayIn, trailingWindow, type DigestWindow } from "./window";
import type {
  Baselined, BookingsSection, DigestData, EngagementSection, FunnelSection, HealthSection,
  LostSalesSection, Metric, Section, WhereFromSection,
} from "./types";

type Client = Awaited<ReturnType<typeof createAdminClient>>;

/** The ONE place each metric's data start date lives (plan v2 §2 Baselines). */
export const SINCE = {
  bookings: "2026-02-19",
  attribution: "2026-09-17",
  newsletterSource: "2026-09-23",
  searchEvents: "2026-09-24",
  waitlist: "2026-09-24",
} as const;

/** Per-query bound. The Supabase client has no global fetch timeout. */
export const QUERY_TIMEOUT_MS = 8_000;
/** Whole-collection bound: the route needs time left for the model read, the post and the flush. */
export const COLLECT_DEADLINE_MS = 30_000;
/** A production search-telemetry writer with no row for this long is "stale" even inside the view's 7-day window. */
export const TELEMETRY_STALE_MS = 26 * 3_600_000;

const REPEAT_EMAIL_CAP = 40;
const AI_REFERRER = /chatgpt|openai|copilot|perplexity|claude\.ai|anthropic|gemini/i;
const sig = () => AbortSignal.timeout(QUERY_TIMEOUT_MS);

type Failed = { ok: false; error: string };
const ok = <T>(data: T): Section<T> => ({ ok: true, data });
const failed = (err: unknown): Failed => ({ ok: false, error: err instanceof Error ? err.message : String(err) });
const fail = <T>(err: unknown): Section<T> => failed(err);

/**
 * Resolve a section collector or, at the deadline, fail it with "deadline".
 * The underlying queries keep running to their own abort; their results are
 * discarded.
 */
async function withDeadline<R extends Section<unknown>>(label: string, deadlineAt: number, run: () => Promise<R>): Promise<R | Failed> {
  const left = deadlineAt - Date.now();
  if (left <= 0) return failed(new Error(`${label}: collect deadline passed`));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Failed>((resolve) => {
    timer = setTimeout(() => resolve(failed(new Error(`${label}: collect deadline (${COLLECT_DEADLINE_MS} ms)`))), left);
  });
  try {
    return await Promise.race([run().catch((err: unknown) => failed(err)), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * A trailing per-day average, or null when the data does not cover the whole
 * window. A baseline is a comparison nicety: its query failing must NOT take
 * the day's real numbers with it, so a failure is reported alongside the nulls
 * rather than thrown.
 */
async function baseline(
  count: (startUtc: Date, endUtc: Date) => Promise<number>,
  w: DigestWindow,
  since: string
): Promise<Pick<Baselined, "avg7" | "avg28" | "baselineError">> {
  const out: Pick<Baselined, "avg7" | "avg28" | "baselineError"> = { avg7: null, avg28: null };
  for (const days of [7, 28] as const) {
    const t = trailingWindow(w.dateEt, days);
    if (t.firstDay < since) continue; // not fully covered → n/a
    try {
      const n = await count(t.startUtc, t.endUtc);
      out[days === 7 ? "avg7" : "avg28"] = n / days;
    } catch (err) {
      out.baselineError = err instanceof Error ? err.message : String(err);
      break;
    }
  }
  return out;
}

/**
 * PostgREST silently caps ANY select at 1,000 rows (`max-rows`; see
 * admin/stats/route.ts), so a `.limit(N + 1)` guard with N ≥ 1,000 can never
 * fire. Row fetches that may exceed that page with `.range()` under a
 * deterministic order and read cap + 1 rows in total, so "capped" is reachable.
 */
const PAGE = 1_000;
type PageQuery = {
  range(from: number, to: number): { abortSignal(s: AbortSignal): PromiseLike<{ data: unknown; error: { code?: string; message: string } | null }> };
};
async function pagedRows<T>(label: string, make: () => PageQuery, cap: number): Promise<{ rows: T[]; capped: boolean }> {
  const out: T[] = [];
  for (let from = 0; from <= cap; from += PAGE) {
    const to = Math.min(from + PAGE - 1, cap); // cap + 1 rows in total
    const { data, error } = await make().range(from, to).abortSignal(sig());
    if (error) throw new Error(`${label}: ${error.code ?? "?"} ${error.message}`);
    const page = (data ?? []) as T[];
    out.push(...page);
    if (page.length < to - from + 1) break;
  }
  return { rows: out.slice(0, cap), capped: out.length > cap };
}

/** `.in()` rides in the query string; keep each batch small enough to never 414. */
const IN_BATCH = 200;
const chunks = <T>(xs: T[]): T[][] => Array.from({ length: Math.ceil(xs.length / IN_BATCH) }, (_, i) => xs.slice(i * IN_BATCH, (i + 1) * IN_BATCH));

/** A head count whose `content-range` header went missing has `count: null` with NO error — that is "unknown", never 0. */
function exactCount(label: string, r: { count: number | null; error: { code?: string; message: string } | null }): number {
  if (r.error) throw new Error(`${label}: ${r.error.code ?? "?"} ${r.error.message}`);
  if (typeof r.count !== "number" || !Number.isFinite(r.count)) throw new Error(`${label}: count missing from the response`);
  return r.count;
}

function money(v: unknown): Metric {
  if (v === null || v === undefined || v === "") return "unavailable";
  const n = parseMoneyColumn(v as string | number);
  return Number.isFinite(n) ? n : "unavailable";
}

// ───────────────────────────── bookings ─────────────────────────────

interface BookingRow extends ReportRow {
  id: string;
  created_at: string;
  check_in: string | null;
  location_timezone: string | null;
  reslab_location_id: number | null;
  stripe_payment_intent_id: string | null;
  customer_id: string | null;
  due_at_location: string | number | null;
  protection_plan_wholesale: string | number | null;
  customers: { email: string | null } | null;
}

const BOOKING_COLUMNS =
  "id, created_at, status, check_in, location_timezone, reslab_location_id, stripe_payment_intent_id, customer_id, airport_code, promo_code, discount_amount, grand_total, triply_service_fee, due_at_location, protection_plan, protection_plan_price, protection_plan_wholesale, channel, attribution, customers(email)";

/** Calendar-day lead time from a wall-clock check-in string and a TIMESTAMPTZ created_at, in the lot's zone. */
export function leadDays(checkIn: string | null, createdAtIso: string, tz: string | null): number | null {
  if (!checkIn || !tz) return null;
  const ci = checkIn.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ci)) return null;
  let created: string;
  try {
    created = calendarDayIn(tz, new Date(createdAtIso));
  } catch {
    return null;
  }
  const [y1, m1, d1] = ci.split("-").map(Number);
  const [y0, m0, d0] = created.split("-").map(Number);
  return Math.round((Date.UTC(y1, m1 - 1, d1) - Date.UTC(y0, m0 - 1, d0)) / 86_400_000);
}

function bookingsIn(sb: Client, startUtc: Date, endUtc: Date, cap: number, columns = BOOKING_COLUMNS): Promise<{ rows: BookingRow[]; capped: boolean }> {
  return pagedRows<BookingRow>("bookings", () =>
    sb.from("bookings").select(columns).gte("created_at", startUtc.toISOString()).lt("created_at", endUtc.toISOString()).order("created_at").order("id"),
    cap
  );
}

/** Map-join to pending_bookings.livemode — there is no FK, PostgREST cannot embed it. */
async function livemodeFor(sb: Client, rows: Array<{ stripe_payment_intent_id: string | null }>): Promise<Map<string, boolean>> {
  const ids = [...new Set(rows.map((r) => r.stripe_payment_intent_id).filter((x): x is string => Boolean(x)))];
  const out = new Map<string, boolean>();
  for (const batch of chunks(ids)) {
    const { data, error } = await sb
      .from("pending_bookings")
      .select("stripe_payment_intent_id, livemode")
      .in("stripe_payment_intent_id", batch)
      .limit(batch.length)
      .abortSignal(sig());
    if (error) throw new Error(`pending_bookings: ${error.code ?? "?"} ${error.message}`);
    for (const r of (data ?? []) as Array<{ stripe_payment_intent_id: string; livemode: boolean }>) out.set(r.stripe_payment_intent_id, r.livemode === true);
  }
  return out;
}

export interface PartitionedBookings {
  live: BookingRow[];
  staging: number;
  unmatched: number;
}

/** Split yesterday's rows into live / staging / unmatched, test lots removed. */
export function partitionBookings(rows: BookingRow[], livemode: Map<string, boolean>): PartitionedBookings {
  const out: PartitionedBookings = { live: [], staging: 0, unmatched: 0 };
  for (const r of rows) {
    if (isAtTestLot(r.reslab_location_id)) continue;
    const pi = r.stripe_payment_intent_id;
    if (!pi || !livemode.has(pi)) {
      out.unmatched++;
      continue;
    }
    if (livemode.get(pi)) out.live.push(r);
    else out.staging++;
  }
  return out;
}

async function repeatByEmail(sb: Client, live: BookingRow[], startUtc: Date): Promise<{ value: Metric; capped: boolean }> {
  const emails = new Map<string, string>(); // normalised → as-typed variants joined
  for (const r of live) {
    const e = r.customers?.email?.trim();
    if (!e) continue;
    const key = e.toLowerCase();
    if (!emails.has(key)) emails.set(key, e);
  }
  if (emails.size === 0) return { value: 0, capped: false };
  if (emails.size > REPEAT_EMAIL_CAP) return { value: "unavailable", capped: true };
  // Case-exact variants only (PostgREST cannot filter on lower()); good enough for a
  // "seen before" signal, labelled as under-counting in the embed.
  const variants = [...emails.values()].flatMap((e) => [e, e.toLowerCase(), e.toUpperCase(), e[0].toUpperCase() + e.slice(1).toLowerCase()]);
  const { data: custs, error } = await sb.from("customers").select("id, email").in("email", [...new Set(variants)]).limit(500).abortSignal(sig());
  if (error) throw new Error(`customers: ${error.code ?? "?"} ${error.message}`);
  const idsByEmail = new Map<string, string[]>();
  for (const c of (custs ?? []) as Array<{ id: string; email: string }>) {
    for (const key of emails.keys()) {
      if (sameEmail(c.email, key)) idsByEmail.set(key, [...(idsByEmail.get(key) ?? []), c.id]);
    }
  }
  // One query for every candidate customer id (not one per email): which of them
  // have an earlier confirmed booking? Presence is all that is needed, so the
  // 1,000-row page is plenty for ≤ 40 emails.
  const allIds = [...new Set([...idsByEmail.values()].flat())];
  if (allIds.length === 0) return { value: 0, capped: false };
  const seen = new Set<string>();
  for (const batch of chunks(allIds)) {
    const { data: prior, error: pErr } = await sb
      .from("bookings")
      .select("customer_id")
      .in("customer_id", batch)
      .eq("status", "confirmed")
      .lt("created_at", startUtc.toISOString())
      .limit(PAGE)
      .abortSignal(sig());
    if (pErr) throw new Error(`bookings(repeat): ${pErr.code ?? "?"} ${pErr.message}`);
    const priorRows = (prior ?? []) as Array<{ customer_id: string | null }>;
    if (priorRows.length >= PAGE) throw new Error("bookings(repeat): row cap hit"); // a full page may be truncated — say so, never under-count
    for (const r of priorRows) if (r.customer_id) seen.add(r.customer_id);
  }
  let repeat = 0;
  for (const [key] of emails) if ((idsByEmail.get(key) ?? []).some((id) => seen.has(id))) repeat++;
  return { value: repeat, capped: false };
}

/**
 * The bookings baseline uses the SAME definition as the day's count (confirmed,
 * livemode via the pending_bookings join, test lots out): one 28-day fetch of
 * the four columns needed, then both windows are counted from it. A plain head
 * count would include staging soaks at real lots and compare unlike numbers.
 */
async function liveConfirmedBaseline(sb: Client, w: DigestWindow): Promise<Pick<Baselined, "avg7" | "avg28" | "baselineError">> {
  const t28 = trailingWindow(w.dateEt, 28);
  let counted: number[] | null = null; // created_at as epoch ms — never string-compare a PostgREST timestamp
  return baseline(
    async (s, e) => {
      if (counted === null) {
        const CAP = 3_000;
        const { rows, capped } = await bookingsIn(sb, t28.startUtc, t28.endUtc, CAP, "id, created_at, status, reslab_location_id, stripe_payment_intent_id");
        if (capped) throw new Error("bookings(baseline): row cap hit");
        const lm = await livemodeFor(sb, rows);
        const live = partitionBookings(rows, lm).live.filter(isLive);
        const parsed = live.map((r) => Date.parse(r.created_at));
        if (parsed.some((t) => !Number.isFinite(t))) throw new Error("bookings(baseline): unparseable created_at");
        counted = parsed;
      }
      const s0 = s.getTime(), e0 = e.getTime();
      return counted.filter((t) => t >= s0 && t < e0).length;
    },
    w,
    SINCE.bookings
  );
}

export async function collectBookings(sb: Client, w: DigestWindow): Promise<Section<BookingsSection> & { live?: BookingRow[] }> {
  try {
    const { rows, capped } = await bookingsIn(sb, w.startUtc, w.endUtc, 500);
    if (capped) return fail(new Error("row cap hit"));
    const lm = await livemodeFor(sb, rows);
    const p = partitionBookings(rows, lm);
    const confirmed = p.live.filter(isLive);
    const refunded = p.live.filter((r) => r.status === "refunded").length;
    const disputed = p.live.filter((r) => r.status === "disputed").length;
    const cancelledOrFailed = p.live.filter((r) => r.status === "cancelled" || r.status === "payment_failed").length;
    const otherStatus = p.live.length - confirmed.length - refunded - disputed - cancelledOrFailed;

    const sum = (rows: BookingRow[], f: (r: BookingRow) => Metric): Metric => {
      let t = 0;
      for (const r of rows) {
        const v = f(r);
        if (v === "unavailable") return "unavailable";
        t += v;
      }
      return Math.round(t * 100) / 100;
    };
    // GMV = grand_total + service fee + PG premium (the attribution report's `grossOf`),
    // but a NULL in any of the three is "unavailable", never a silent 0.
    const gross = (r: BookingRow): Metric => {
      const gt = money(r.grand_total);
      const fee = money(r.triply_service_fee);
      const pg = r.protection_plan ? money(r.protection_plan_price) : 0;
      return gt === "unavailable" || fee === "unavailable" || pg === "unavailable" ? "unavailable" : gt + fee + pg;
    };
    const gmv = sum(confirmed, gross);
    const unpricedRows = confirmed.filter((r) => gross(r) === "unavailable").length;
    const chargedOnline = sum(confirmed, (r) => {
      const g = gross(r);
      const due = money(r.due_at_location);
      const disc = money(r.discount_amount);
      return g === "unavailable" || due === "unavailable" || disc === "unavailable" ? "unavailable" : g - due - disc;
    });
    const serviceFees = sum(confirmed, (r) => money(r.triply_service_fee));
    const pgRows = confirmed.filter((r) => r.protection_plan);
    const pgClean = pgRows.filter((r) => parseMoneyColumn(r.protection_plan_wholesale) > 0);
    const dirtyPgRows = pgRows.length - pgClean.length;
    const pgMargin = sum(pgClean, (r) => {
      const price = money(r.protection_plan_price);
      return price === "unavailable" ? "unavailable" : price - parseMoneyColumn(r.protection_plan_wholesale);
    });
    const pgRefundedWholesaleEaten = sum(p.live.filter((r) => r.status === "refunded" && r.protection_plan), (r) => money(r.protection_plan_wholesale));
    const feeIncome = serviceFees === "unavailable" || pgMargin === "unavailable" ? "unavailable" : Math.round((serviceFees + pgMargin) * 100) / 100;
    const promo = confirmed.filter((r) => r.promo_code);
    const promoDiscount = sum(promo, (r) => money(r.discount_amount));
    // A comparison nicety, like the baselines: its failure must not take the day's numbers down.
    const rep = await repeatByEmail(sb, confirmed, w.startUtc).catch((err: unknown) => ({
      value: "unavailable" as const,
      capped: false,
      error: err instanceof Error ? err.message : String(err),
    }));
    const lead = { sameDay: 0, d1to3: 0, d4to14: 0, d15plus: 0, unknown: 0 };
    for (const r of confirmed) {
      const d = leadDays(r.check_in, r.created_at, r.location_timezone);
      if (d === null) lead.unknown++;
      else if (d <= 0) lead.sameDay++;
      else if (d <= 3) lead.d1to3++;
      else if (d <= 14) lead.d4to14++;
      else lead.d15plus++;
    }
    const count = confirmed.length;
    const bl = await liveConfirmedBaseline(sb, w);
    const section: BookingsSection = {
      count: { value: count, since: SINCE.bookings, ...bl },
      staging: p.staging,
      unmatched: p.unmatched,
      otherStatus,
      refunded,
      disputed,
      cancelledOrFailed,
      gmv,
      chargedOnline,
      avgOrder: count === 0 ? 0 : gmv === "unavailable" ? "unavailable" : Math.round((gmv / count) * 100) / 100,
      feeIncome,
      serviceFees,
      pgMargin,
      pgRefundedWholesaleEaten,
      pgAttachRate: count === 0 ? 0 : pgRows.length / count,
      dirtyPgRows,
      promoBookings: promo.length,
      promoDiscount,
      repeatByEmail: rep.value,
      repeatCapped: rep.capped,
      ...("error" in rep ? { repeatError: rep.error } : {}),
      unpricedRows,
      leadTime: lead,
    };
    return { ...ok(section), live: confirmed };
  } catch (err) {
    return fail(err);
  }
}

// ───────────────────────────── where from ─────────────────────────────

export function collectWhereFrom(confirmed: BookingRow[]): Section<WhereFromSection> {
  try {
    const landing = { blog: 0, airportPage: 0, homepage: 0, other: 0, none: 0 };
    const posts = new Map<string, number>();
    let ai = 0;
    for (const r of confirmed) {
      const first = r.attribution?.first;
      const land = first?.land;
      if (!first || !land) landing.none++;
      else if (land.startsWith("/blog/")) {
        landing.blog++;
        // The landing path comes from the attribution cookie (client-set, 120 chars,
        // control chars stripped). Keep only a path-shaped slug so nothing free-text
        // reaches the model or Discord.
        const slug = /^\/blog\/[a-z0-9-]{1,80}\/?$/i.test(land) ? land.replace(/\/$/, "") : "/blog/(other)";
        posts.set(slug, (posts.get(slug) ?? 0) + 1);
      } else if (/airport-parking/.test(land)) landing.airportPage++;
      else if (land === "/") landing.homepage++;
      else landing.other++;
      if (AI_REFERRER.test(`${first?.ref ?? ""} ${first?.src ?? ""}`)) ai++;
    }
    const channels = byChannel(confirmed).map((c) => ({ key: c.key, bookings: c.bookings }));
    const airports = new Map<string, number>();
    for (const r of confirmed) airports.set(airportKey(r), (airports.get(airportKey(r)) ?? 0) + 1);
    return ok({
      byChannel: channels,
      topAirports: [...airports.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([key, bookings]) => ({ key, bookings })),
      landing,
      aiReferrals: ai,
      topBlogPosts: [...posts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([path, bookings]) => ({ path, bookings })),
    });
  } catch (err) {
    return fail(err);
  }
}

// ───────────────────────────── funnel ─────────────────────────────

interface SearchEventRow {
  airport_code: string;
  dates_defaulted: boolean | null;
  results_count: number | null;
  sold_out_count: number | null;
  degraded: boolean | null;
}

export async function collectFunnel(sb: Client, w: DigestWindow): Promise<Section<FunnelSection>> {
  try {
    const CAP = 4000;
    const { rows, capped } = await pagedRows<SearchEventRow>("search_events", () =>
      sb.from("search_events")
        .select("airport_code, dates_defaulted, results_count, sold_out_count, degraded")
        .eq("env", "production")
        .eq("source", "search")
        .gte("created_at", w.startUtc.toISOString())
        .lt("created_at", w.endUtc.toISOString())
        .order("created_at")
        .order("id"),
      CAP
    );
    if (capped) return fail(new Error("row cap hit"));
    const byAirport = new Map<string, { searches: number; priced: number; soldOut: number }>();
    let defaulted = 0, resultsSum = 0, resultsN = 0, priced = 0, soldOut = 0, degraded = 0;
    for (const r of rows) {
      const a = byAirport.get(r.airport_code) ?? { searches: 0, priced: 0, soldOut: 0 };
      a.searches++;
      if (r.dates_defaulted) defaulted++;
      if (typeof r.results_count === "number") { resultsSum += r.results_count; resultsN++; }
      if (r.sold_out_count !== null && r.sold_out_count !== undefined) {
        priced++; a.priced++;
        if (r.sold_out_count > 0) { soldOut++; a.soldOut++; }
      }
      if (r.degraded) degraded++;
      byAirport.set(r.airport_code, a);
    }
    const bl = await baseline(
      async (s, e) => {
        const r = await sb
          .from("search_events")
          .select("id", { count: "exact", head: true })
          .eq("env", "production")
          .eq("source", "search")
          .gte("created_at", s.toISOString())
          .lt("created_at", e.toISOString())
          .abortSignal(sig());
        return exactCount("search_events(baseline)", r);
      },
      w,
      SINCE.searchEvents
    );
    const top = [...byAirport.entries()].sort((a, b) => b[1].searches - a[1].searches);
    return ok({
      originSearches: { value: rows.length, since: SINCE.searchEvents, ...bl },
      distinctAirports: byAirport.size,
      topAirports: top.slice(0, 5).map(([key, v]) => ({ key, searches: v.searches })),
      datesDefaultedShare: rows.length === 0 ? 0 : defaulted / rows.length,
      meanResults: resultsN === 0 ? "unavailable" : resultsSum / resultsN,
      soldOutShare: priced === 0 ? "unavailable" : soldOut / priced,
      soldOutDenominator: priced,
      soldOutByAirport: top.filter(([, v]) => v.priced > 0).map(([key, v]) => ({ key, share: v.soldOut / v.priced, priced: v.priced })),
      degradedCount: degraded,
    });
  } catch (err) {
    return fail(err);
  }
}

// ───────────────────────────── lost sales ─────────────────────────────

export async function collectLostSales(sb: Client, w: DigestWindow): Promise<Section<LostSalesSection>> {
  try {
    // pending_bookings names the lot column `location_id` (migration 015), not
    // `reslab_location_id` as `bookings` does. A wrong column name is a 42703 that
    // fails the whole select — the collect test's fake rejects unknown columns.
    const { data, error } = await sb
      .from("pending_bookings")
      .select("status, last_error, airport_code, location_name, location_id")
      .eq("livemode", true)
      .gte("created_at", w.startUtc.toISOString())
      .lt("created_at", w.endUtc.toISOString())
      .limit(501)
      .abortSignal(sig());
    if (error) throw new Error(`pending_bookings: ${error.code ?? "?"} ${error.message}`);
    const rows = (data ?? []) as Array<{ status: string; last_error: string | null; airport_code: string | null; location_name: string | null; location_id: number | null }>;
    if (rows.length > 500) return fail(new Error("row cap hit"));
    const byStatus: Record<string, number> = {};
    const lost: LostSalesSection["rows"] = [];
    for (const r of rows) {
      if (isAtTestLot(r.location_id)) continue; // a livemode checkout at a test lot is still a test
      byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
      const terminal = !["pending", "processing", "completed"].includes(r.status);
      if (terminal) {
        lost.push({
          airport: r.airport_code && r.airport_code !== "RESLAB" ? r.airport_code : "?",
          lot: redactForDigest(r.location_name ?? "?").slice(0, 40),
          status: r.status,
          reason: redactForDigest(r.last_error).slice(0, 60),
        });
      }
    }
    return ok({ byStatus, rows: lost });
  } catch (err) {
    return fail(err);
  }
}

// ───────────────────────────── engagement ─────────────────────────────

export async function collectEngagement(sb: Client, w: DigestWindow): Promise<Section<EngagementSection>> {
  try {
    const CAP = 900; // strictly under PostgREST's 1,000-row page, or the > CAP check could never fire
    const s = w.startUtc.toISOString(), e = w.endUtc.toISOString();
    const [nl, wl, chat, welcome] = await Promise.all([
      sb.from("newsletter_subscribers").select("source").gte("subscribed_at", s).lt("subscribed_at", e).limit(CAP + 1).abortSignal(sig()),
      sb.from("booking_waitlist").select("airport_code").gte("created_at", s).lt("created_at", e).limit(CAP + 1).abortSignal(sig()),
      sb.from("chat_sessions").select("id", { count: "exact", head: true }).gte("created_at", s).lt("created_at", e).abortSignal(sig()),
      sb.from("promo_codes").select("id", { count: "exact", head: true }).like("code", "WELCOME-%").gte("created_at", s).lt("created_at", e).abortSignal(sig()),
    ]);
    for (const [name, r] of [["newsletter_subscribers", nl], ["booking_waitlist", wl], ["chat_sessions", chat], ["promo_codes", welcome]] as const) {
      if (r.error) throw new Error(`${name}: ${r.error.code ?? "?"} ${r.error.message}`);
    }
    const nlRows = (nl.data ?? []) as Array<Record<string, unknown>>;
    const wlRows = (wl.data ?? []) as Array<Record<string, unknown>>;
    if (nlRows.length > CAP || wlRows.length > CAP) return fail(new Error("row cap hit"));
    const tally = (rows: Array<Record<string, unknown>>, key: string) => {
      const t: Record<string, number> = {};
      for (const r of rows) { const k = String(r[key] ?? "(none)"); t[k] = (t[k] ?? 0) + 1; }
      return t;
    };
    return ok({
      newsletterBySource: tally(nlRows, "source"),
      waitlistByAirport: tally(wlRows, "airport_code"),
      chatSessions: exactCount("chat_sessions", chat),
      welcomeCodesMinted: exactCount("promo_codes", welcome),
    });
  } catch (err) {
    return fail(err);
  }
}

// ───────────────────────────── health ─────────────────────────────

export async function collectHealth(sb: Client, w: DigestWindow, now: Date): Promise<Section<HealthSection>> {
  try {
    let telemetry: HealthSection["telemetry"];
    const th = await sb.from("search_events_writer_health").select("env, source, last_row_at, rows_24h").limit(50).abortSignal(sig());
    if (th.error) telemetry = { kind: "unavailable", error: `${th.error.code ?? "?"} ${th.error.message}` };
    else {
      // The view windows to 7 days and is grouped by env: only PRODUCTION rows count
      // (a preview deployment writing rows must not vouch for production). ZERO rows
      // is the loudest state; a row older than TELEMETRY_STALE_MS, or 0 rows in the
      // last 24 h, is "stale" — the writer has been dead for up to 6 days.
      const rows = ((th.data ?? []) as Array<{ env: string; source: string; last_row_at: string; rows_24h: number }>).filter((r) => r.env === "production");
      if (rows.length === 0) telemetry = { kind: "silent_7d" };
      else {
        const latest = rows.reduce((a, b) => (a.last_row_at > b.last_row_at ? a : b));
        const rows24h = rows.reduce((n, r) => n + Number(r.rows_24h || 0), 0);
        const lastMs = Date.parse(latest.last_row_at);
        const stale = rows24h === 0 || !Number.isFinite(lastMs) || now.getTime() - lastMs > TELEMETRY_STALE_MS;
        telemetry = { kind: stale ? "stale" : "ok", lastRowAt: latest.last_row_at, rows24h };
      }
    }
    let snapshot: HealthSection["snapshot"] = { kind: "off" };
    if (isSnapshotEnabled()) {
      const m = await readSnapshotMeta();
      snapshot =
        m.kind === "row"
          ? { kind: "row", ageHours: Math.round(((now.getTime() - m.builtAtMs) / 3_600_000) * 10) / 10, behind: now.getTime() - m.builtAtMs > SNAPSHOT_WARN_MS, stale: now.getTime() - m.builtAtMs > SNAPSHOT_MAX_AGE_MS, locationCount: m.locationCount }
          : m.kind === "none"
            ? { kind: "missing" }
            : { kind: "error", message: m.message };
    }
    const stuckBefore = new Date(now.getTime() - 3_600_000).toISOString();
    const st = await sb
      .from("pending_bookings")
      .select("stripe_payment_intent_id", { count: "exact", head: true })
      .eq("livemode", true)
      .in("status", ["pending", "processing"])
      .lt("created_at", stuckBefore)
      .abortSignal(sig());
    let stuckPending: HealthSection["stuckPending"];
    try {
      stuckPending = { kind: "n", n: exactCount("pending_bookings(stuck)", st) };
    } catch (err) {
      stuckPending = { kind: "error", message: err instanceof Error ? err.message : String(err) };
    }
    // A posted_partial digest WAS posted; only could_not_run / post_failed are gaps.
    const last = await sb
      .from("digest_runs")
      .select("digest_date")
      .in("outcome", ["posted", "posted_partial"])
      .lt("digest_date", w.dateEt)
      .order("digest_date", { ascending: false })
      .limit(1)
      .abortSignal(sig())
      .maybeSingle();
    let lastDigest: HealthSection["lastDigest"];
    if (last.error) lastDigest = { kind: "error", message: `${last.error.code ?? "?"} ${last.error.message}` };
    else if (!last.data) lastDigest = { kind: "none" };
    else {
      const [y, m, d] = String((last.data as { digest_date: string }).digest_date).split("-").map(Number);
      const [y1, m1, d1] = w.dateEt.split("-").map(Number);
      lastDigest = { kind: "days", n: Math.round((Date.UTC(y1, m1 - 1, d1) - Date.UTC(y, m - 1, d)) / 86_400_000) };
    }
    return ok({ telemetry, snapshot, stuckPending, lastDigest });
  } catch (err) {
    return fail(err);
  }
}

// ───────────────────────────── all ─────────────────────────────

export async function collectDigest(w: DigestWindow, now: Date = new Date()): Promise<DigestData> {
  const base = { dateEt: w.dateEt, windowLabel: w.label, generatedAt: now.toISOString() };
  let sb: Client;
  try {
    sb = await createAdminClient(); // throws when SUPABASE_SERVICE_ROLE_KEY is unset/rotated away
  } catch (err) {
    const f = failed(err instanceof Error ? new Error(`admin client: ${err.message}`) : err);
    return { ...base, bookings: f, whereFrom: f, funnel: f, lostSales: f, engagement: f, health: f };
  }
  const deadlineAt = Date.now() + COLLECT_DEADLINE_MS;
  const bookings = await withDeadline("bookings", deadlineAt, () => collectBookings(sb, w));
  const confirmed = bookings.ok ? (bookings.live ?? []) : [];
  const [funnel, lostSales, engagement, health] = await Promise.all([
    withDeadline("funnel", deadlineAt, () => collectFunnel(sb, w)),
    withDeadline("lostSales", deadlineAt, () => collectLostSales(sb, w)),
    withDeadline("engagement", deadlineAt, () => collectEngagement(sb, w)),
    withDeadline("health", deadlineAt, () => collectHealth(sb, w, now)),
  ]);
  const whereFrom: Section<WhereFromSection> = bookings.ok ? collectWhereFrom(confirmed) : fail(new Error("bookings unavailable"));
  const bookingsSection: Section<BookingsSection> = bookings.ok ? { ok: true, data: bookings.data } : bookings;
  return {
    ...base,
    bookings: bookingsSection,
    whereFrom,
    funnel,
    lostSales,
    engagement,
    health,
  };
}
