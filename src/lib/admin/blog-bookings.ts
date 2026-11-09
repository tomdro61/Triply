/**
 * Pure logic for /admin/blog-bookings — "which airports and which articles
 * produce bookings". No I/O: the route (src/app/api/admin/blog-bookings) reads
 * bookings, Search Console and the CMS, this module shapes them.
 *
 * Crediting rules:
 *   - A booking is a BLOG booking when its first- or last-touch landing page
 *     (bookings.attribution.first.land / .last.land) is a blog article.
 *     The cookie writes `last` only when a later visit carries a signal, so
 *     a booking with no `last` has its first touch as its last touch too
 *     (`attr.last ?? attr.first`, as src/lib/attribution/classify.ts reads it).
 *     First- and last-touch are counted separately; a booking whose first AND
 *     last touch are both blog articles counts once in "either touch".
 *   - Blog share = blog bookings ÷ bookings WITH attribution: a booking with
 *     no cookie (every booking before Sept 17, 2026) or an unreadable one
 *     can't be blog or non-blog, so it is not in the denominator either.
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

/** 60, so the default range can load net take (MAX_NET_RANGE_DAYS) without the admin changing it. */
export const DEFAULT_RANGE_DAYS = 60;
export const MAX_RANGE_DAYS = 366;
/** Net take runs one ResLab read per blog booking (~4 a day at today's
 *  volume). 60 days is ~260 reads, ~26 s at concurrency 10, inside the
 *  route's 40 s deadline with room for slow days; 92 days (~400 reads, ~40 s)
 *  hit the deadline and came back partial — and so never cached. Wider ranges
 *  get a net section error. */
export const MAX_NET_RANGE_DAYS = 60;
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

/** Merged posts' old slug → survivor (src/config/blog-redirects.json). */
export type BlogRedirects = Readonly<Record<string, string>>;
const NO_REDIRECTS: BlogRedirects = {};

/** The slug that serves an article today: a merged post's survivor, else itself. */
export function resolveRedirect(slug: string, redirects: BlogRedirects): string {
  return Object.hasOwn(redirects, slug) ? redirects[slug] : slug;
}

/**
 * `redirects` maps a landing slug of a merged post to its survivor, so a
 * booking that landed on the old URL is credited where the old URL's Search
 * Console clicks go (see aggregateBlogBookings).
 */
