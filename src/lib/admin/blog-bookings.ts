/**
 * Pure logic for /admin/blog-bookings — "which airports and which articles
 * produce bookings". No I/O: the route (src/app/api/admin/blog-bookings) reads
 * bookings, Search Console and the CMS, this module shapes them.
 *
 * Crediting rules:
 *   - A booking is a BLOG booking when its first- or last-touch landing page
 *     (bookings.attribution.first.land / .last.land) is a blog article.
 *     First- and last-touch are counted separately; a booking whose first AND
 *     last touch are both blog articles counts once in "either touch".
 *   - Per article, "either touch" credits the booking in FULL to each article
 *     it touched (unlike /admin/analytics' ½ split), so the per-article column
 *     can add up to more than the blog total. The totals row never sums it.
 *   - Attribution NULL (no cookie) and the invalid marker are counted as
 *     "unknown", never as non-blog: a capture regression must not read as
 *     "the blog stopped working".
 *   - Airport = the airport booked (bookings.airport_code, resolved at
 *     fulfilment with the cookie's `apt` as context), else the cookie's `apt`,
 *     else "unknown". Legacy "RESLAB" codes are not airports.
 *   - Net take per booking comes from the accounting reconciler's per-booking
 *     detail (netTakeOfDetail below), never re-derived from booking columns.
 */
import { blogSlug } from "@/lib/admin/analytics/content";
import { normalizeStoredAttribution } from "@/lib/attribution/schema";
import { DIGEST_TZ, shiftIsoDate, zonedMidnightUtc } from "@/lib/digest/window";
import type { BookingDetail } from "@/lib/accounting/types";

export { blogSlug };

/** Bookings that count, as on /admin/analytics' blog crediting: disputed
 *  bookings are real (ResLab still bills them); cancelled / refunded are not. */
export const LIVE_STATUSES = ["confirmed", "completed", "disputed"] as const;

export const DEFAULT_RANGE_DAYS = 90;
export const MAX_RANGE_DAYS = 366;
/** Below this many Google clicks, "no bookings" is just a quiet page. */
export const MIN_CLICKS_FLAG = 25;

export const UNKNOWN_AIRPORT = "unknown";

export interface DateRange {
  from: string; // "YYYY-MM-DD" ET, inclusive
  to: string; // inclusive
}

/** The default range: the last DEFAULT_RANGE_DAYS ET days, today included. */
export function defaultRange(todayEt: string, days = DEFAULT_RANGE_DAYS): DateRange {
  return { from: shiftIsoDate(todayEt, -(days - 1)), to: todayEt };
}

