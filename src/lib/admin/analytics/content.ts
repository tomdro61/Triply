/**
 * Pure logic for the admin Analytics page (no I/O): date windows, crediting
 * bookings to blog articles, and the content lists. Plan:
 * notes/2026-10-19-admin-analytics-plan.md (v2).
 */
import { calendarDayIn, DIGEST_TZ, shiftIsoDate } from "@/lib/digest/window";

export const WINDOW_DAYS = 28;

/** GA4's purchase event fires once per booking only since PR #100 (deployed
 *  Oct 19, 2026): purchase-based figures are valid from this ET date on. */
export const PURCHASE_CLEAN_FROM = "2026-10-20";

/** checkout_open / checkout_view / checkout_step_view exist since PR #67 (Oct 6, 2026). */
export const CHECKOUT_EVENTS_FROM = "2026-10-07";

export interface DateWindow {
  start: string; // "YYYY-MM-DD", inclusive
  end: string; // inclusive
}

/**
 * The GA4 window: 28 complete ET days ending the day before yesterday (GA4's
 * "yesterday" is still filling in during the morning), and the 28 before it.
 */
export function ga4Windows(now: Date): { current: DateWindow; previous: DateWindow } {
  const end = shiftIsoDate(calendarDayIn(DIGEST_TZ, now), -2);
  const start = shiftIsoDate(end, -(WINDOW_DAYS - 1));
  const prevEnd = shiftIsoDate(start, -1);
  return { current: { start, end }, previous: { start: shiftIsoDate(prevEnd, -(WINDOW_DAYS - 1)), end: prevEnd } };
}

/** Search Console's window ends on the last day it has data for (it lags 2–3 days). */
export function gscWindows(lastDay: string): { current: DateWindow; previous: DateWindow } {
  const start = shiftIsoDate(lastDay, -(WINDOW_DAYS - 1));
  const prevEnd = shiftIsoDate(start, -1);
  return {
    current: { start, end: lastDay },
    previous: { start: shiftIsoDate(prevEnd, -(WINDOW_DAYS - 1)), end: prevEnd },
  };
}

/** The part of a window from `from` on, or null if that leaves under 7 days. */
export function clipWindow(w: DateWindow, from: string): DateWindow | null {
  const start = w.start < from ? from : w.start;
  if (start > w.end) return null;
  // At least a week, or the rate is noise.
  if (shiftIsoDate(start, 6) > w.end) return null;
  return { start, end: w.end };
}

/** The part of a window where GA4 purchases are clean, or null if under 7 days. */
export function purchaseWindow(w: DateWindow): DateWindow | null {
  return clipWindow(w, PURCHASE_CLEAN_FROM);
}

