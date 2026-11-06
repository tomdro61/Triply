"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, ExternalLink, Loader2 } from "lucide-react";
import { formatDeadline, timeLeftLabel } from "@/lib/disputes/deadline";

type Dispute = {
  stripe_dispute_id: string;
  booking_id: string | null;
  amount_cents: number;
  reason: string;
  status: string;
  evidence_due_by: string | null;
  livemode: boolean;
  evidence_drafted_at: string | null;
  evidence_draft_error: string | null;
  outcome: string | null;
  closed_at: string | null;
  submitted_at: string | null;
  submitted_by: string | null;
  created_at: string;
  bookings: { reslab_reservation_number: string | null; location_name: string | null; check_in: string | null } | null;
};

type Warning = {
  stripe_warning_id: string;
  charge_id: string | null;
  fraud_type: string;
  actionable: boolean;
  livemode: boolean;
  created_at: string;
  bookings: { reslab_reservation_number: string | null; status: string | null } | null;
};

type Mode = "live" | "test" | "all";

type Loaded = {
  mode: Mode;
  open: Dispute[];
  closed: Dispute[];
  closedShown: number;
  counts: { open: number; won: number; lost: number; warnings: number | null };
  warnings: Warning[];
  warningError: string | null;
  /** Set on arrival, for the deadline countdown. */
  loadedAtMs: number;
};

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const stripeBase = (live: boolean) => `https://dashboard.stripe.com/${live ? "" : "test/"}`;

function TestPill({ live }: { live: boolean }) {
  return live ? null : <span className="ml-1 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">TEST</span>;
}

/** Stripe's deadline is a real instant: shown in Eastern time with the hour, and hours left under 2 days.
 *  `nowMs` is when the data loaded (no clock read during render). */
function Deadline({ d, nowMs }: { d: Dispute; nowMs: number }) {
  if (d.closed_at) return <span className="text-gray-400">—</span>;
  if (!d.evidence_due_by) return <span className="text-gray-500">check Stripe</span>;
  const { label, hoursLeft } = timeLeftLabel(d.evidence_due_by, nowMs);
  const tone = hoursLeft <= 0 ? "text-gray-500" : hoursLeft < 48 ? "text-red-600 font-semibold" : hoursLeft < 120 ? "text-amber-600" : "text-gray-700";
  return (
    <span className={tone}>
      {formatDeadline(d.evidence_due_by)} <span className="text-xs">({label})</span>
    </span>
  );
}

