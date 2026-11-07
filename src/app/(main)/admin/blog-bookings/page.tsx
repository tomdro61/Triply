"use client";

/**
 * /admin/blog-bookings — which airports and which blog articles produce
 * bookings. Bookings are credited from bookings.attribution (first / last
 * touch landing page); Google clicks come from Search Console; article
 * airport + title from the CMS. Net take loads only on "Load net take" (it
 * calls ResLab once per blog booking via the accounting reconciler, <= 60 days);
 * the first load may come from the route's cache (the current 6-hour window,
 * so computed at most 6 h ago), "Reload net take" (net=fresh) always
 * recomputes, and the figure shows when it was computed.
 *
 * Shows "unavailable" rather than zeros for any source that fails.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Flag, Loader2 } from "lucide-react";
import type {
  AirportRow,
  ArticleBookingRow,
  BlogBookingsResponse,
  DateRange,
  NetFigures,
} from "@/lib/admin/blog-bookings";
import { fmtNet, partialNetNotice } from "@/lib/admin/blog-bookings-format";

/** Mirrors DEFAULT_RANGE_DAYS in src/lib/admin/blog-bookings.ts (60, so net take loads on the default range). */
const DEFAULT_DAYS = 60;
/** Mirrors MAX_NET_RANGE_DAYS in src/lib/admin/blog-bookings.ts (the route enforces it). */
const MAX_NET_DAYS = 60;
const ARTICLE_PAGE = 100;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sept", "Oct", "Nov", "Dec"];
function fmtDay(iso: string): string {
  const [, m, d] = iso.split("-").map(Number);
  return `${MONTHS[(m ?? 1) - 1]} ${d}`;
}
const fmtRange = (r: DateRange) => `${fmtDay(r.from)}–${fmtDay(r.to)}`;
const fmtInt = (n: number | null) => (n === null ? "—" : Math.round(n).toLocaleString("en-US"));
const fmtPct = (r: number | null) => (r === null ? "—" : `${(r * 100).toFixed(0)}%`);
const fmtRate = (r: number | null) => (r === null ? "—" : r.toFixed(1));

/** ET calendar day, "YYYY-MM-DD" (the API works in ET days). */
function todayEt(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}
function shiftDay(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return t.toISOString().slice(0, 10);
}
function rangeDays(r: DateRange): number {
  return Math.round((Date.parse(`${r.to}T00:00:00Z`) - Date.parse(`${r.from}T00:00:00Z`)) / 86_400_000) + 1;
}
function defaultRange(): DateRange {
  const to = todayEt();
  return { from: shiftDay(to, -(DEFAULT_DAYS - 1)), to };
}
/** "Nov 6, 2:05 PM ET" for an ISO instant. */
function fmtEtTime(iso: string): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return "an unknown time";
  const s = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(t);
  return `${s} ET`;
}

/** The response with every net figure taken out: after a failed net load the
 *  old figures must not stay on screen as if they were current. */
function withoutNet(d: BlogBookingsResponse): BlogBookingsResponse {
  return {
    gsc: d.gsc,
    cms: d.cms,
    report: {
      ...d.report,
      totals: { ...d.report.totals, net: null },
      airports: d.report.airports.map((a) => ({ ...a, net: null })),
      articles: d.report.articles.map((a) => ({ ...a, net: null })),
    },
  };
}

function NetCell({ net, loading }: { net: NetFigures | null; loading: boolean }) {
  if (loading || !net || net.blogNetKnown === 0) {
    return (
      <span
        className="text-gray-400"
        title={!loading && net && net.blogNetUnknown > 0 ? `${net.blogNetUnknown} booking(s), none with a net figure` : undefined}
      >
        {fmtNet(net, loading)}
      </span>
    );
  }
  return (
    <span title={net.blogNetUnknown > 0 ? `${net.blogNetUnknown} booking(s) with no net figure, not included` : undefined}>
      {fmtNet(net)}
      {net.blogNetUnknown > 0 && <span className="ml-1 text-xs text-amber-700">+{net.blogNetUnknown}?</span>}
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

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-2 flex items-start gap-2 text-sm text-amber-700">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <p className="text-sm text-gray-500">{label}</p>
      <p className="text-2xl font-bold text-gray-900">{value}</p>
      {sub && <p className="text-xs text-gray-500">{sub}</p>}
    </div>
  );
}