/** "/blog/Some-Slug/?x" or "https://www.triplypro.com/blog/some-slug" → "some-slug"; else null. */
export function blogSlug(pathOrUrl: string | null | undefined): string | null {
  if (!pathOrUrl) return null;
  const m = /\/blog\/([^/?#]+)/.exec(pathOrUrl);
  if (!m) return null;
  let slug = m[1];
  try {
    slug = decodeURIComponent(slug);
  } catch {
    // keep the raw segment
  }
  slug = slug.toLowerCase();
  // Blog index sub-pages are not articles.
  if (slug === "airport" || slug === "category" || slug === "page") return null;
  return slug;
}

export interface AttributedBooking {
  attribution: { first?: { land?: string }; last?: { land?: string } } | null;
}

/**
 * Bookings credited to articles: the booking's first- or last-touch landing
 * page. The same article twice counts 1; two different articles ½ each.
 */
export function bookingsByArticle(rows: readonly AttributedBooking[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) {
    const slugs = articleSlugs(r);
    for (const s of slugs) out.set(s, (out.get(s) ?? 0) + 1 / slugs.size);
  }
  return out;
}

/** The articles a booking is credited to: its first- and last-touch landing pages. */
function articleSlugs(r: AttributedBooking): Set<string> {
  return new Set(
    [blogSlug(r.attribution?.first?.land), blogSlug(r.attribution?.last?.land)].filter((s): s is string => s !== null)
  );
}

export interface AirportBlogRow {
  /** The airport booked (bookings.airport_code); "Unknown" when not set. */
  airport: string;
  /** Bookings at this airport that started on a blog article. */
  bookings: number;
  /** How many different articles those bookings came from. */
  articleCount: number;
  /** Up to ARTICLES_PER_AIRPORT of them, most first (same ½ rule as bookingsByArticle). */
  articles: Array<{ slug: string; bookings: number }>;
}

export interface BlogByAirport {
  rows: AirportBlogRow[];
  /** Airports past the shown rows, and their blog bookings — so the rows add up to the blog total. */
  otherAirports: number;
  otherBookings: number;
}

const AIRPORT_ROWS = 15;
const ARTICLES_PER_AIRPORT = 3;

/**
 * Blog bookings grouped by the airport booked. Traffic is spread over ~4,500
 * articles and almost none gets a second booking, so a per-article ranking is
 * noise; per airport the pattern shows.
 */
export function blogBookingsByAirport(
  rows: readonly (AttributedBooking & { airport_code: string | null })[]
): BlogByAirport {
  const byAirport = new Map<string, { bookings: number; articles: Map<string, number> }>();
  for (const r of rows) {
    const slugs = articleSlugs(r);
    if (slugs.size === 0) continue;
    const airport = r.airport_code?.trim().toUpperCase() || "Unknown";
    const a = byAirport.get(airport) ?? { bookings: 0, articles: new Map<string, number>() };
    a.bookings += 1;
    for (const s of slugs) a.articles.set(s, (a.articles.get(s) ?? 0) + 1 / slugs.size);
    byAirport.set(airport, a);
  }
  const all = [...byAirport.entries()]
    .map(([airport, a]) => ({
      airport,
      bookings: a.bookings,
      articleCount: a.articles.size,
      articles: [...a.articles.entries()]
        .map(([slug, bookings]) => ({ slug, bookings }))
        .sort((x, y) => y.bookings - x.bookings || x.slug.localeCompare(y.slug))
        .slice(0, ARTICLES_PER_AIRPORT),
    }))
    .sort((x, y) => y.bookings - x.bookings || x.airport.localeCompare(y.airport));
  const rest = all.slice(AIRPORT_ROWS);
  return {
    rows: all.slice(0, AIRPORT_ROWS),
    otherAirports: rest.length,
    otherBookings: rest.reduce((t, r) => t + r.bookings, 0),
  };
}

export interface ArticleRow {
  slug: string;
  sessions: number;
  sessionsBefore: number;
  googleClicks: number | null;
  bookings: number;
}

export interface ContentLists {
  blogSessions: number;
  blogBookings: number;
  /** Blog-wide bookings per session — a guide for spotting pages, not a conversion rate. */
  blogRate: number | null;
  topByTraffic: ArticleRow[];
  trafficFewBookings: ArticleRow[];
  fewTrafficManyBookings: ArticleRow[];
  losingTraffic: ArticleRow[];
}

const LIST_SIZE = 15;
/** Below this, "no bookings" is just a quiet page. */
const MIN_SESSIONS_NO_BOOKINGS = 50;

export function contentLists(articles: readonly ArticleRow[]): ContentLists {
  const blogSessions = articles.reduce((s, a) => s + a.sessions, 0);
  const blogBookings = articles.reduce((s, a) => s + a.bookings, 0);
  const blogRate = blogSessions > 0 ? blogBookings / blogSessions : null;
  const by = (key: (a: ArticleRow) => number) => (a: ArticleRow, b: ArticleRow) => key(b) - key(a);

  const topByTraffic = [...articles].sort(by((a) => a.sessions)).slice(0, LIST_SIZE);

  // Traffic is spread over thousands of articles (the busiest gets ~100+
  // sessions in 28 days; no article has more than a few bookings), so these two
  // lists are descriptive leads, not statistical verdicts: the most-visited
  // articles with no booking at all, and articles with 2+ bookings ranked by
  // bookings per session.
  const trafficFewBookings = articles
    .filter((a) => a.sessions >= MIN_SESSIONS_NO_BOOKINGS && a.bookings === 0)
    .sort(by((a) => a.sessions))
    .slice(0, LIST_SIZE);

  const fewTrafficManyBookings = articles
    .filter((a) => a.bookings >= 2 && a.sessions > 0)
    .sort(by((a) => a.bookings / a.sessions))
    .slice(0, LIST_SIZE);

  // Down ≥ 40 % on the previous window, with ≥ 300 sessions before.
  const losingTraffic = articles
    .filter((a) => a.sessionsBefore >= 300 && a.sessions <= a.sessionsBefore * 0.6)
    .sort(by((a) => a.sessionsBefore - a.sessions))
    .slice(0, LIST_SIZE);

  return { blogSessions, blogBookings, blogRate, topByTraffic, trafficFewBookings, fewTrafficManyBookings, losingTraffic };
}

/** Change from `before` to `now` as a fraction, or null when there's no base. */
export function change(now: number, before: number): number | null {
  return before > 0 ? (now - before) / before : null;
}
