"use client";

/**
 * /admin/numbers — "one page of numbers a month" (marketing-plan rank 23).
 *
 * Bookings, repeat rate, sellable lots and searches come from
 * /api/admin/monthly-numbers. Net take comes from /api/admin/accounting (the
 * reconciler — channel commission − ResLab fee + service fee + Park Guard
 * margin − Stripe fees), one request per month, so this page never computes
 * money itself. Those requests are slow (a ResLab + Stripe lookup per
 * booking), so the table renders first and net take fills in month by month.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Loader2, ArrowLeft, AlertTriangle } from "lucide-react";
import { formatPrice } from "@/lib/utils";
import {
  accountingSliceSchema,
  lotsSeverity,
  netTakeFrom,
  DATE_AXES,
  DATE_AXIS_LABELS,
  type DateAxis,
  type MonthBookings,
  type MonthWindow,
  type NetTake,
} from "@/lib/admin/monthly-numbers";

interface NumbersResponse {
  by: DateAxis;
  months: MonthWindow[];
  bookings: MonthBookings[] | null;
  lots: {
    rows: Array<{ code: string; city: string; lots: number }>;
    totalLocations: number;
  } | null;
  searches: { env: string; days: Array<{ day: string; count: number }> } | null;
  /** Staging (Stripe test-mode) rows left out of every count; null when bookings failed. */
  stagingExcluded: number | null;
  warnings: string[];
}

type NetState = NetTake | "loading" | { error: string };

// Closed months rarely change (a later refund can still move one), so a
// DEFINITIVE reconcile — both figures present, i.e. Stripe fee data complete
// — is kept for the tab's lifetime (sessionStorage) and a reload costs no
// ResLab/Stripe calls. A result with either figure null is never cached: that
// is usually a transient ResLab/Stripe miss and must be asked again. Storage
// can be unavailable (private mode); every access is try/caught.
// Key is versioned: the shape changed when the page adopted accounting's
// gross/cash vocabulary, and an old cached object must not be read as new.
const NET_CACHE_PREFIX = "admin-numbers:net:v2:";
function readCachedNet(key: string): NetTake | null {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<NetTake>;
    return typeof v === "object" && v !== null && typeof v.gross === "number" && typeof v.cash === "number"
      ? (v as NetTake)
      : null;
  } catch {
    return null;
  }
}
function writeCachedNet(key: string, value: NetState): void {
  try {
    if (typeof value === "object" && "gross" in value && value.gross !== null && value.cash !== null) {
      sessionStorage.setItem(key, JSON.stringify(value));
    }
  } catch {
    /* storage unavailable — the number still renders, it just isn't cached */
  }
}
/** A month whose net take is missing or errored — what "load" and "retry" target. */
const needsNet = (net: Record<string, NetState>, key: string): boolean =>
  !(key in net) || (typeof net[key] === "object" && "error" in net[key]);

// Two at a time: each accounting call fans out ResLab + Stripe lookups at
// concurrency 5, and ResLab has throttled us before.
const ACCOUNTING_CONCURRENCY = 2;

const pct = (r: number | null) => (r === null ? "—" : `${(r * 100).toFixed(1)}%`);

function LineChart({
  points,
  format,
  color,
}: {
  points: Array<{ label: string; value: number | null }>;
  format: (n: number) => string;
  color: string;
}) {
  const W = 600;
  const H = 180;
  const PAD = { l: 12, r: 12, t: 28, b: 28 };
  const vals = points.map((p) => p.value).filter((v): v is number => v !== null);
  const max = Math.max(1, ...vals);
  const x = (i: number) =>
    PAD.l + (points.length === 1 ? 0 : (i * (W - PAD.l - PAD.r)) / (points.length - 1));
  const y = (v: number) => PAD.t + (1 - v / max) * (H - PAD.t - PAD.b);
  const path = points
    .map((p, i) => (p.value === null ? null : `${x(i)},${y(p.value)}`))
    .filter((s): s is string => s !== null)
    .join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img">
      <line x1={PAD.l} x2={W - PAD.r} y1={H - PAD.b} y2={H - PAD.b} stroke="#e5e7eb" />
      <polyline points={path} fill="none" stroke={color} strokeWidth={2.5} />
      {points.map((p, i) =>
        p.value === null ? null : (
          <g key={p.label}>
            <circle cx={x(i)} cy={y(p.value)} r={4} fill={color} />
            <text x={x(i)} y={y(p.value) - 10} textAnchor="middle" fontSize={13} fill="#111827" fontWeight={600}>
              {format(p.value)}
            </text>
          </g>
        )
      )}
      {points.map((p, i) => (
        <text key={`l-${p.label}`} x={x(i)} y={H - 8} textAnchor="middle" fontSize={12} fill="#6b7280">
          {p.label}
        </text>
      ))}
    </svg>
  );
}

