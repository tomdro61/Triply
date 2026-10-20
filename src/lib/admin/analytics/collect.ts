import { unstable_cache } from "next/cache";
import { createAdminClient } from "@/lib/supabase/server";
import { excludeTestBookings } from "@/config/admin";
import { DIGEST_TZ, shiftIsoDate, zonedMidnightUtc } from "@/lib/digest/window";
import { ga4Report, gscQuery, GoogleConfigError } from "@/lib/google/client";
import {
  blogSlug,
  bookingsByArticle,
  CHECKOUT_EVENTS_FROM,
  clipWindow,
  contentLists,
  ga4Windows,
  gscWindows,
  purchaseWindow,
  type ArticleRow,
  type ContentLists,
  type DateWindow,
} from "./content";

/**
 * Data for the admin Analytics page (plan v2 Part B). One section per block;
 * a section that fails is { ok: false, error } and the page shows it as
 * unavailable — never as zero. Each section is cached 1 h per window end
 * (unstable_cache: GA4 runReport is a POST, which the fetch cache won't
 * hold); a thrown error is never cached.
 */

export type Section<T> = { ok: true; data: T } | { ok: false; error: string };

const SITE_HOST = "www.triplypro.com";
const CACHE_S = 3600;

/** Live site only: our production host, never /admin. */
const hostFilter = { filter: { fieldName: "hostName", stringFilter: { matchType: "EXACT", value: SITE_HOST } } };

function cached<T>(name: string, key: string, fn: () => Promise<T>): Promise<T> {
  return unstable_cache(fn, ["admin-analytics", name, key], { revalidate: CACHE_S })();
}