export function classifyBooking(row: BlogBookingRow, redirects: BlogRedirects = NO_REDIRECTS): ClassifiedBooking {
  const slugOf = (land: string | undefined): string | null => {
    const slug = blogSlug(land);
    return slug === null ? null : resolveRedirect(slug, redirects);
  };
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
    firstSlug: slugOf(attr.first.land),
    lastSlug: slugOf((attr.last ?? attr.first).land),
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
 * Ids of live bookings in the range whose first or last touch is a blog
 * article — the only bookings net take is computed for. (No redirect map:
 * a redirect renames a slug, it never makes one appear or disappear.)
 */
export function blogTouchedIds(rows: readonly BlogBookingRow[], range: DateRange): string[] {
  const ids: string[] = [];
  for (const row of rows) {
    if (!LIVE_STATUSES.includes(row.status as (typeof LIVE_STATUSES)[number])) continue;
    if (!inRange(row.created_at, range)) continue;
    const b = classifyBooking(row);
    if (b.firstSlug || b.lastSlug) ids.push(row.id);
  }
  return ids;
}

/**
 * What Triply kept on one booking, from the reconciler's per-booking detail:
 * its `triply_total` (channel commission + service fee + PG margin − the
 * promo discount Triply funded) less
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

/**
 * Search Console pages keyed by the slug that serves them today: a merged
 * post's old URL (src/config/blog-redirects.json, { old: survivor }) adds its
 * clicks and impressions to the survivor's, which is the post the CMS still
 * publishes and tags with an airport.
 */
export function mergeRedirectedSlugs(
  pages: Iterable<readonly [string, GscPage]>,
  redirects: BlogRedirects
): Map<string, GscPage> {
  const out = new Map<string, GscPage>();
  for (const [slug, page] of pages) {
    const to = resolveRedirect(slug, redirects);
    const p = out.get(to) ?? { clicks: 0, impressions: 0 };
    p.clicks += page.clicks;
    p.impressions += page.impressions;
    out.set(to, p);
  }
  return out;
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
  /** Blog bookings with a known net (the ones in blogNet). 0 = show "—", not $0. */
  blogNetKnown: number;
  /** Blog bookings whose net is unknown (reconciler had no figure — including
   *  disputed and direct-lot bookings, which never have one). */
  blogNetUnknown: number;
}

export interface AirportRow extends Counts {
  airport: string;
  /** anyBlog ÷ bookings with attribution (unknowns left out); null when none have it. */
  blogShare: number | null;
  /** null until net take is loaded. */
  net: NetFigures | null;
  /** Clicks on this airport's articles (CMS airportCode); null without Search
   *  Console or without the CMS (no airport tags to group by). */
  gscClicks: number | null;
  gscImpressions: number | null;
  /** Blog bookings (either touch) created inside the Search Console window,
   *  per 100 Google clicks; null without clicks. */
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
  /** Google clicks on articles the CMS gives no airport (or doesn't publish),
   *  so in no airport's total; null without Search Console or the CMS. */
  gscClicksNoAirport: number | null;
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
  /** The days gscBySlug covers (the range clipped to Search Console's last
   *  day). Per-100-clicks counts only bookings created inside it. */
  gscWindow?: DateRange;
  /** Article slug → CMS title / airport. */
  articleMeta?: ReadonlyMap<string, ArticleMeta>;
  /** Merged posts' old slug → survivor. Applied here to BOTH sides — the
   *  bookings' landing slugs and the Search Console pages — so a merge can't
   *  leave bookings on the old slug and its clicks on the survivor. */
  redirects?: BlogRedirects;
}

const emptyCounts = (): Counts => ({
  bookings: 0,
  firstTouchBlog: 0,
  lastTouchBlog: 0,
  anyBlog: 0,
  unknownAbsent: 0,
  unknownInvalid: 0,
});

const emptyNet = (): NetFigures => ({ blogNet: 0, blogNetKnown: 0, blogNetUnknown: 0 });

function addNet(n: NetFigures, id: string, netById: ReadonlyMap<string, number | null>): void {
  const v = netById.get(id);
  if (v === undefined || v === null) n.blogNetUnknown += 1;
  else {
    n.blogNet += v;
    n.blogNetKnown += 1;
  }
}

const per100 = (bookings: number, clicks: number | null): number | null =>
  clicks !== null && clicks > 0 ? (bookings / clicks) * 100 : null;

/** Blog bookings ÷ bookings with attribution; null when none have it. */
const blogShareOf = (c: Counts): number | null => {
  const attributed = c.bookings - c.unknownAbsent - c.unknownInvalid;
  return attributed > 0 ? c.anyBlog / attributed : null;
};

export function aggregateBlogBookings(input: AggregateInput): BlogBookingsReport {
  const { range, netById, articleMeta, gscWindow } = input;
  const redirects = input.redirects ?? NO_REDIRECTS;
  const gscBySlug = input.gscBySlug && mergeRedirectedSlugs(input.gscBySlug, redirects);
  const hasNet = netById !== undefined;
  const hasGsc = gscBySlug !== undefined;
  // Airport clicks group articles by their CMS airport tag: without the CMS
  // there is nothing to group by, and every airport would read 0 clicks.
  const hasAirportGsc = hasGsc && articleMeta !== undefined;

  const totals = emptyCounts();
  const totalNet: NetFigures = emptyNet();
  // `inGsc` = blog bookings created inside the Search Console window (the
  // numerator of per-100-clicks, so clicks and bookings cover the same days).
  const byAirport = new Map<string, { c: Counts; net: NetFigures; inGsc: number }>();
  const byArticle = new Map<
    string,
    { first: number; last: number; any: number; inGsc: number; net: NetFigures; airports: Map<string, number> }
  >();
  let dropped = 0;

  for (const row of input.rows) {
    if (!LIVE_STATUSES.includes(row.status as (typeof LIVE_STATUSES)[number])) continue;
    if (!inRange(row.created_at, range)) {
      dropped += 1;
      continue;
    }
    const b = classifyBooking(row, redirects);
    const a = byAirport.get(b.airport) ?? { c: emptyCounts(), net: emptyNet(), inGsc: 0 };
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
    const inGsc = gscWindow !== undefined && inRange(row.created_at, gscWindow);
    if (inGsc) a.inGsc += 1;
    if (netById) {
      addNet(totalNet, b.id, netById);
      addNet(a.net, b.id, netById);
    }
    for (const slug of new Set([b.firstSlug, b.lastSlug].filter((s): s is string => s !== null))) {
      const art = byArticle.get(slug) ?? {
        first: 0,
        last: 0,
        any: 0,
        inGsc: 0,
        net: emptyNet(),
        airports: new Map<string, number>(),
      };
      byArticle.set(slug, art);
      if (b.firstSlug === slug) art.first += 1;
      if (b.lastSlug === slug) art.last += 1;
      art.any += 1;
      if (inGsc) art.inGsc += 1;
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
      net: hasNet ? (art?.net ?? emptyNet()) : null,
      gscClicks: gsc ? gsc.clicks : null,
      gscImpressions: gsc ? gsc.impressions : null,
      bookingsPer100Clicks: per100(art?.inGsc ?? 0, gsc ? gsc.clicks : null),
      flagClicksNoBookings: gsc !== null && gsc.clicks >= MIN_CLICKS_FLAG && bookings === 0,
    };
  });
  articles.sort(
    (x, y) => y.bookings - x.bookings || (y.gscClicks ?? 0) - (x.gscClicks ?? 0) || x.slug.localeCompare(y.slug)
  );

  // Search Console per airport: clicks on articles the CMS tags with that
  // airport only — not the booked-airport fallback the article rows show,
  // which would move an article's clicks with whoever happened to book.
  // Clicks on articles with no CMS airport are counted apart, so the airport
  // totals are visibly short rather than silently.
  const gscByAirport = new Map<string, GscPage>();
  let gscClicksNoAirport = 0;
  if (hasAirportGsc) {
    for (const [slug, page] of gscBySlug) {
      const airport = articleMeta.get(slug)?.airport;
      if (!airport) {
        gscClicksNoAirport += page.clicks;
        continue;
      }
      const g = gscByAirport.get(airport) ?? { clicks: 0, impressions: 0 };
      g.clicks += page.clicks;
      g.impressions += page.impressions;
      gscByAirport.set(airport, g);
    }
  }

  const airportCodes = new Set([...byAirport.keys(), ...gscByAirport.keys()]);
  const airports: AirportRow[] = [...airportCodes].map((airport) => {
    const a = byAirport.get(airport);
    const c = a?.c ?? emptyCounts();
    const g = hasAirportGsc ? (gscByAirport.get(airport) ?? { clicks: 0, impressions: 0 }) : null;
    return {
      airport,
      ...c,
      blogShare: blogShareOf(c),
      net: hasNet ? (a?.net ?? emptyNet()) : null,
      gscClicks: g ? g.clicks : null,
      gscImpressions: g ? g.impressions : null,
      bookingsPer100Clicks: per100(a?.inGsc ?? 0, g ? g.clicks : null),
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
      blogShare: blogShareOf(totals),
      net: hasNet ? totalNet : null,
    },
    airports,
    articles,
    gscClicksNoAirport: hasAirportGsc ? gscClicksNoAirport : null,
    droppedOutOfRange: dropped,
    minClicksFlag: MIN_CLICKS_FLAG,
  };
}

/**
 * One independent source on the page. `note` marks an expected state rather
 * than a failure (Search Console has no data for the range yet): the page
 * shows it as a note and the route does not report it.
 */
export type Section<T> = { ok: true; data: T } | { ok: false; error: string; note?: true };

/** GET /api/admin/blog-bookings response. */
export interface BlogBookingsResponse {
  report: BlogBookingsReport;
  gsc: Section<{ window: DateRange }>;
  cms: Section<{ articles: number }>;
  /** Absent when net take was not requested. */
  net?: Section<NetSummary>;
}

/** The net section's own health, for the page's notice. */
export interface NetSummary {
  /** Blog bookings net take was asked for. */
  bookings: number;
  /** Of those, how many came back with a figure. */
  known: number;
  /** ResLab reads with no answer (result.reslab.fetchErrors), including the
   *  `skipped` ones. */
  fetchErrors: number;
  /** Of fetchErrors, reads not made because the time budget ran out. */
  skipped: number;
  /** When the reconciler ran (ISO). A cached result keeps its original time. */
  computedAt: string;
}