function Card({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6">
      <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
      {note && <p className="text-xs text-gray-500 mt-0.5 mb-3">{note}</p>}
      {!note && <div className="mb-3" />}
      {children}
    </div>
  );
}

function Unavailable({ what }: { what: string }) {
  return (
    <p className="text-sm text-amber-700 flex items-center gap-1.5">
      <AlertTriangle size={14} /> {what} unavailable — see Sentry.
    </p>
  );
}

// Same figures, same names as /admin/accounting: "gross" is its headline tile
// ("Triply revenue (gross)"), "cash" its "net cash … after Stripe fees".
const NET_TITLES: Record<"gross" | "cash" | "perBooking", string> = {
  gross: "Triply revenue (gross) — accounting's headline: channel commission − ResLab fee + service fee + Park Guard margin",
  cash: "Net cash after Stripe processing fees — accounting's 'net cash' subtitle / P&L bottom line",
  perBooking: "Gross ÷ confirmed bookings",
};
function netCell(n: NetState | undefined, pick: "gross" | "cash" | "perBooking") {
  if (n === undefined || n === "loading") return <span className="text-gray-400">…</span>;
  if ("error" in n) return <span className="text-amber-700" title={n.error}>error</span>;
  const v = n[pick];
  if (v === null) {
    return (
      <span className="text-gray-400" title={pick === "cash" ? "Stripe fee data incomplete for this month" : (n.reason ?? "")}>
        —
      </span>
    );
  }
  return <span title={NET_TITLES[pick]}>{formatPrice(v)}</span>;
}