export default function AdminDisputesPage() {
  // null until the first load: the route picks the deployment's own Stripe
  // mode (staging = test), and returns the mode it applied.
  const [mode, setMode] = useState<Mode | null>(null);
  const [data, setData] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [marking, setMarking] = useState<string | null>(null);
  // Only the newest request may write state: a slow response for the mode
  // you just left must not land under the mode you switched to.
  const requestSeq = useRef(0);

  const load = useCallback(async (wanted: Mode | null) => {
    const seq = ++requestSeq.current;
    setLoading(true);
    setError("");
    setData(null);
    try {
      const res = await fetch(`/api/admin/disputes${wanted ? `?mode=${wanted}` : ""}`);
      const body = await res.json();
      if (seq !== requestSeq.current) return;
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setData({ ...(body as Omit<Loaded, "loadedAtMs">), loadedAtMs: Date.now() });
      setMode((body as Loaded).mode);
    } catch (err) {
      if (seq !== requestSeq.current) return;
      setError(err instanceof Error ? err.message : "Failed to load disputes");
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(null);
  }, [load]);

  async function markSubmitted(id: string) {
    if (!confirm("Mark this dispute as submitted? Only do this after you pressed Submit in Stripe.")) return;
    setMarking(id);
    try {
      const res = await fetch(`/api/admin/disputes/${encodeURIComponent(id)}/submitted`, { method: "POST" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      await load(mode);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Could not mark submitted");
    } finally {
      setMarking(null);
    }
  }

  const rows = data ? [...data.open, ...data.closed] : [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Disputes</h1>
          <p className="text-sm text-gray-500">
            Evidence drafts are saved on the dispute in Stripe, never submitted. Submit there, then mark it here.
          </p>
        </div>
        <select
          value={mode ?? ""}
          onChange={(e) => {
            const next = e.target.value as Mode;
            setMode(next);
            load(next);
          }}
          disabled={loading}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white"
          aria-label="Live or test disputes"
        >
          {mode === null && <option value="">{loading ? "Loading…" : "Choose…"}</option>}
          <option value="live">Live</option>
          <option value="test">Test</option>
          <option value="all">All</option>
        </select>
      </div>

      {loading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-brand-orange" />
        </div>
      ) : error || !data ? (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg p-4 text-sm">
          {error || "Failed to load disputes"}{" "}
          <button onClick={() => load(mode)} className="ml-2 underline font-medium">
            Retry
          </button>
        </div>
      ) : (
        <>
          {/* Tiles only from a successful load — never stale or zero on a failed one. */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {(
              [
                ["Open", data.counts.open],
                ["Won", data.counts.won],
                ["Lost", data.counts.lost],
                ["Fraud warnings", data.counts.warnings ?? "—"],
              ] as const
            ).map(([label, n]) => (
              <div key={label} className="bg-white rounded-xl shadow-sm p-4">
                <div className="text-xs text-gray-500">{label}</div>
                <div className="text-2xl font-bold text-gray-900">{n}</div>
              </div>
            ))}
          </div>

          <div className="bg-white rounded-xl shadow-sm overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs text-gray-500 uppercase">
                <tr>
                  <th className="px-4 py-3">Booking</th>
                  <th className="px-4 py-3">Amount</th>
                  <th className="px-4 py-3">Reason</th>
                  <th className="px-4 py-3">Respond by</th>
                  <th className="px-4 py-3">Evidence</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {rows.map((d) => (
                  <tr key={d.stripe_dispute_id} className={d.closed_at ? "text-gray-500" : ""}>
                    <td className="px-4 py-3">
                      <div className="font-medium">
                        {d.bookings?.reslab_reservation_number ?? "No booking"}
                        <TestPill live={d.livemode} />
                      </div>
                      <div className="text-xs text-gray-500">{d.bookings?.location_name ?? ""}</div>
                    </td>
                    <td className="px-4 py-3">{money(d.amount_cents)}</td>
                    <td className="px-4 py-3">{d.reason.replace(/_/g, " ")}</td>
                    <td className="px-4 py-3">
                      <Deadline d={d} nowMs={data.loadedAtMs} />
                    </td>
                    <td className="px-4 py-3 text-xs">
                      {d.submitted_at ? (
                        <span className="inline-flex items-center gap-1 text-green-700">
                          <CheckCircle2 size={14} /> Submitted {formatDeadline(d.submitted_at)}
                          {d.submitted_by ? ` by ${d.submitted_by}` : ""}
                        </span>
                      ) : d.evidence_drafted_at ? (
                        "Draft saved"
                      ) : d.evidence_draft_error ? (
                        <span className="inline-flex items-center gap-1 text-red-600" title={d.evidence_draft_error}>
                          <AlertTriangle size={14} /> No draft — see reason
                        </span>
                      ) : (
                        "No draft"
                      )}
                    </td>
                    <td className="px-4 py-3">{(d.outcome ?? d.status).replace(/_/g, " ")}</td>
                    <td className="px-4 py-3 whitespace-nowrap text-right">
                      <a
                        href={`${stripeBase(d.livemode)}disputes/${encodeURIComponent(d.stripe_dispute_id)}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-brand-orange hover:underline mr-3"
                      >
                        Stripe <ExternalLink size={12} />
                      </a>
                      {!d.closed_at && !d.submitted_at && (
                        <button
                          onClick={() => markSubmitted(d.stripe_dispute_id)}
                          disabled={marking === d.stripe_dispute_id}
                          className="px-3 py-1 rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-700 text-xs disabled:opacity-50"
                        >
                          {marking === d.stripe_dispute_id ? "Saving…" : "Mark submitted"}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-gray-500">
                      No disputes recorded.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            {data.open.length < data.counts.open && (
              <p className="px-4 py-3 text-sm font-semibold text-red-600">
                Only {data.open.length} of {data.counts.open} open disputes are listed — check Stripe for the rest.
              </p>
            )}
            {data.closed.length >= data.closedShown && (
              <p className="px-4 py-3 text-xs text-gray-500">
                Showing the {data.closedShown} most recently closed disputes. Won/Lost count all of them.
              </p>
            )}
          </div>

          <div>
            <h2 className="text-lg font-semibold text-gray-900 mb-2">Early fraud warnings</h2>
            <p className="text-sm text-gray-500 mb-3">
              The card network&apos;s heads-up that a dispute is likely. If the car was not parked, cancel the booking with a
              full refund from Bookings (that also cancels it at the lot) — a refund before a dispute avoids the dispute fee.
            </p>
            {data.warningError ? (
              <div className="bg-amber-50 border border-amber-200 text-amber-800 rounded-lg p-3 text-sm">
                Fraud warnings unavailable: {data.warningError}
              </div>
            ) : (
              <div className="bg-white rounded-xl shadow-sm overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 text-left text-xs text-gray-500 uppercase">
                    <tr>
                      <th className="px-4 py-3">Booking</th>
                      <th className="px-4 py-3">Type</th>
                      <th className="px-4 py-3">Flagged</th>
                      <th className="px-4 py-3">Can refund first</th>
                      <th className="px-4 py-3"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {data.warnings.map((w) => (
                      <tr key={w.stripe_warning_id}>
                        <td className="px-4 py-3">
                          {w.bookings?.reslab_reservation_number ?? "No booking"}
                          <TestPill live={w.livemode} />
                          {w.bookings?.status ? <span className="text-xs text-gray-500"> · {w.bookings.status}</span> : null}
                        </td>
                        <td className="px-4 py-3">{w.fraud_type.replace(/_/g, " ")}</td>
                        <td className="px-4 py-3">{formatDeadline(w.created_at)}</td>
                        <td className="px-4 py-3">{w.actionable ? "Yes" : "No"}</td>
                        <td className="px-4 py-3 text-right">
                          {w.charge_id && (
                            <a
                              href={`${stripeBase(w.livemode)}payments/${encodeURIComponent(w.charge_id)}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 text-brand-orange hover:underline"
                            >
                              Stripe <ExternalLink size={12} />
                            </a>
                          )}
                        </td>
                      </tr>
                    ))}
                    {data.counts.warnings != null && data.warnings.length < data.counts.warnings && (
                      <tr>
                        <td colSpan={5} className="px-4 py-3 text-xs text-gray-500">
                          Showing the latest {data.warnings.length} of {data.counts.warnings}.
                        </td>
                      </tr>
                    )}
                    {data.warnings.length === 0 && (
                      <tr>
                        <td colSpan={5} className="px-4 py-8 text-center text-gray-500">
                          No fraud warnings.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
