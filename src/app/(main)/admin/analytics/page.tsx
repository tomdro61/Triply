"use client";

/**
 * /admin/analytics — the Google-backed half of the admin analytics plan
 * (notes/2026-10-19-admin-analytics-plan.md, v2 Part B). Booking counts by
 * source, airports, Park Guard, promos and cancellations stay on /admin.
 *
 * Every section prints its own date range (GA4 and Search Console lag
 * differently) and shows "unavailable" rather than zeros when it fails.
 */

import { useEffect, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import type {
  ContentSection,
  FunnelSection,
  SearchTrendSection,
  Section,
  SourcesSection,
} from "@/lib/admin/analytics/collect";
import type { ArticleRow, DateWindow } from "@/lib/admin/analytics/content";

interface AnalyticsResponse {
  content: Section<ContentSection>;
  funnel: Section<FunnelSection>;
  sources: Section<SourcesSection>;
  search: Section<SearchTrendSection>;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sept", "Oct", "Nov", "Dec"];
function fmtDay(iso: string): string {
  const [, m, d] = iso.split("-").map(Number);
  return `${MONTHS[(m ?? 1) - 1]} ${d}`;
}
const fmtRange = (w: DateWindow) => `${fmtDay(w.start)}–${fmtDay(w.end)}`;
const fmtInt = (n: number) => Math.round(n).toLocaleString("en-US");
const fmtPct = (r: number | null, digits = 1) => (r === null ? "—" : `${(r * 100).toFixed(digits)}%`);
const fmtBookings = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

function Change({ now, before }: { now: number; before: number }) {
  if (before <= 0) return null;
  const c = (now - before) / before;
  const cls = c > 0.005 ? "text-emerald-700" : c < -0.005 ? "text-red-600" : "text-gray-500";
  return (
    <span className={`ml-2 text-sm ${cls}`}>
      {c > 0 ? "+" : ""}
      {(c * 100).toFixed(0)}%
    </span>
  );
}

function Card({ title, range, children }: { title: string; range?: string; children: React.ReactNode }) {
  return (
    <section className="mb-6 rounded-xl border border-gray-200 bg-white p-6">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
        {range && <span className="text-xs text-gray-500">{range}</span>}
      </div>
      {children}
    </section>
  );
}

function Unavailable({ error }: { error: string }) {
  return (
    <p className="flex items-start gap-2 text-sm text-amber-700">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      Unavailable — {error}
    </p>
  );
}

function ArticleTable({ rows, empty, showBefore = false }: { rows: ArticleRow[]; empty: string; showBefore?: boolean }) {
  if (rows.length === 0) return <p className="text-sm text-gray-500">{empty}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase text-gray-500">
            <th className="pb-2">Article</th>
            <th className="pb-2 text-right">Visits</th>
            {showBefore && <th className="pb-2 text-right">Visits before</th>}
            <th className="pb-2 text-right">Google clicks</th>
            <th className="pb-2 text-right">Bookings</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((a) => (
            <tr key={a.slug} className="border-t border-gray-100">
              <td className="max-w-[28rem] truncate py-1.5 pr-3">
                <a href={`/blog/${a.slug}`} target="_blank" rel="noreferrer" className="text-brand-orange hover:underline">
                  {a.slug}
                </a>
              </td>
              <td className="py-1.5 text-right tabular-nums">{fmtInt(a.sessions)}</td>
              {showBefore && <td className="py-1.5 text-right tabular-nums">{fmtInt(a.sessionsBefore)}</td>}
              <td className="py-1.5 text-right tabular-nums">{a.googleClicks === null ? "—" : fmtInt(a.googleClicks)}</td>
              <td className="py-1.5 text-right tabular-nums">{fmtBookings(a.bookings)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ContentCard({ s }: { s: Section<ContentSection> }) {
  if (!s.ok)
    return (
      <Card title="Blog content">
        <Unavailable error={s.error} />
      </Card>
    );
  const c = s.data;
  const sub = "mt-6 mb-2 text-sm font-semibold text-gray-900";
  return (
    <Card
      title="Blog content"
      range={`Visits ${fmtRange(c.window)} (Google Analytics)${c.googleClicks.ok ? ` · Google clicks ${fmtRange(c.googleClicks.window)}` : ""}`}
    >
      <p className="text-sm text-gray-700">
        {fmtInt(c.blogSessions)} blog visits · {fmtBookings(c.blogBookings)} bookings started on a blog article
        (of {c.totalBookings} bookings in these days, cancellations excluded)
      </p>
      <p className="mt-1 text-xs text-gray-500">
        Bookings are credited to the article the customer arrived on (first or last visit from outside the site).{" "}
        {c.unattributedBookings} of {c.totalBookings} bookings carry no trace of where they came from, so booking counts
        here are a floor. Small numbers — treat the lists as leads, not proof.
      </p>
      {!c.googleClicks.ok && (
        <p className="mt-2 text-xs text-amber-700">Google clicks unavailable — {c.googleClicks.error}</p>
      )}

      <h3 className={sub}>Top articles by bookings</h3>
      <ArticleTable rows={c.topByBookings} empty="No bookings credited to an article in these days." />

      <h3 className={sub}>Top articles by traffic</h3>
      <ArticleTable rows={c.topByTraffic} empty="No blog visits." />

      <h3 className={sub}>Most-visited articles with no bookings yet</h3>
      <p className="mb-2 text-xs text-gray-500">Pages to improve: better call to action, better match to what readers searched for.</p>
      <ArticleTable rows={c.trafficFewBookings} empty="None with 50+ visits." />

      <h3 className={sub}>Articles with 2+ bookings, by bookings per visit</h3>
      <p className="mb-2 text-xs text-gray-500">Pages worth more links and promotion.</p>
      <ArticleTable rows={c.fewTrafficManyBookings} empty="No article has 2+ bookings yet." />

      <h3 className={sub}>Losing traffic</h3>
      <p className="mb-2 text-xs text-gray-500">
        Visits down 40%+ against {fmtRange(c.previousWindow)} (300+ visits before). Pages to refresh.
      </p>
      <ArticleTable rows={c.losingTraffic} empty="No article lost 40%+ of its traffic." showBefore />
    </Card>
  );
}

function FunnelCard({ s }: { s: Section<FunnelSection> }) {
  if (!s.ok)
    return (
      <Card title="Checkout funnel">
        <Unavailable error={s.error} />
      </Card>
    );
  const f = s.data;
  const first = f.steps[0]?.sessions ?? 0;
  return (
    <Card title="Checkout funnel" range={`${fmtRange(f.window)} (Google Analytics)`}>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase text-gray-500">
            <th className="pb-2">Step</th>
            <th className="pb-2 text-right">Visits</th>
            <th className="pb-2 text-right">Of checkout opened</th>
          </tr>
        </thead>
        <tbody>
          {f.steps.map((st) => (
            <tr key={st.key} className="border-t border-gray-100">
              <td className="py-1.5">{st.label}</td>
              <td className="py-1.5 text-right tabular-nums">{fmtInt(st.sessions)}</td>
              <td className="py-1.5 text-right tabular-nums">{first > 0 ? fmtPct(st.sessions / first, 0) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {f.purchase ? (
        <p className="mt-4 text-sm text-gray-700">
          <span className="font-semibold">Checkout abandonment: {fmtPct(f.purchase.abandonmentRate)}</span> —{" "}
          {fmtInt(f.purchase.purchaseSessions)} bookings from {fmtInt(f.purchase.checkoutSessions)} checkouts opened (
          {fmtRange(f.purchase.window)}).
        </p>
      ) : (
        <p className="mt-4 text-xs text-gray-500">
          Abandonment rate appears once a week of clean booking data is in (Google Analytics counted some bookings twice
          until Oct 19).
        </p>
      )}
    </Card>
  );
}

function SourcesCard({ s }: { s: Section<SourcesSection> }) {
  if (!s.ok)
    return (
      <Card title="Visits and booking rate by source">
        <Unavailable error={s.error} />
      </Card>
    );
  const d = s.data;
  return (
    <Card title="Visits and booking rate by source" range={`${fmtRange(d.window)} (Google Analytics)`}>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase text-gray-500">
            <th className="pb-2">Source</th>
            <th className="pb-2 text-right">Visits</th>
            <th className="pb-2 text-right">Bookings</th>
            <th className="pb-2 text-right">Booking rate</th>
          </tr>
        </thead>
        <tbody>
          {d.rows.map((r) => (
            <tr key={r.source} className="border-t border-gray-100">
              <td className="py-1.5">{r.source}</td>
              <td className="py-1.5 text-right tabular-nums">{fmtInt(r.sessions)}</td>
              <td className="py-1.5 text-right tabular-nums">{r.purchases === null ? "—" : fmtInt(r.purchases)}</td>
              <td className="py-1.5 text-right tabular-nums">{fmtPct(r.rate, 2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-3 text-xs text-gray-500">
        {d.purchaseWindow
          ? `Bookings and booking rate over ${fmtRange(d.purchaseWindow)} only (clean booking data from Oct 20).`
          : "Bookings and booking rate appear once a week of clean booking data is in (from Oct 20)."}{" "}
        Booking counts by source from our own records are on the Dashboard.
      </p>
    </Card>
  );
}

function SearchCard({ s }: { s: Section<SearchTrendSection> }) {
  if (!s.ok)
    return (
      <Card title="Google search">
        <Unavailable error={s.error} />
      </Card>
    );
  const t = s.data;
  return (
    <Card title="Google search" range={`${fmtRange(t.window)} vs ${fmtRange(t.previousWindow)} (Search Console)`}>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <p className="text-sm text-gray-500">Clicks from Google</p>
          <p className="text-2xl font-bold text-gray-900">
            {fmtInt(t.clicks)}
            <Change now={t.clicks} before={t.clicksBefore} />
          </p>
        </div>
        <div>
          <p className="text-sm text-gray-500">Times shown in Google</p>
          <p className="text-2xl font-bold text-gray-900">
            {fmtInt(t.impressions)}
            <Change now={t.impressions} before={t.impressionsBefore} />
          </p>
        </div>
      </div>
    </Card>
  );
}

export default function AdminAnalyticsPage() {
  const [data, setData] = useState<AnalyticsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/admin/analytics")
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body: AnalyticsResponse = await res.json();
        if (alive) setData(body);
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Analytics</h1>
        <p className="mt-1 text-sm text-gray-500">
          Last 28 days from Google Analytics and Search Console. Bookings, sources, airports, Park Guard, promo codes
          and cancellations are on the Dashboard.
        </p>
      </div>
      {error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          Analytics failed to load ({error}).
        </div>
      ) : !data ? (
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading from Google…
        </div>
      ) : (
        <>
          <SearchCard s={data.search} />
          <SourcesCard s={data.sources} />
          <FunnelCard s={data.funnel} />
          <ContentCard s={data.content} />
        </>
      )}
    </div>
  );
}