export default function MonthlyNumbersPage() {
  // The date a booking is filed under — the same selector as /admin/accounting.
  // "Trip checkout" is the ResLab settlement view: what their invoice pays on.
  const [by, setBy] = useState<DateAxis>("created");
  const [data, setData] = useState<NumbersResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [net, setNet] = useState<Record<string, NetState>>({});
  const [historyRequested, setHistoryRequested] = useState(false);
  // Stops state updates (and the client side of in-flight fetches) when the
  // page unmounts. NB the reconciler keeps running server-side until it
  // finishes — /api/admin/accounting does not read request.signal — so the
  // real cost ceiling is "one month per visit", set by the lazy loading below.
  const abortRef = useRef<AbortController | null>(null);

  // Net take comes from the reconciler, which costs one ResLab call and one
  // Stripe call PER BOOKING in the month. Loading all six months on every
  // visit was ~300–600 ResLab calls a page view (review High 2), so only the
  // headline month loads by itself; the history is one click, and definitive
  // results for closed months are cached in sessionStorage.
  const loadNet = useCallback(async (targets: MonthWindow[], axis: DateAxis) => {
    const controller = abortRef.current ?? new AbortController();
    abortRef.current = controller;
    const queue = [...targets].reverse(); // newest first
    setNet((prev) => ({
      ...prev,
      ...Object.fromEntries(queue.filter((m) => needsNet(prev, m.key)).map((m) => [m.key, "loading" as const])),
    }));
    const worker = async () => {
      for (let m = queue.shift(); m; m = queue.shift()) {
        const month = m;
        // Cached per axis: the same calendar month holds different bookings
        // by created vs by checkout.
        const cacheKey = `${NET_CACHE_PREFIX}${axis}:${month.key}`;
        let state: NetState;
        const cached = !month.partial ? readCachedNet(cacheKey) : null;
        if (cached) {
          state = cached;
        } else {
          try {
            const r = await fetch(`/api/admin/accounting?from=${month.from}&to=${month.to}&by=${axis}`, {
              signal: controller.signal,
            });
            if (!r.ok) throw new Error(`accounting ${r.status}`);
            const parsed = accountingSliceSchema.safeParse(await r.json());
            state = parsed.success ? netTakeFrom(parsed.data) : { error: "unexpected accounting response shape" };
            if (!month.partial && parsed.success) writeCachedNet(cacheKey, state);
          } catch (e) {
            if (controller.signal.aborted) return;
            state = { error: e instanceof Error ? e.message : String(e) };
          }
        }
        if (controller.signal.aborted) return;
        setNet((prev) => ({ ...prev, [month.key]: state }));
      }
    };
    await Promise.all(Array.from({ length: ACCOUNTING_CONCURRENCY }, worker));
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;
    // A new axis is a new page of numbers: drop the old ones (and the old
    // "load the other months" state) rather than show created-month figures
    // under checkout-month headings while the new ones load.
    setData(null);
    setNet({});
    setHistoryRequested(false);
    setError(null);
    async function load() {
      const res = await fetch(`/api/admin/monthly-numbers?by=${by}`, { signal: controller.signal });
      if (!res.ok) {
        setError(res.status === 403 ? "Forbidden" : `Failed to load (${res.status})`);
        return;
      }
      const body: NumbersResponse = await res.json();
      if (controller.signal.aborted) return;
      setData(body);
      // Headline only: the last COMPLETE month.
      const lastFull = body.months.length >= 2 ? body.months[body.months.length - 2] : null;
      if (lastFull) await loadNet([lastFull], by);
    }
    load().catch((e: unknown) => {
      if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e));
    });
    return () => {
      controller.abort();
    };
  }, [loadNet, by]);

  const loadHistory = () => {
    if (!data || historyRequested) return;
    setHistoryRequested(true);
    // Includes an errored headline month, so one click is also the retry.
    void loadNet(data.months.filter((m) => needsNet(net, m.key)), by);
  };

  const axisSelector = (
    <label className="inline-flex items-center gap-2 text-sm text-gray-700">
      <span className="font-medium">Date field</span>
      <select
        value={by}
        onChange={(e) => setBy(e.target.value as DateAxis)}
        className="border border-gray-300 rounded-lg px-3 py-1.5 bg-white text-sm focus:ring-1 focus:ring-brand-orange focus:border-brand-orange"
      >
        {DATE_AXES.map((a) => (
          <option key={a} value={a}>
            {DATE_AXIS_LABELS[a]}
          </option>
        ))}
      </select>
    </label>
  );

  if (error) {
    return (
      <div className="space-y-4">
        {axisSelector}
        <p className="text-red-700">{error}</p>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="space-y-4">
        {axisSelector}
        <div className="flex items-center justify-center h-64">
          <Loader2 className="h-8 w-8 animate-spin text-brand-orange" />
        </div>
      </div>
    );
  }

  const { months, bookings, lots, searches, warnings, stagingExcluded } = data;
  const short = (m: MonthWindow) => m.label.slice(0, 3) + (m.partial ? "*" : "");
  // Headline = the last COMPLETE month (the current one is still moving).
  const lastFull = months.length >= 2 ? months[months.length - 2] : null;
  const lastFullBookings = lastFull && bookings ? bookings.find((b) => b.key === lastFull.key) : undefined;
  const lastFullNet = lastFull ? net[lastFull.key] : undefined;
  const thinAirports = lots ? lots.rows.filter((r) => r.lots <= 1) : [];
  const searchTotal = searches ? searches.days.reduce((n, d) => n + d.count, 0) : 0;

  return (
    <div className="space-y-6">
      <div>
        <Link href="/admin" className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 mb-2">
          <ArrowLeft size={14} /> Dashboard
        </Link>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-bold text-gray-900">Monthly numbers</h1>
          {axisSelector}
        </div>
        <p className="text-gray-600 text-sm">
          Last 6 months by{" "}
          <strong>
            {by === "created" ? "booking date" : by === "checkout" ? "trip check-out date (what ResLab settles on)" : "trip check-in date"}
          </strong>{" "}
          ({by === "created" ? "UTC months" : "airport-local calendar months"}; test lots and staging bookings excluded
          {stagingExcluded !== null && stagingExcluded > 0 ? ` — ${stagingExcluded} staging` : ""}). * = month in progress.
          Same selector and figures as Accounting.
        </p>
        {warnings.length > 0 && (
          <p className="mt-2 text-sm text-amber-700 flex items-center gap-1.5">
            <AlertTriangle size={14} /> Partial data: {warnings.join("; ")}.
          </p>
        )}
      </div>

      {/* Headline: last complete month */}
      {lastFull && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[
            { t: `Bookings · ${lastFull.label}`, v: lastFullBookings ? String(lastFullBookings.confirmed) : "—" },
            { t: "Triply revenue (gross)", v: netCell(lastFullNet, "gross") },
            { t: "Net cash (after Stripe)", v: netCell(lastFullNet, "cash") },
            { t: "Repeat rate", v: pct(lastFullBookings?.repeatRate ?? null) },
          ].map((k) => (
            <div key={k.t} className="bg-white rounded-xl border border-gray-200 p-5">
              <p className="text-sm font-medium text-gray-500">{k.t}</p>
              <p className="text-2xl font-bold text-gray-900 mt-1">{k.v}</p>
            </div>
          ))}
        </div>
      )}

      <div className="grid lg:grid-cols-2 gap-6">
        <Card
          title="Bookings per month"
          note={`Confirmed bookings (refunds excluded), by ${by === "created" ? "booking date" : by === "checkout" ? "trip check-out" : "trip check-in"}.`}
        >
          {bookings ? (
            <LineChart
              color="#f97316"
              format={(n) => String(n)}
              points={months.map((m, i) => ({ label: short(m), value: bookings[i].confirmed }))}
            />
          ) : (
            <Unavailable what="Bookings" />
          )}
        </Card>
        <Card
          title="Repeat rate"
          note="Share of the month's paid bookings from an email that had booked before (case-insensitive)."
        >
          {bookings ? (
            <LineChart
              color="#2563eb"
              format={(n) => `${(n * 100).toFixed(0)}%`}
              points={months.map((m, i) => ({ label: short(m), value: bookings[i].repeatRate }))}
            />
          ) : (
            <Unavailable what="Repeat rate" />
          )}
        </Card>
      </div>

      <Card
        title="What we keep"
        note={`The same two figures as /admin/accounting with its Date field set to "${DATE_AXIS_LABELS[by]}". 'Triply revenue (gross)' = channel commission − ResLab fee + service fee + Park Guard margin (includes the service fee kept on refunded bookings); 'Net cash' = gross − Stripe processing fees. Per booking = gross ÷ confirmed bookings.`}
      >
        {!historyRequested && (
          <p className="text-sm text-gray-600 mb-3">
            Revenue is loaded for the last complete month only — each month costs one ResLab and one
            Stripe lookup per booking.{" "}
            <button
              type="button"
              onClick={loadHistory}
              className="text-brand-orange font-semibold underline underline-offset-2"
            >
              Load the other {Math.max(0, months.length - 1)} months
            </button>
          </p>
        )}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500 uppercase">
                <th className="pb-2">Month</th>
                <th className="pb-2 text-right">Bookings</th>
                <th className="pb-2 text-right">Refunded</th>
                <th className="pb-2 text-right">Revenue (gross)</th>
                <th className="pb-2 text-right">Net cash</th>
                <th className="pb-2 text-right">Gross / booking</th>
                <th className="pb-2 text-right">Repeat</th>
              </tr>
            </thead>
            <tbody>
              {[...months].reverse().map((m) => {
                const b = bookings?.find((x) => x.key === m.key);
                return (
                  <tr key={m.key} className="border-t border-gray-100">
                    <td className="py-1.5 text-gray-700">
                      {m.label}
                      {m.partial && <span className="text-gray-400"> (so far)</span>}
                    </td>
                    <td className="py-1.5 text-right font-medium">{b ? b.confirmed : "—"}</td>
                    <td className="py-1.5 text-right text-gray-500">{b ? b.refunded : "—"}</td>
                    <td className="py-1.5 text-right">{netCell(net[m.key], "gross")}</td>
                    <td className="py-1.5 text-right">{netCell(net[m.key], "cash")}</td>
                    <td className="py-1.5 text-right">{netCell(net[m.key], "perBooking")}</td>
                    <td className="py-1.5 text-right">
                      {b ? `${pct(b.repeatRate)} (${b.repeat}/${b.paid})` : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <Card
        title="ResLab channel lots per airport"
        note="ResLab lots on our channel within search's 15 km radius, hidden lots removed; direct lots are not counted here yet. Red = none, amber = one."
      >
        {lots ? (
          <>
            {thinAirports.length > 0 && (
              <p className="text-sm text-red-700 mb-3">
                {thinAirports.length} airport{thinAirports.length === 1 ? "" : "s"} with 0–1 lots:{" "}
                {thinAirports.map((r) => `${r.city} (${r.lots})`).join(", ")}.
              </p>
            )}
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
              {lots.rows.map((r) => {
                const sev = lotsSeverity(r.lots);
                const cls =
                  sev === "none"
                    ? "bg-red-50 border-red-300 text-red-800"
                    : sev === "thin"
                      ? "bg-amber-50 border-amber-300 text-amber-800"
                      : "bg-white border-gray-200 text-gray-800";
                return (
                  <div key={r.code} className={`rounded-lg border px-3 py-2 flex justify-between ${cls}`}>
                    <span>
                      <span className="font-semibold">{r.code}</span>{" "}
                      <span className="text-xs opacity-75">{r.city}</span>
                    </span>
                    <span className="font-bold">{r.lots}</span>
                  </div>
                );
              })}
            </div>
          </>
        ) : (
          <p className="text-sm text-amber-700 flex items-center gap-1.5">
            <AlertTriangle size={14} /> Location list not available on this instance right now
            (snapshot / warm list only — this page never calls ResLab). Try again in a minute.
          </p>
        )}
      </Card>

      <Card
        title="Searches per day"
        note={`Last 14 days, search page only (env: ${searches?.env ?? "?"}). Counts origin searches — CDN-cached repeats are not counted.`}
      >
        {searches ? (
          <>
            <p className="text-sm text-gray-600 mb-2">
              {searchTotal.toLocaleString()} total · {Math.round(searchTotal / searches.days.length)}/day average
            </p>
            <LineChart
              color="#16a34a"
              format={(n) => String(n)}
              points={searches.days.map((d) => ({ label: d.day.slice(8), value: d.count }))}
            />
          </>
        ) : (
          <Unavailable what="Search counts" />
        )}
      </Card>
    </div>
  );
}