function SortTh<K extends string>({
  k,
  label,
  sort,
  onSort,
  right = true,
}: {
  k: K;
  label: string;
  sort: { key: K; desc: boolean };
  onSort: (k: K) => void;
  right?: boolean;
}) {
  const active = sort.key === k;
  return (
    <th
      className={`pb-2 ${right ? "text-right" : ""}`}
      aria-sort={active ? (sort.desc ? "descending" : "ascending") : undefined}
    >
      <button
        type="button"
        onClick={() => onSort(k)}
        className={`uppercase hover:text-gray-900 ${active ? "text-gray-900" : ""}`}
      >
        {label}
        {active ? (sort.desc ? " ↓" : " ↑") : ""}
      </button>
    </th>
  );
}

type AirportKey = "airport" | "bookings" | "firstTouchBlog" | "lastTouchBlog" | "anyBlog" | "blogShare" | "net" | "gscClicks" | "bookingsPer100Clicks";

function airportValue(r: AirportRow, k: AirportKey): number | string {
  switch (k) {
    case "airport":
      return r.airport;
    case "net":
      return r.net?.blogNet ?? -Infinity;
    default:
      return r[k] ?? -Infinity;
  }
}

function useSort<K extends string>(initial: K) {
  const [sort, setSort] = useState<{ key: K; desc: boolean }>({ key: initial, desc: true });
  const onSort = (key: K) => setSort((s) => ({ key, desc: s.key === key ? !s.desc : true }));
  return { sort, onSort };
}

function compare(a: number | string, b: number | string, desc: boolean): number {
  const c = typeof a === "string" && typeof b === "string" ? a.localeCompare(b) : Number(a) - Number(b);
  return desc ? -c : c;
}

