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
    const slugs = new Set(
      [blogSlug(r.attribution?.first?.land), blogSlug(r.attribution?.last?.land)].filter(
        (s): s is string => s !== null
      )
    );
    for (const s of slugs) out.set(s, (out.get(s) ?? 0) + 1 / slugs.size);
  }
  return out;
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
  topByBookings: ArticleRow[];
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

  const topByBookings = articles
    .filter((a) => a.bookings > 0)
    .sort((a, b) => b.bookings - a.bookings || b.sessions - a.sessions)
    .slice(0, LIST_SIZE);
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

  return { blogSessions, blogBookings, blogRate, topByBookings, topByTraffic, trafficFewBookings, fewTrafficManyBookings, losingTraffic };
}

/** Change from `before` to `now` as a fraction, or null when there's no base. */
export function change(now: number, before: number): number | null {
  return before > 0 ? (now - before) / before : null;
}
