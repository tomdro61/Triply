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
  type MonthBookings,
  type MonthWindow,
  type NetTake,
} from "@/lib/admin/monthly-numbers";

interface NumbersResponse {
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

// Closed months never change, so a successful reconcile is kept for the tab's
// lifetime (sessionStorage) and a reload costs no ResLab/Stripe calls.
// Storage can be unavailable (private mode); every access is try/caught.
function readCachedNet(key: string): NetTake | null {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const v = JSON.parse(raw) as NetTake;
    return typeof v === "object" && v !== null && "net" in v ? v : null;
  } catch {
    return null;
  }
}
function writeCachedNet(key: string, value: NetState): void {
  try {
    if (typeof value === "object" && "net" in value) sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable — the number still renders, it just isn't cached */
  }
}

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

function netCell(n: NetState | undefined, pick: "net" | "perBooking") {
  if (n === undefined || n === "loading") return <span className="text-gray-400">…</span>;
  if ("error" in n) return <span className="text-amber-700" title={n.error}>error</span>;
  const v = n[pick];
  if (v === null) return <span className="text-gray-400" title={n.reason ?? ""}>—</span>;
  return (
    <span title={n.basis === "pre-stripe" ? "Before Stripe fees (Stripe fee data incomplete)" : "After Stripe fees"}>
      {formatPrice(v)}
      {n.basis === "pre-stripe" && <sup className="text-amber-600">*</sup>}
    </span>
  );
}

export default function MonthlyNumbersPage() {
  const [data, setData] = useState<NumbersResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [net, setNet] = useState<Record<string, NetState>>({});
  const [historyRequested, setHistoryRequested] = useState(false);
  // Aborts in-flight reconciler calls when the page unmounts — each one fans
  // out a ResLab + Stripe lookup per booking, so a bounced sidebar click must
  // not leave that running server-side.
  const abortRef = useRef<AbortController | null>(null);

  // Net take comes from the reconciler, which costs one ResLab call and one
  // Stripe call PER BOOKING in the month. Loading all six months on every
  // visit was ~300–600 ResLab calls a page view (review High 2), so only the
  // headline month loads by itself; the history is one click, and closed
  // months are cached in sessionStorage because they do not change.
  const loadNet = useCallback(async (targets: MonthWindow[]) => {
    const controller = abortRef.current ?? new AbortController();
    abortRef.current = controller;
    const queue = [...targets].reverse(); // newest first
    setNet((prev) => ({
      ...prev,
      ...Object.fromEntries(queue.filter((m) => !(m.key in prev)).map((m) => [m.key, "loading" as const])),
    }));
    const worker = async () => {
      for (let m = queue.shift(); m; m = queue.shift()) {
        const month = m;
        const cacheKey = `admin-numbers:net:${month.key}`;
        let state: NetState;
        const cached = !month.partial ? readCachedNet(cacheKey) : null;
        if (cached) {
          state = cached;
        } else {
          try {
            const r = await fetch(`/api/admin/accounting?from=${month.from}&to=${month.to}&by=created`, {
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
    async function load() {
      const res = await fetch("/api/admin/monthly-numbers", { signal: controller.signal });
      if (!res.ok) {
        setError(res.status === 403 ? "Forbidden" : `Failed to load (${res.status})`);
        return;
      }
      const body: NumbersResponse = await res.json();
      if (controller.signal.aborted) return;
      setData(body);
      // Headline only: the last COMPLETE month.
      const lastFull = body.months.length >= 2 ? body.months[body.months.length - 2] : null;
      if (lastFull) await loadNet([lastFull]);
    }
    load().catch((e: unknown) => {
      if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e));
    });
    return () => {
      controller.abort();
    };
  }, [loadNet]);

  const loadHistory = () => {
    if (!data || historyRequested) return;
    setHistoryRequested(true);
    void loadNet(data.months.filter((m) => !(m.key in net)));
  };

  if (error) {
    return <p className="text-red-700">{error}</p>;
  }
  if (!data) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-brand-orange" />
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
        <h1 className="text-2xl font-bold text-gray-900">Monthly numbers</h1>
        <p className="text-gray-600 text-sm">
          Last 6 months by booking date (UTC months; test lots and staging bookings excluded
          {stagingExcluded !== null && stagingExcluded > 0 ? ` — ${stagingExcluded} staging` : ""}). * = month in progress.
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
            { t: "Net take", v: netCell(lastFullNet, "net") },
            { t: "Net per booking", v: netCell(lastFullNet, "perBooking") },
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
        <Card title="Bookings per month" note="Confirmed bookings (refunds excluded).">
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
        note="Net take from the accounting reconciler: channel commission − ResLab fee + service fee + Park Guard margin − Stripe fees (the numerator includes the service fee kept on refunded bookings). Per booking ÷ confirmed bookings. * = before Stripe fees (fee data incomplete)."
      >
        {!historyRequested && (
          <p className="text-sm text-gray-600 mb-3">
            Net take is loaded for the last complete month only — each month costs one ResLab and one
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
                <th className="pb-2 text-right">Net take</th>
                <th className="pb-2 text-right">Net / booking</th>
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
                    <td className="py-1.5 text-right">{netCell(net[m.key], "net")}</td>
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
            <AlertTriangle size={14} /> Location list is not warm on this instance — this page never
            calls ResLab itself. Run a search and reload.
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