function AirportTable({ rows, netLoading }: { rows: AirportRow[]; netLoading: boolean }) {
  const { sort, onSort } = useSort<AirportKey>("anyBlog");
  const sorted = useMemo(
    () => [...rows].sort((a, b) => compare(airportValue(a, sort.key), airportValue(b, sort.key), sort.desc)),
    [rows, sort]
  );
  if (rows.length === 0) return <p className="text-sm text-gray-500">No bookings in this range.</p>;
  const th = { sort, onSort };
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase text-gray-500">
            <SortTh k="airport" label="Airport" right={false} {...th} />
            <SortTh k="bookings" label="All bookings" {...th} />
            <SortTh k="firstTouchBlog" label="Blog first touch" {...th} />
            <SortTh k="lastTouchBlog" label="Blog last touch" {...th} />
            <SortTh k="anyBlog" label="Blog either" {...th} />
            <SortTh k="blogShare" label="Blog share" {...th} />
            <SortTh k="net" label="Blog net take" {...th} />
            <SortTh k="gscClicks" label="Google clicks" {...th} />
            <SortTh k="bookingsPer100Clicks" label="Per 100 clicks" {...th} />
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <tr key={r.airport} className="border-t border-gray-100">
              <td className="py-1.5 font-medium">{r.airport}</td>
              <td className="py-1.5 text-right tabular-nums">
                {r.bookings}
                {r.unknownAbsent + r.unknownInvalid > 0 && (
                  <span className="ml-1 text-xs text-gray-500" title="Bookings with no or unreadable attribution">
                    ({r.unknownAbsent + r.unknownInvalid} unknown)
                  </span>
                )}
              </td>
              <td className="py-1.5 text-right tabular-nums">{r.firstTouchBlog}</td>
              <td className="py-1.5 text-right tabular-nums">{r.lastTouchBlog}</td>
              <td className="py-1.5 text-right font-medium tabular-nums">{r.anyBlog}</td>
              <td className="py-1.5 text-right tabular-nums">{fmtPct(r.blogShare)}</td>
              <td className="py-1.5 text-right tabular-nums">
                <NetCell net={r.net} loading={netLoading} />
              </td>
              <td className="py-1.5 text-right tabular-nums">{fmtInt(r.gscClicks)}</td>
              <td className="py-1.5 text-right tabular-nums">{fmtRate(r.bookingsPer100Clicks)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type ArticleKey = "slug" | "airport" | "firstTouch" | "lastTouch" | "bookings" | "net" | "gscClicks" | "gscImpressions" | "bookingsPer100Clicks";

function articleValue(r: ArticleBookingRow, k: ArticleKey): number | string {
  switch (k) {
    case "slug":
      return r.title ?? r.slug;
    case "airport":
      return r.airport ?? "";
    case "net":
      return r.net?.blogNet ?? -Infinity;
    default:
      return r[k] ?? -Infinity;
  }
}

function ArticleTable({
  rows,
  netLoading,
  empty,
}: {
  rows: ArticleBookingRow[];
  netLoading: boolean;
  empty: string;
}) {
  const { sort, onSort } = useSort<ArticleKey>("bookings");
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState(ARTICLE_PAGE);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = q
      ? rows.filter(
          (r) => r.slug.includes(q) || (r.title ?? "").toLowerCase().includes(q) || (r.airport ?? "").toLowerCase() === q
        )
      : rows;
    return [...base].sort((a, b) => compare(articleValue(a, sort.key), articleValue(b, sort.key), sort.desc));
  }, [rows, query, sort]);
  if (rows.length === 0) return <p className="text-sm text-gray-500">{empty}</p>;
  const th = { sort, onSort };
  return (
    <>
      <input
        type="search"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setShown(ARTICLE_PAGE);
        }}
        placeholder="Filter by slug, title or airport code"
        className="mb-3 w-full max-w-sm rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-brand-orange focus:outline-none"
      />
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase text-gray-500">
              <SortTh k="slug" label="Article" right={false} {...th} />
              <SortTh k="airport" label="Airport" right={false} {...th} />
              <SortTh k="firstTouch" label="First touch" {...th} />
              <SortTh k="lastTouch" label="Last touch" {...th} />
              <SortTh k="bookings" label="Either" {...th} />
              <SortTh k="net" label="Net take" {...th} />
              <SortTh k="gscClicks" label="Google clicks" {...th} />
              <SortTh k="gscImpressions" label="Impressions" {...th} />
              <SortTh k="bookingsPer100Clicks" label="Per 100 clicks" {...th} />
            </tr>
          </thead>
          <tbody>
            {filtered.slice(0, shown).map((a) => (
              <tr key={a.slug} className="border-t border-gray-100">
                <td className="max-w-[26rem] truncate py-1.5 pr-3">
                  {a.flagClicksNoBookings && (
                    <Flag className="mr-1 inline h-3.5 w-3.5 text-amber-600" aria-label="Clicks but no bookings" />
                  )}
                  <a
                    href={`/blog/${a.slug}`}
                    target="_blank"
                    rel="noreferrer"
                    title={a.slug}
                    className="text-brand-orange hover:underline"
                  >
                    {a.title ?? a.slug}
                  </a>
                </td>
                <td className="py-1.5 pr-3">{a.airport ?? "—"}</td>
                <td className="py-1.5 text-right tabular-nums">{a.firstTouch}</td>
                <td className="py-1.5 text-right tabular-nums">{a.lastTouch}</td>
                <td className="py-1.5 text-right font-medium tabular-nums">{a.bookings}</td>
                <td className="py-1.5 text-right tabular-nums">
                  <NetCell net={a.net} loading={netLoading} />
                </td>
                <td className="py-1.5 text-right tabular-nums">{fmtInt(a.gscClicks)}</td>
                <td className="py-1.5 text-right tabular-nums">{fmtInt(a.gscImpressions)}</td>
                <td className="py-1.5 text-right tabular-nums">{fmtRate(a.bookingsPer100Clicks)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-3 flex items-center gap-3 text-xs text-gray-500">
        <span>
          Showing {Math.min(shown, filtered.length).toLocaleString("en-US")} of {filtered.length.toLocaleString("en-US")}
        </span>
        {shown < filtered.length && (
          <button
            type="button"
            onClick={() => setShown((n) => n + ARTICLE_PAGE)}
            className="rounded-lg bg-gray-100 px-3 py-1.5 text-gray-700 hover:bg-gray-200"
          >
            Show {ARTICLE_PAGE} more
          </button>
        )}
      </div>
    </>
  );
}

/** `net`: "1" = net take, possibly from the route's cache; "fresh" = recompute. */
async function load(range: DateRange, net?: "1" | "fresh"): Promise<BlogBookingsResponse> {
  const qs = new URLSearchParams({ from: range.from, to: range.to, ...(net ? { net } : {}) });
  const res = await fetch(`/api/admin/blog-bookings?${qs.toString()}`);
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => null);
    const msg =
      typeof body === "object" && body !== null && "error" in body && typeof body.error === "string" ? body.error : null;
    throw new Error(msg ? `HTTP ${res.status}: ${msg}` : `HTTP ${res.status}`);
  }
  return (await res.json()) as BlogBookingsResponse;
}

