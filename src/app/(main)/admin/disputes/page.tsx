"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, ExternalLink, Loader2 } from "lucide-react";

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

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const stripeBase = (live: boolean) => `https://dashboard.stripe.com/${live ? "" : "test/"}`;

/** Whole days until Stripe's deadline (negative = past). Deadlines are real instants, not booking times. */
function daysLeft(iso: string | null): number | null {
  if (!iso) return null;
  return Math.floor((Date.parse(iso) - Date.now()) / 864e5);
}

function Deadline({ d }: { d: Dispute }) {
  if (d.closed_at) return <span className="text-gray-400">—</span>;
  const left = daysLeft(d.evidence_due_by);
  if (left == null) return <span className="text-gray-500">check Stripe</span>;
  const tone = left < 0 ? "text-gray-500" : left <= 2 ? "text-red-600 font-semibold" : left <= 5 ? "text-amber-600" : "text-gray-700";
  return (
    <span className={tone}>
      {d.evidence_due_by?.slice(0, 10)}{" "}
      <span className="text-xs">({left < 0 ? "passed" : left === 0 ? "today" : `${left}d left`})</span>
    </span>
  );
}

export default function AdminDisputesPage() {
  const [mode, setMode] = useState<Mode>("live");
  const [disputes, setDisputes] = useState<Dispute[]>([]);
  const [warnings, setWarnings] = useState<Warning[]>([]);
  const [warningError, setWarningError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [marking, setMarking] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/admin/disputes?mode=${mode}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setDisputes(data.disputes);
      setWarnings(data.warnings);
      setWarningError(data.warningError);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load disputes");
    } finally {
      setLoading(false);
    }
  }, [mode]);

  useEffect(() => {
    load();
  }, [load]);

  async function markSubmitted(id: string) {
    if (!confirm("Mark this dispute as submitted? Only do this after you pressed Submit in Stripe.")) return;
    setMarking(id);
    try {
      const res = await fetch(`/api/admin/disputes/${encodeURIComponent(id)}/submitted`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      await load();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Could not mark submitted");
    } finally {
      setMarking(null);
    }
  }

  // Open first (nearest deadline first), then closed newest first.
  const open = disputes
    .filter((d) => !d.closed_at)
    .sort((a, b) => (a.evidence_due_by ?? "9").localeCompare(b.evidence_due_by ?? "9"));
  const closed = disputes.filter((d) => d.closed_at);
  const won = closed.filter((d) => d.outcome === "won").length;
  const lost = closed.filter((d) => d.outcome === "lost").length;

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
          value={mode}
          onChange={(e) => setMode(e.target.value as Mode)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white"
          aria-label="Live or test disputes"
        >
          <option value="live">Live</option>
          <option value="test">Test</option>
          <option value="all">All</option>
        </select>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          ["Open", open.length],
          ["Won", won],
          ["Lost", lost],
          ["Fraud warnings", warnings.length],
        ].map(([label, n]) => (
          <div key={label} className="bg-white rounded-xl shadow-sm p-4">
            <div className="text-xs text-gray-500">{label}</div>
            <div className="text-2xl font-bold text-gray-900">{n}</div>
          </div>
        ))}
      </div>

      {loading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-brand-orange" />
        </div>
      ) : error ? (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg p-4 text-sm">{error}</div>
      ) : (
        <>
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
                {[...open, ...closed].map((d) => (
                  <tr key={d.stripe_dispute_id} className={d.closed_at ? "text-gray-500" : ""}>
                    <td className="px-4 py-3">
                      <div className="font-medium">{d.bookings?.reslab_reservation_number ?? "No booking"}</div>
                      <div className="text-xs text-gray-500">{d.bookings?.location_name ?? ""}</div>
                    </td>
                    <td className="px-4 py-3">{money(d.amount_cents)}</td>
                    <td className="px-4 py-3">{d.reason.replace(/_/g, " ")}</td>
                    <td className="px-4 py-3">
                      <Deadline d={d} />
                    </td>
                    <td className="px-4 py-3 text-xs">
                      {d.submitted_at ? (
                        <span className="inline-flex items-center gap-1 text-green-700">
                          <CheckCircle2 size={14} /> Submitted {d.submitted_at.slice(0, 10)}
                          {d.submitted_by ? ` by ${d.submitted_by}` : ""}
                        </span>
                      ) : d.evidence_drafted_at ? (
                        "Draft saved"
                      ) : d.evidence_draft_error ? (
                        <span className="inline-flex items-center gap-1 text-red-600" title={d.evidence_draft_error}>
                          <AlertTriangle size={14} /> Draft failed
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
                {disputes.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-gray-500">
                      No disputes recorded.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div>
            <h2 className="text-lg font-semibold text-gray-900 mb-2">Early fraud warnings</h2>
            <p className="text-sm text-gray-500 mb-3">
              The card network&apos;s heads-up that a dispute is likely. If the car was not parked, refunding now avoids the
              dispute fee.
            </p>
            {warningError ? (
              <div className="bg-amber-50 border border-amber-200 text-amber-800 rounded-lg p-3 text-sm">
                Fraud warnings unavailable: {warningError}
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
                    {warnings.map((w) => (
                      <tr key={w.stripe_warning_id}>
                        <td className="px-4 py-3">
                          {w.bookings?.reslab_reservation_number ?? "No booking"}
                          {w.bookings?.status ? <span className="text-xs text-gray-500"> · {w.bookings.status}</span> : null}
                        </td>
                        <td className="px-4 py-3">{w.fraud_type.replace(/_/g, " ")}</td>
                        <td className="px-4 py-3">{w.created_at.slice(0, 10)}</td>
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
                    {warnings.length === 0 && (
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