/** Number of days in an inclusive range. */
export function rangeDays(r: DateRange): number {
  const a = Date.parse(`${r.from}T00:00:00Z`);
  const b = Date.parse(`${r.to}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000) + 1;
}

/** UTC instants bounding an ET-day range: [start, end). */
export function rangeBoundsUtc(r: DateRange): { start: Date; end: Date } {
  return {
    start: zonedMidnightUtc(r.from, DIGEST_TZ),
    end: zonedMidnightUtc(shiftIsoDate(r.to, 1), DIGEST_TZ),
  };
}

/** One bookings row as the route reads it. `attribution` is the raw JSONB. */
export interface BlogBookingRow {
  id: string;
  created_at: string;
  status: string;
  airport_code: string | null;
  attribution: unknown;
}

export type AttributionState = "valid" | "absent" | "invalid";

export interface ClassifiedBooking {
  id: string;
  airport: string;
  state: AttributionState;
  firstSlug: string | null;
  lastSlug: string | null;
}

function airportOf(code: string | null, apt: string | undefined): string {
  const c = code?.trim().toUpperCase();
  if (c && c !== "RESLAB" && /^[A-Z]{3}$/.test(c)) return c;
  if (apt && /^[A-Z]{3}$/.test(apt)) return apt;
  return UNKNOWN_AIRPORT;
}

export function classifyBooking(row: BlogBookingRow): ClassifiedBooking {
  const attr = normalizeStoredAttribution(row.attribution);
  if (attr === null) {
    return { id: row.id, airport: airportOf(row.airport_code, undefined), state: "absent", firstSlug: null, lastSlug: null };
  }
  if (attr.v === null) {
    return { id: row.id, airport: airportOf(row.airport_code, undefined), state: "invalid", firstSlug: null, lastSlug: null };
  }
  return {
    id: row.id,
    airport: airportOf(row.airport_code, attr.apt),
    state: "valid",
    firstSlug: blogSlug(attr.first.land),
    lastSlug: blogSlug(attr.last?.land),
  };
}

/** Is this row inside the ET-day range? An unparseable timestamp is not. */
export function inRange(createdAt: string, r: DateRange): boolean {
  const t = Date.parse(createdAt);
  if (!Number.isFinite(t)) return false;
  const { start, end } = rangeBoundsUtc(r);
  return t >= start.getTime() && t < end.getTime();
}

/**
 * What Triply kept on one booking, from the reconciler's per-booking detail:
 * its `triply_total` (channel commission + service fee + PG margin) less
 * ResLab's channel fee, exactly as the reconciler's headline total
 * (triplyNet.total) treats a confirmed row (reconcile.ts: the fee is
 * deducted unless ResLab cancelled the row). null when the reconciler could
 * not compute it (no ResLab data) or the row is not confirmed there.
 */
export function netTakeOfDetail(d: Pick<BookingDetail, "status" | "triply_total" | "reslab_channel_fee" | "reslab_cancelled">): number | null {
  if (d.status !== "confirmed" || d.triply_total === null) return null;
  return d.triply_total - (d.reslab_cancelled ? 0 : (d.reslab_channel_fee ?? 0));
}

/** Search Console figures for one article. */
export interface GscPage {
  clicks: number;
  impressions: number;
}

/** CMS facts for one article. */
export interface ArticleMeta {
  title: string | null;
  airport: string | null;
}

export interface Counts {
  /** Live bookings in the range. */
  bookings: number;
  /** First-touch landing page was a blog article. */
  firstTouchBlog: number;
  /** Last-touch landing page was a blog article. */
  lastTouchBlog: number;
  /** Either touch was a blog article. */
  anyBlog: number;
  /** No attribution cookie (NULL). */
  unknownAbsent: number;
  /** Attribution present but unparseable. */
  unknownInvalid: number;
}

export interface NetFigures {
  /** Net take summed over blog bookings (either touch) with a known net. */
  blogNet: number;
  /** Blog bookings whose net is unknown (reconciler had no figure). */
  blogNetUnknown: number;
}

export interface AirportRow extends Counts {
  airport: string;
  /** anyBlog ÷ bookings; null with no bookings. */
  blogShare: number | null;
  /** null until net take is loaded. */
  net: NetFigures | null;
  /** Clicks on this airport's articles (CMS airportCode); null without Search Console. */
  gscClicks: number | null;
  gscImpressions: number | null;
  /** anyBlog per 100 Google clicks; null without clicks. */
  bookingsPer100Clicks: number | null;
}

export interface ArticleBookingRow {
  slug: string;
  title: string | null;
  /** CMS airportCode, else the most-booked airport among its bookings, else null. */
  airport: string | null;
  firstTouch: number;
  lastTouch: number;
  /** Bookings where either touch landed on this article (each counted once). */
  bookings: number;
  net: NetFigures | null;
  gscClicks: number | null;
  gscImpressions: number | null;
  bookingsPer100Clicks: number | null;
  /** Search Console present, ≥ MIN_CLICKS_FLAG clicks and no bookings. */
  flagClicksNoBookings: boolean;
}

export interface BlogBookingsReport {
  range: DateRange;
  totals: Counts & { blogShare: number | null; net: NetFigures | null };
  airports: AirportRow[];
  articles: ArticleBookingRow[];
  /** Rows the date filter dropped (outside the range or bad timestamp). */
  droppedOutOfRange: number;
  /** The click threshold behind flagClicksNoBookings (for the page's copy). */
  minClicksFlag: number;
}

export interface AggregateInput {
  rows: readonly BlogBookingRow[];
  range: DateRange;
  /** Booking id → net take. Omit until net is loaded; a missing id = unknown. */
  netById?: ReadonlyMap<string, number | null>;
  /** Article slug → Search Console figures. Omit when Search Console is unavailable. */
  gscBySlug?: ReadonlyMap<string, GscPage>;
  /** Article slug → CMS title / airport. */
  articleMeta?: ReadonlyMap<string, ArticleMeta>;
}

const emptyCounts = (): Counts => ({
  bookings: 0,
  firstTouchBlog: 0,
  lastTouchBlog: 0,
  anyBlog: 0,
  unknownAbsent: 0,
  unknownInvalid: 0,
});

function addNet(n: NetFigures, id: string, netById: ReadonlyMap<string, number | null>): void {
  const v = netById.get(id);
  if (v === undefined || v === null) n.blogNetUnknown += 1;
  else n.blogNet += v;
}

const per100 = (bookings: number, clicks: number | null): number | null =>
  clicks !== null && clicks > 0 ? (bookings / clicks) * 100 : null;

export function aggregateBlogBookings(input: AggregateInput): BlogBookingsReport {
  const { range, netById, gscBySlug, articleMeta } = input;
  const hasNet = netById !== undefined;
  const hasGsc = gscBySlug !== undefined;

  const totals = emptyCounts();
  const totalNet: NetFigures = { blogNet: 0, blogNetUnknown: 0 };
  const byAirport = new Map<string, { c: Counts; net: NetFigures }>();
  const byArticle = new Map<
    string,
    { first: number; last: number; any: number; net: NetFigures; airports: Map<string, number> }
  >();
  let dropped = 0;

  for (const row of input.rows) {
    if (!LIVE_STATUSES.includes(row.status as (typeof LIVE_STATUSES)[number])) continue;
    if (!inRange(row.created_at, range)) {
      dropped += 1;
      continue;
    }
    const b = classifyBooking(row);
    const a = byAirport.get(b.airport) ?? { c: emptyCounts(), net: { blogNet: 0, blogNetUnknown: 0 } };
    byAirport.set(b.airport, a);
    for (const c of [totals, a.c]) {
      c.bookings += 1;
      if (b.state === "absent") c.unknownAbsent += 1;
      if (b.state === "invalid") c.unknownInvalid += 1;
      if (b.firstSlug) c.firstTouchBlog += 1;
      if (b.lastSlug) c.lastTouchBlog += 1;
      if (b.firstSlug || b.lastSlug) c.anyBlog += 1;
    }
    if (!b.firstSlug && !b.lastSlug) continue;
    if (netById) {
      addNet(totalNet, b.id, netById);
      addNet(a.net, b.id, netById);
    }
    for (const slug of new Set([b.firstSlug, b.lastSlug].filter((s): s is string => s !== null))) {
      const art = byArticle.get(slug) ?? {
        first: 0,
        last: 0,
        any: 0,
        net: { blogNet: 0, blogNetUnknown: 0 },
        airports: new Map<string, number>(),
      };
      byArticle.set(slug, art);
      if (b.firstSlug === slug) art.first += 1;
      if (b.lastSlug === slug) art.last += 1;
      art.any += 1;
      art.airports.set(b.airport, (art.airports.get(b.airport) ?? 0) + 1);
      if (netById) addNet(art.net, b.id, netById);
    }
  }

  // Articles: every article with a booking, plus every article Search Console
  // saw (so clicks-without-bookings can be flagged).
  const slugs = new Set([...byArticle.keys(), ...(gscBySlug ? gscBySlug.keys() : [])]);
  const articles: ArticleBookingRow[] = [...slugs].map((slug) => {
    const art = byArticle.get(slug);
    const meta = articleMeta?.get(slug);
    const gsc = hasGsc ? (gscBySlug.get(slug) ?? { clicks: 0, impressions: 0 }) : null;
    const bookings = art?.any ?? 0;
    let airport = meta?.airport ?? null;
    if (!airport && art) {
      const top = [...art.airports.entries()]
        .filter(([code]) => code !== UNKNOWN_AIRPORT)
        .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0];
      airport = top?.[0] ?? null;
    }
    return {
      slug,
      title: meta?.title ?? null,
      airport,
      firstTouch: art?.first ?? 0,
      lastTouch: art?.last ?? 0,
      bookings,
      net: hasNet ? (art?.net ?? { blogNet: 0, blogNetUnknown: 0 }) : null,
      gscClicks: gsc ? gsc.clicks : null,
      gscImpressions: gsc ? gsc.impressions : null,
      bookingsPer100Clicks: per100(bookings, gsc ? gsc.clicks : null),
      flagClicksNoBookings: gsc !== null && gsc.clicks >= MIN_CLICKS_FLAG && bookings === 0,
    };
  });
  articles.sort(
    (x, y) => y.bookings - x.bookings || (y.gscClicks ?? 0) - (x.gscClicks ?? 0) || x.slug.localeCompare(y.slug)
  );

  // Search Console per airport: clicks on articles whose airport is known.
  const gscByAirport = new Map<string, GscPage>();
  if (hasGsc) {
    for (const a of articles) {
      if (!a.airport || a.gscClicks === null) continue;
      const g = gscByAirport.get(a.airport) ?? { clicks: 0, impressions: 0 };
      g.clicks += a.gscClicks;
      g.impressions += a.gscImpressions ?? 0;
      gscByAirport.set(a.airport, g);
    }
  }

  const airportCodes = new Set([...byAirport.keys(), ...gscByAirport.keys()]);
  const airports: AirportRow[] = [...airportCodes].map((airport) => {
    const a = byAirport.get(airport);
    const c = a?.c ?? emptyCounts();
    const g = hasGsc ? (gscByAirport.get(airport) ?? { clicks: 0, impressions: 0 }) : null;
    return {
      airport,
      ...c,
      blogShare: c.bookings > 0 ? c.anyBlog / c.bookings : null,
      net: hasNet ? (a?.net ?? { blogNet: 0, blogNetUnknown: 0 }) : null,
      gscClicks: g ? g.clicks : null,
      gscImpressions: g ? g.impressions : null,
      bookingsPer100Clicks: per100(c.anyBlog, g ? g.clicks : null),
    };
  });
  airports.sort(
    (x, y) =>
      y.anyBlog - x.anyBlog ||
      y.bookings - x.bookings ||
      (y.gscClicks ?? 0) - (x.gscClicks ?? 0) ||
      x.airport.localeCompare(y.airport)
  );

  return {
    range,
    totals: {
      ...totals,
      blogShare: totals.bookings > 0 ? totals.anyBlog / totals.bookings : null,
      net: hasNet ? totalNet : null,
    },
    airports,
    articles,
    droppedOutOfRange: dropped,
    minClicksFlag: MIN_CLICKS_FLAG,
  };
}

export type Section<T> = { ok: true; data: T } | { ok: false; error: string };

/** GET /api/admin/blog-bookings response. */
export interface BlogBookingsResponse {
  report: BlogBookingsReport;
  gsc: Section<{ window: DateRange }>;
  cms: Section<{ articles: number }>;
  /** Absent when net take was not requested. */
  net?: Section<{ bookings: number }>;
}