export default function AdminBlogBookingsPage() {
  const [range, setRange] = useState<DateRange>(defaultRange);
  const [draft, setDraft] = useState<DateRange>(range);
  const [data, setData] = useState<BlogBookingsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [netState, setNetState] = useState<"idle" | "loading" | "done" | { error: string }>("idle");
  // Bumped on every Apply, so a net load for an old range can't land on a new one.
  const rangeSeq = useRef(0);

  useEffect(() => {
    let alive = true;
    // Counts + Google clicks only. Net take waits for "Load net take".
    load(range)
      .then((body) => {
        if (alive) setData(body);
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [range]);

  const netTooWide = rangeDays(range) > MAX_NET_DAYS;
  function loadNet() {
    const seq = rangeSeq.current;
    // A reload bypasses the route's cache; the first load may use it.
    const mode = netState === "done" ? "fresh" : "1";
    setNetState("loading");
    load(range, mode)
      .then((withNet) => {
        if (seq !== rangeSeq.current) return;
        // A net section error comes back with no net figures in the report,
        // so this also clears any from an earlier load.
        setData(withNet);
        setNetState(withNet.net && !withNet.net.ok ? { error: withNet.net.error } : "done");
      })
      .catch((e: unknown) => {
        if (seq !== rangeSeq.current) return;
        setData((d) => (d ? withoutNet(d) : d));
        setNetState({ error: e instanceof Error ? e.message : String(e) });
      });
  }

  const draftValid = /^\d{4}-\d{2}-\d{2}$/.test(draft.from) && /^\d{4}-\d{2}-\d{2}$/.test(draft.to) && draft.from <= draft.to;
  const netLoading = netState === "loading";

  const flagged = useMemo(() => (data ? data.report.articles.filter((a) => a.flagClicksNoBookings) : []), [data]);
  const netOk = data?.net?.ok ? data.net.data : null;
  const netPartial = netOk !== null && netOk.fetchErrors > 0;
  const partialNotice = partialNetNotice(netOk, netLoading);
  // Airport clicks group articles by their CMS airport, so they need both sources.
  const airportClicksOk = data !== null && data.gsc.ok && data.cms.ok;

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Blog bookings</h1>
          <p className="mt-1 text-sm text-gray-500">
            Which airports and articles produce bookings — from each booking&apos;s first and last landing page, with
            Google clicks from Search Console.
          </p>
        </div>
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!draftValid) return;
            // Reset here, not in the effect (react-hooks/set-state-in-effect).
            setData(null);
            setError(null);
            setNetState("idle");
            rangeSeq.current += 1;
            // A new object, so Apply with unchanged dates still re-runs the
            // load effect (the same object would leave "Loading…" up forever).
            setRange({ ...draft });
          }}
        >
          <label className="text-xs text-gray-500">
            From
            <input
              type="date"
              value={draft.from}
              onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value }))}
              className="mt-1 block rounded-lg border border-gray-200 px-2 py-1.5 text-sm"
            />
          </label>
          <label className="text-xs text-gray-500">
            To
            <input
              type="date"
              value={draft.to}
              onChange={(e) => setDraft((d) => ({ ...d, to: e.target.value }))}
              className="mt-1 block rounded-lg border border-gray-200 px-2 py-1.5 text-sm"
            />
          </label>
          <button
            type="submit"
            disabled={!draftValid}
            className="rounded-lg bg-brand-orange px-4 py-2 text-sm text-white hover:bg-orange-600 disabled:opacity-50"
          >
            Apply
          </button>
        </form>
      </div>

      {error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          Blog bookings failed to load ({error}).
        </div>
      ) : !data ? (
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading bookings…
        </div>
      ) : (
        <>
          {!data.gsc.ok &&
            (data.gsc.note ? (
              <p className="mb-2 text-sm text-gray-500">Google clicks not shown — {data.gsc.error}.</p>
            ) : (
              <Notice>Google clicks unavailable — {data.gsc.error}</Notice>
            ))}
          {!data.cms.ok && <Notice>Article titles and airports unavailable — {data.cms.error}</Notice>}
          {typeof netState === "object" && <Notice>Net take unavailable — {netState.error}</Notice>}
          {partialNotice && <Notice>{partialNotice}</Notice>}
          <div className="mb-2 flex flex-wrap items-center gap-3 text-xs text-gray-500">
            {netLoading ? (
              <span className="flex items-center gap-2">
                <Loader2 className="h-3 w-3 animate-spin" /> Loading net take from ResLab…
              </span>
            ) : (
              <button
                type="button"
                onClick={loadNet}
                disabled={netTooWide}
                className="rounded-lg bg-gray-100 px-3 py-1.5 text-gray-700 hover:bg-gray-200 disabled:opacity-50"
              >
                {netState === "done" ? "Reload net take" : "Load net take"}
              </button>
            )}
            {netOk && !netLoading && <span>Net take as of {fmtEtTime(netOk.computedAt)}.</span>}
            <span>
              {netTooWide
                ? `Net take covers at most ${MAX_NET_DAYS} days — pick a shorter range.`
                : "One ResLab read per blog booking; up to a minute the first time."}
            </span>
          </div>

          <Card title="Summary" range={`Bookings ${fmtRange(data.report.range)} (ET)`}>
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
              <Stat label="All bookings" value={fmtInt(data.report.totals.bookings)} />
              <Stat
                label="Blog bookings (either touch)"
                value={fmtInt(data.report.totals.anyBlog)}
                sub={`${fmtPct(data.report.totals.blogShare)} of bookings with attribution`}
              />
              <Stat
                label="Blog first / last touch"
                value={`${data.report.totals.firstTouchBlog} / ${data.report.totals.lastTouchBlog}`}
              />
              <Stat
                label="Unknown attribution"
                value={fmtInt(data.report.totals.unknownAbsent + data.report.totals.unknownInvalid)}
                sub={`${data.report.totals.unknownAbsent} no cookie · ${data.report.totals.unknownInvalid} unreadable`}
              />
              <Stat
                label={netPartial && !netLoading ? "Blog net take (partial)" : "Blog net take"}
                value={fmtNet(data.report.totals.net, netLoading)}
                sub={
                  !netLoading && data.report.totals.net && data.report.totals.net.blogNetUnknown > 0
                    ? `${data.report.totals.net.blogNetUnknown} booking(s) without a figure`
                    : undefined
                }
              />
            </div>
            <p className="mt-4 text-xs text-gray-500">
              Live bookings only (cancelled and refunded left out, test bookings excluded). Unknown = no attribution
              cookie or an unreadable one — counted in the totals, never as blog or non-blog, and left out of blog
              share (blog bookings ÷ bookings with attribution). Net take is the
              accounting page&apos;s per-booking figure (commission − ResLab fee − promo discount + service fee + Park
              Guard margin, before Stripe fees). Disputed and direct-lot bookings never have one: they show as &ldquo;+N?&rdquo;
              (no figure) and are left out of the sum, not counted as $0. &ldquo;—&rdquo; = no booking in that cell has a
              figure.
            </p>
          </Card>

          <Card
            title="By airport"
            range={airportClicksOk && data.gsc.ok ? `Google clicks ${fmtRange(data.gsc.data.window)}` : undefined}
          >
            <AirportTable rows={data.report.airports} netLoading={netLoading} />
            {data.report.gscClicksNoAirport !== null && data.report.gscClicksNoAirport > 0 && (
              <p className="mt-3 text-xs text-amber-700">
                {fmtInt(data.report.gscClicksNoAirport)} Google clicks on articles without an airport tag — not in any
                airport&apos;s total.
              </p>
            )}
            <p className="mt-3 text-xs text-gray-500">
              Airport = the airport booked (else the last airport searched). Blog share = blog bookings ÷ bookings with
              attribution (unknown left out). Google clicks per airport = clicks on articles the CMS tags with that
              airport; they need both Search Console and the CMS. Per 100 clicks = blog bookings created inside the
              Google clicks window
              {airportClicksOk && data.gsc.ok ? ` (${fmtRange(data.gsc.data.window)})` : ""} ÷ Google clicks × 100.
            </p>
          </Card>

          {data.gsc.ok && (
            <Card title="Google clicks, no bookings" range={`${fmtRange(data.gsc.data.window)}`}>
              <ArticleTable
                rows={flagged}
                netLoading={netLoading}
                empty={`No article with ${data.report.minClicksFlag}+ Google clicks went without a booking.`}
              />
              <p className="mt-3 text-xs text-gray-500">
                Articles with {data.report.minClicksFlag}+ Google clicks in the range and no booking on either touch.
                Per 100 clicks counts only bookings inside the Google clicks window.
              </p>
            </Card>
          )}

          <Card title="By article">
            <ArticleTable
              rows={data.report.articles}
              netLoading={netLoading}
              empty="No article produced a booking or a Google click in this range."
            />
            <p className="mt-3 text-xs text-gray-500">
              A booking counts in full for every article it touched (first and last can be different articles), so
              this column adds up to more than the blog total.
            </p>
          </Card>
        </>
      )}
    </div>
  );
}