async function section<T>(fn: () => Promise<T>): Promise<Section<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (error) {
    if (error instanceof GoogleConfigError) return { ok: false, error: "Google access isn't set up (GOOGLE_ANALYTICS_SA_KEY)" };
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// ── B1 content ──────────────────────────────────────────────────────────────

export interface ContentSection extends ContentLists {
  window: DateWindow;
  previousWindow: DateWindow;
  /** Search Console clicks per article: its own section, so a failure is shown, not blanked. */
  googleClicks: { ok: true; window: DateWindow } | { ok: false; error: string };
  /** Bookings in the window with no attribution at all (not credited anywhere). */
  unattributedBookings: number;
  /** Live bookings made in the window, excluding cancelled / refunded. */
  totalBookings: number;
}

async function blogSessions(w: DateWindow, prev: DateWindow): Promise<Map<string, { now: number; before: number }>> {
  const rows = await ga4Report({
    dateRanges: [
      { startDate: w.start, endDate: w.end, name: "now" },
      { startDate: prev.start, endDate: prev.end, name: "before" },
    ],
    dimensions: [{ name: "landingPage" }],
    metrics: [{ name: "sessions" }],
    // Ties (the long tail is mostly 1 session) broken by dimension, so offset
    // paging cannot repeat or skip a row between pages.
    orderBys: [
      { metric: { metricName: "sessions" }, desc: true },
      { dimension: { dimensionName: "landingPage" } },
      { dimension: { dimensionName: "dateRange" } },
    ],
    dimensionFilter: {
      andGroup: {
        expressions: [
          hostFilter,
          { filter: { fieldName: "landingPage", stringFilter: { matchType: "BEGINS_WITH", value: "/blog/" } } },
        ],
      },
    },
  });
  const out = new Map<string, { now: number; before: number }>();
  for (const r of rows) {
    const slug = blogSlug(r.dims.landingPage);
    if (!slug) continue;
    const cur = out.get(slug) ?? { now: 0, before: 0 };
    // Named ranges come back by name; anything else would silently double "now".
    if (r.dims.dateRange === "now") cur.now += r.metrics.sessions ?? 0;
    else if (r.dims.dateRange === "before") cur.before += r.metrics.sessions ?? 0;
    else throw new Error(`GA4 returned an unexpected dateRange "${r.dims.dateRange}"`);
    out.set(slug, cur);
  }
  return out;
}

/** The last day Search Console has data for (it lags 2–3 days). */
async function gscLastDay(today: string): Promise<string> {
  const rows = await gscQuery({ startDate: shiftIsoDate(today, -10), endDate: today, dimensions: ["date"] });
  const days = rows.map((r) => r.keys[0]).filter((d): d is string => typeof d === "string").sort();
  const last = days[days.length - 1];
  if (!last) throw new Error("Search Console returned no recent days");
  return last;
}

async function googleClicksByArticle(w: DateWindow): Promise<Map<string, number>> {
  const rows = await gscQuery({
    startDate: w.start,
    endDate: w.end,
    dimensions: ["page"],
    dimensionFilterGroups: [{ filters: [{ dimension: "page", operator: "contains", expression: "/blog/" }] }],
  });
  const out = new Map<string, number>();
  for (const r of rows) {
    const slug = blogSlug(r.keys[0]);
    if (slug) out.set(slug, (out.get(slug) ?? 0) + r.clicks);
  }
  return out;
}

/** Live bookings created in the window (ET days), with their attribution. */
async function bookingsInWindow(w: DateWindow): Promise<Array<{ attribution: { first?: { land?: string }; last?: { land?: string } } | null }>> {
  const supabase = await createAdminClient();
  const CAP = 2000;
  const { data, error } = await excludeTestBookings(
    supabase
      .from("bookings")
      .select("attribution")
      // Disputed bookings are real (ResLab still bills them); cancelled/refunded are not.
      .in("status", ["confirmed", "completed", "disputed"])
      .gte("created_at", zonedMidnightUtc(w.start, DIGEST_TZ).toISOString())
      .lt("created_at", zonedMidnightUtc(shiftIsoDate(w.end, 1), DIGEST_TZ).toISOString())
  )
    .limit(CAP)
    .abortSignal(AbortSignal.timeout(5_000));
  if (error) throw new Error(`bookings read failed: ${error.message}`);
  const rows = (data ?? []) as Array<{ attribution: { first?: { land?: string }; last?: { land?: string } } | null }>;
  if (rows.length >= CAP) throw new Error("bookings read hit its row cap");
  return rows;
}

export async function collectContent(now: Date, today: string): Promise<Section<ContentSection>> {
  const { current, previous } = ga4Windows(now);
  return section(async () => {
    const [main, gsc] = await Promise.all([
      cached("content", current.end, async () => {
        const [sessions, bookings] = await Promise.all([blogSessions(current, previous), bookingsInWindow(current)]);
        // The blog never has zero visits in 28 days: zero means a filter or
        // property problem, not a quiet month — fail rather than cache zeros.
        if ([...sessions.values()].reduce((t, v) => t + v.now, 0) === 0) throw new Error("GA4 returned no blog visits for the window (check the host filter / property)");
        return {
          sessions: [...sessions.entries()],
          credited: [...bookingsByArticle(bookings).entries()],
          unattributed: bookings.filter((b) => !b.attribution?.first && !b.attribution?.last).length,
          total: bookings.length,
        };
      }),
      section(async () => {
        const last = await gscLastDay(today);
        return cached("content-gsc", last, async () => {
          const gw = gscWindows(last).current;
          return { window: gw, clicks: [...(await googleClicksByArticle(gw)).entries()] };
        });
      }),
    ]);
    const sessions = new Map(main.sessions);
    const credited = new Map(main.credited);
    const clicks = gsc.ok ? new Map(gsc.data.clicks) : null;
    const slugs = new Set([...sessions.keys(), ...credited.keys()]);
    const articles: ArticleRow[] = [...slugs].map((slug) => ({
      slug,
      sessions: sessions.get(slug)?.now ?? 0,
      sessionsBefore: sessions.get(slug)?.before ?? 0,
      googleClicks: clicks ? (clicks.get(slug) ?? 0) : null,
      bookings: credited.get(slug) ?? 0,
    }));
    return {
      ...contentLists(articles),
      window: current,
      previousWindow: previous,
      googleClicks: gsc.ok ? { ok: true as const, window: gsc.data.window } : { ok: false as const, error: gsc.error },
      unattributedBookings: main.unattributed,
      totalBookings: main.total,
    };
  });
}

// ── B2 checkout funnel ──────────────────────────────────────────────────────

export interface FunnelStep {
  key: string;
  label: string;
  sessions: number;
}

export interface FunnelSection {
  window: DateWindow;
  steps: FunnelStep[];
  /** Over the clean-purchase window only (GA4 purchase de-duplicated since Oct 20). */
  purchase: { window: DateWindow; checkoutSessions: number; purchaseSessions: number; abandonmentRate: number | null } | null;
  /** Set when the clean window exists but GA4 shows no checkouts or no bookings in it. */
  purchaseError?: string;
}

const STEP_ORDER = ["details", "vehicle", "payment"] as const;
const STEP_LABELS: Record<string, string> = {
  checkout_view: "Checkout opened",
  details: "Details step",
  vehicle: "Vehicle step",
  payment: "Payment step",
};

async function funnelSessions(w: DateWindow): Promise<Map<string, number>> {
  const rows = await ga4Report({
    dateRanges: [{ startDate: w.start, endDate: w.end }],
    dimensions: [{ name: "eventName" }, { name: "customEvent:checkout_step" }],
    metrics: [{ name: "sessions" }],
    dimensionFilter: {
      andGroup: {
        expressions: [
          hostFilter,
          {
            filter: {
              fieldName: "eventName",
              inListFilter: { values: ["checkout_view", "checkout_step_view", "purchase"] },
            },
          },
        ],
      },
    },
  });
  const out = new Map<string, number>();
  for (const r of rows) {
    const key = r.dims.eventName === "checkout_step_view" ? r.dims["customEvent:checkout_step"] : r.dims.eventName;
    if (!key) continue;
    out.set(key, (out.get(key) ?? 0) + (r.metrics.sessions ?? 0));
  }
  return out;
}

export async function collectFunnel(now: Date): Promise<Section<FunnelSection>> {
  // The checkout events exist only since Oct 7: clip the window to that.
  const funnelWindow = clipWindow(ga4Windows(now).current, CHECKOUT_EVENTS_FROM);
  if (!funnelWindow) return { ok: false, error: "Checkout events cover less than a week of this window" };
  const pw = purchaseWindow(funnelWindow);
  return section(() =>
    cached("funnel", funnelWindow.end, async () => {
      const current = funnelWindow;
      const [all, clean] = await Promise.all([funnelSessions(current), pw ? funnelSessions(pw) : Promise.resolve(null)]);
      if ((all.get("checkout_view") ?? 0) === 0) throw new Error("GA4 returned no checkouts for the window (check the host filter / events)");
      const steps: FunnelStep[] = ["checkout_view", ...STEP_ORDER].map((key) => ({
        key,
        label: STEP_LABELS[key] ?? key,
        sessions: all.get(key) ?? 0,
      }));
      let purchase: FunnelSection["purchase"] = null;
      let purchaseError: string | undefined;
      if (pw && clean) {
        const checkoutSessions = clean.get("checkout_view") ?? 0;
        const purchaseSessions = clean.get("purchase") ?? 0;
        // A week with no checkouts or no bookings is a tracking fault here, not
        // a real 100 % abandonment.
        if (checkoutSessions === 0 || purchaseSessions === 0) {
          purchaseError = "GA4 shows no checkouts or no bookings in the clean window; booking tracking may be broken";
        } else purchase = {
          window: pw,
          checkoutSessions,
          purchaseSessions,
          abandonmentRate: checkoutSessions > 0 ? Math.max(0, 1 - purchaseSessions / checkoutSessions) : null,
        };
      }
      return { window: current, steps, purchase, ...(purchaseError ? { purchaseError } : {}) };
    })
  );
}

// ── B3 booking rate by source ───────────────────────────────────────────────

export interface SourceRow {
  source: string;
  sessions: number;
  /** null when the clean-purchase window is too short. */
  purchases: number | null;
  rate: number | null;
}

export interface SourcesSection {
  window: DateWindow;
  purchaseWindow: DateWindow | null;
  /** GA4's default channel groups (its own "AI Assistant" group included). */
  rows: SourceRow[];
  /** Set when the clean window exists but GA4 shows no bookings in it. */
  purchaseError?: string;
}

async function byChannel(w: DateWindow, metric: "sessions" | "ecommercePurchases"): Promise<Map<string, number>> {
  const rows = await ga4Report({
    dateRanges: [{ startDate: w.start, endDate: w.end }],
    dimensions: [{ name: "sessionDefaultChannelGroup" }],
    metrics: [{ name: metric }],
    dimensionFilter: hostFilter,
  });
  const out = new Map<string, number>();
  for (const r of rows) {
    const k = r.dims.sessionDefaultChannelGroup ?? "";
    out.set(k, (out.get(k) ?? 0) + (r.metrics[metric] ?? 0));
  }
  return out;
}

export async function collectSources(now: Date): Promise<Section<SourcesSection>> {
  const { current } = ga4Windows(now);
  const pw = purchaseWindow(current);
  return section(() =>
    cached("sources", current.end, async () => {
      // Sessions over the whole window; the rate only over the clean-purchase
      // window, both sides from GA4.
      const [sessions, pwSessions, pwPurchases] = await Promise.all([
        byChannel(current, "sessions"),
        pw ? byChannel(pw, "sessions") : Promise.resolve(null),
        pw ? byChannel(pw, "ecommercePurchases") : Promise.resolve(null),
      ]);
      if ([...sessions.values()].reduce((a, b) => a + b, 0) === 0) throw new Error("GA4 returned no sessions for the window (check the host filter / property)");
      const noPurchases = pwPurchases !== null && [...pwPurchases.values()].reduce((a, b) => a + b, 0) === 0;
      const purchasesUsable = pwPurchases !== null && !noPurchases ? pwPurchases : null;
      const rows: SourceRow[] = [...sessions.entries()]
        .map(([source, s]) => {
          const base = pwSessions?.get(source) ?? 0;
          const p = purchasesUsable ? (purchasesUsable.get(source) ?? 0) : null;
          return { source, sessions: s, purchases: p, rate: p !== null && base > 0 ? p / base : null };
        })
        .sort((a, b) => b.sessions - a.sessions);
      return {
        window: current,
        purchaseWindow: pw,
        rows,
        ...(noPurchases ? { purchaseError: "GA4 shows no bookings in the clean window; booking tracking may be broken" } : {}),
      };
    })
  );
}

// ── B4 Google search trend ──────────────────────────────────────────────────

export interface SearchTrendSection {
  window: DateWindow;
  previousWindow: DateWindow;
  clicks: number;
  clicksBefore: number;
  impressions: number;
  impressionsBefore: number;
}

export async function collectSearchTrend(today: string): Promise<Section<SearchTrendSection>> {
  return section(async () => {
    const last = await gscLastDay(today);
    return cached("search", last, async () => {
      const { current, previous } = gscWindows(last);
      const [now, before] = await Promise.all([
        gscQuery({ startDate: current.start, endDate: current.end }),
        gscQuery({ startDate: previous.start, endDate: previous.end }),
      ]);
      const total = (rows: Array<{ clicks: number; impressions: number }>) =>
        rows.reduce((t, r) => ({ clicks: t.clicks + r.clicks, impressions: t.impressions + r.impressions }), { clicks: 0, impressions: 0 });
      const n = total(now);
      const b = total(before);
      return {
        window: current,
        previousWindow: previous,
        clicks: n.clicks,
        clicksBefore: b.clicks,
        impressions: n.impressions,
        impressionsBefore: b.impressions,
      };
    });
  });
}
