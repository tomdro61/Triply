"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import {
  Calculator,
  Calendar,
  Download,
  Loader2,
  ArrowLeft,
  AlertCircle,
  CheckCircle2,
  Info,
} from "lucide-react";
// `import type` is fully erased at compile time — does not pull the
// server-only reconcile.ts (which imports createAdminClient) into the
// client bundle. Single source of truth for these shapes.
import type {
  DateField,
  BookingDetail,
  ReconcileResult,
} from "@/lib/accounting/types";

// ---- Helpers ----

const usd = (n: number) =>
  `$${(Math.round(n * 100) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function previousMonthDefaults(): { from: string; to: string } {
  const now = new Date();
  const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
  const y = last.getUTCFullYear();
  const m = String(last.getUTCMonth() + 1).padStart(2, "0");
  const d = String(last.getUTCDate()).padStart(2, "0");
  return { from: `${y}-${m}-01`, to: `${y}-${m}-${d}` };
}

// CSV formula injection: Excel/Sheets execute cells starting with `=`, `+`,
// `-`, `@`, `\t`, `\r` as formulas. A customer email like
// `=cmd|'/c calc'!A0@x.com` would run on the admin's machine. Prefix the
// value with a single quote to neutralize. Also escape quotes/commas/newlines.
function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function downloadCsv(bookings: BookingDetail[], filename: string) {
  const header = [
    "booking_id", "reslab_res_num", "status", "created_at", "check_in", "check_out",
    "customer_email", "airport_code", "reslab_location_id", "location_name",
    "grand_total", "due_at_location", "parking_online", "triply_service_fee",
    "protection_plan", "protection_plan_price", "pg_identifier",
    "expected_stripe_estimated_no_promos",
    "reslab_grand_total", "reslab_location_total_owed", "reslab_channel_total",
    "reslab_commissions_total", "reslab_refund_amount", "reslab_partial_refund",
    "reslab_cancelled", "reslab_error",
    "triply_keeps", "note",
  ];
  const lines = [header.join(",")];
  for (const b of bookings) {
    lines.push([
      b.id, b.reslab_reservation_number, b.status,
      b.created_at, b.check_in, b.check_out,
      b.customer_email, b.airport_code, b.reslab_location_id ?? "", b.location_name,
      b.grand_total, b.due_at_location, b.parking_online, b.triply_service_fee,
      b.protection_plan ?? "", b.protection_plan_price, b.pg_identifier ?? "",
      b.expected_stripe,
      b.reslab_grand_total ?? "", b.reslab_location_total ?? "",
      b.reslab_channel_total ?? "", b.reslab_commissions_total ?? "",
      b.reslab_refund_amount ?? "", b.reslab_partial_refund ?? "",
      b.reslab_cancelled ?? "", b.reslab_error ?? "",
      b.triply_keeps, b.note,
    ].map(csvEscape).join(","));
  }
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ---- Components ----

function HeadlineCard({
  title, value, sub, variant,
}: {
  title: string; value: string; sub?: string;
  variant: "neutral" | "good" | "warn" | "bad";
}) {
  const styles = {
    neutral: "bg-white border-gray-200",
    good: "bg-green-50 border-green-200",
    warn: "bg-amber-50 border-amber-200",
    bad: "bg-red-50 border-red-200",
  }[variant];
  const valueColor = {
    neutral: "text-gray-900",
    good: "text-green-700",
    warn: "text-amber-700",
    bad: "text-red-700",
  }[variant];
  return (
    <div className={`rounded-xl border p-6 ${styles}`}>
      <span className="text-sm font-medium text-gray-600">{title}</span>
      <p className={`text-3xl font-bold mt-2 ${valueColor}`}>{value}</p>
      {sub && <p className="text-sm text-gray-500 mt-1">{sub}</p>}
    </div>
  );
}

function Row({ label, value, sub, emphasis }: {
  label: string; value: string; sub?: string; emphasis?: boolean;
}) {
  return (
    <div className={`flex justify-between items-baseline py-2 ${emphasis ? "border-t border-gray-300 mt-2 pt-3 font-semibold" : ""}`}>
      <span className="text-sm text-gray-700">
        {label}
        {sub && <span className="text-xs text-gray-400 ml-2">{sub}</span>}
      </span>
      <span className={`font-mono ${emphasis ? "text-base text-gray-900" : "text-sm text-gray-900"}`}>{value}</span>
    </div>
  );
}

function SectionCard({ title, children, caveat }: { title: string; children: React.ReactNode; caveat?: string }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6">
      <div className="flex items-start justify-between mb-3">
        <h3 className="font-semibold text-gray-900">{title}</h3>
        {caveat && (
          <span className="inline-flex items-center gap-1 text-xs text-amber-700 bg-amber-50 px-2 py-0.5 rounded">
            <Info size={12} />
            {caveat}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

// ---- Page ----

export default function AccountingPage() {
  const defaults = useMemo(() => previousMonthDefaults(), []);
  const [from, setFrom] = useState(defaults.from);
  const [to, setTo] = useState(defaults.to);
  const [by, setBy] = useState<DateField>("checkout");
  const [invoiceInput, setInvoiceInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ReconcileResult | null>(null);

  const runReconciliation = useCallback(async () => {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const params = new URLSearchParams({ from, to, by });
      if (invoiceInput.trim()) params.set("invoice", invoiceInput.trim());
      const res = await fetch(`/api/admin/accounting?${params.toString()}`);
      if (!res.ok) {
        let msg = `Request failed: ${res.status}`;
        try {
          const body = (await res.json()) as { error?: string };
          if (body?.error) msg = body.error;
        } catch {
          // Non-JSON error body (e.g., Next.js HTML error page). Stick with status.
        }
        throw new Error(msg);
      }
      const data = (await res.json()) as ReconcileResult;
      setResult(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [from, to, by, invoiceInput]);

  const varianceVariant = useMemo<"neutral" | "good" | "warn" | "bad">(() => {
    if (!result || result.reslab.variance === null) return "neutral";
    if (result.reslab.invoiceAmount === 0) return "neutral";
    const pct = Math.abs(result.reslab.variance) / Math.max(1, result.reslab.invoiceAmount);
    if (pct < 0.01) return "good";
    if (pct < 0.05) return "warn";
    return "bad";
  }, [result]);

  const csvFilename = result
    ? `reconcile_${result.options.from}_${result.options.to}_${result.options.by}.csv`
    : "reconcile-revenue.csv";

  return (
    <main className="min-h-screen bg-gray-50 pt-20">
      <div className="container mx-auto px-4 py-8 max-w-6xl">
        <div className="mb-6">
          <Link href="/admin" className="inline-flex items-center text-sm text-gray-600 hover:text-coral mb-3">
            <ArrowLeft size={16} className="mr-1" />
            Back to Admin
          </Link>
          <div className="flex items-center gap-3">
            <Calculator size={28} className="text-coral" />
            <h1 className="text-2xl font-bold text-gray-900">Accounting & ResLab Reconciliation</h1>
          </div>
          <p className="text-sm text-gray-600 mt-1">
            Reconcile a ResLab settlement invoice against Triply&apos;s booking data. ResLab invoices by
            trip-completion month — leave the default <strong>Trip checkout</strong> date field.
          </p>
        </div>

        {/* Filters */}
        <div className="bg-white rounded-xl border border-gray-200 p-6 mb-6">
          <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">From</label>
              <input
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-coral focus:border-transparent"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">To (inclusive)</label>
              <input
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-coral focus:border-transparent"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Date field</label>
              <select
                value={by}
                onChange={(e) => setBy(e.target.value as DateField)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-coral focus:border-transparent"
              >
                <option value="checkout">Trip checkout (ResLab)</option>
                <option value="checkin">Trip check-in</option>
                <option value="created">Booking created</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Invoice amount (optional)</label>
              <input
                type="number"
                step="0.01"
                value={invoiceInput}
                onChange={(e) => setInvoiceInput(e.target.value)}
                placeholder="1608.88"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-coral focus:border-transparent"
              />
            </div>
            <div className="flex items-end">
              <button
                onClick={runReconciliation}
                disabled={loading}
                className="w-full px-4 py-2 bg-coral text-white rounded-lg font-medium hover:bg-coral/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {loading ? (
                  <>
                    <Loader2 size={16} className="animate-spin" />
                    Running…
                  </>
                ) : (
                  <>
                    <Calendar size={16} />
                    Run reconciliation
                  </>
                )}
              </button>
            </div>
          </div>
          <p className="text-xs text-gray-500 mt-3">
            ResLab data is fetched live (≈5–10s for a typical month).
          </p>
        </div>

        {/* Error */}
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-xl p-4 mb-6 flex items-start gap-3">
            <AlertCircle size={20} className="text-red-600 mt-0.5 flex-shrink-0" />
            <div>
              <p className="font-medium text-red-900">Reconciliation failed</p>
              <p className="text-sm text-red-700 mt-1">{error}</p>
            </div>
          </div>
        )}

        {/* Results */}
        {result && (
          <>
            {/* Headline cards */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
              <HeadlineCard
                title="Owed to ResLab"
                value={result.reslab.sumLocationTotal !== null ? usd(result.reslab.sumLocationTotal) : "—"}
                sub={`${result.confirmed.commissionsTotal !== null ? `${result.counts.confirmed} confirmed trips` : ""}`}
                variant="neutral"
              />
              <HeadlineCard
                title="Invoice amount"
                value={result.reslab.invoiceAmount > 0 ? usd(result.reslab.invoiceAmount) : "—"}
                sub={result.reslab.invoiceAmount > 0 ? "you entered" : "enter an amount to compare"}
                variant="neutral"
              />
              <HeadlineCard
                title="Variance"
                value={result.reslab.variance !== null && result.reslab.invoiceAmount > 0 ? usd(result.reslab.variance) : "—"}
                sub={
                  result.reslab.variance !== null && result.reslab.invoiceAmount > 0
                    ? `${result.reslab.variance >= 0 ? "+" : ""}${((result.reslab.variance / Math.max(1, result.reslab.invoiceAmount)) * 100).toFixed(2)}% vs invoice`
                    : ""
                }
                variant={varianceVariant}
              />
            </div>

            {/* Sections */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
              <SectionCard title="Stripe cash flow" caveat="estimated">
                <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 mb-3 flex items-start gap-2">
                  <AlertCircle size={16} className="text-amber-600 mt-0.5 flex-shrink-0" />
                  <p className="text-xs text-amber-900">
                    <strong>Do not use these figures for tax, audit, or board reporting.</strong> Computed from
                    booking-row composition (parking + service fee + PG), NOT from Stripe&apos;s
                    actual <code>amount_received</code>. <strong>Promo-discounted bookings are overstated
                    by the discount amount.</strong> Cross-check against the Stripe Dashboard for any
                    figure that needs to be exact.
                  </p>
                </div>
                <Row label="Gross collected (≈)" value={usd(result.stripe.gross)} />
                <Row label="Refunded to customers (≈)" value={`−${usd(result.stripe.refunded)}`} />
                <Row label="Net Stripe receipts (≈)" value={usd(result.stripe.net)} emphasis />
              </SectionCard>

              <SectionCard title="Triply net revenue (after refunds)">
                <Row
                  label="Channel commission (parking)"
                  value={result.triplyNet.parkingChannelCommission !== null ? usd(result.triplyNet.parkingChannelCommission) : "—"}
                  sub="ResLab channel_total"
                />
                <Row
                  label="Service fee"
                  value={usd(result.triplyNet.serviceFee)}
                  sub="incl. retained on refunds"
                />
                <Row label="Park Guard margin" value={usd(result.triplyNet.pgMargin)} />
                <Row
                  label="Total Triply gross"
                  value={result.triplyNet.total !== null ? usd(result.triplyNet.total) : "—"}
                  emphasis
                />
                <p className="text-xs text-gray-400 mt-2">
                  Stripe processing fees (~2.9% + $0.30/charge) not deducted here.
                  {result.triplyNet.total === null && (
                    <> Enable ResLab cross-check for an authoritative total.</>
                  )}
                </p>
              </SectionCard>

              <SectionCard title="Confirmed bookings — composition">
                <Row label="Parking — collected online" value={usd(result.confirmed.parkingOnline)} />
                <Row label="Triply service fee" value={usd(result.confirmed.serviceFee)} />
                <Row
                  label="Park Guard premium"
                  value={usd(result.confirmed.pgPremium)}
                  sub={`${result.confirmed.pgOptIns} opt-in${result.confirmed.pgOptIns === 1 ? "" : "s"}`}
                />
                <Row label="     PG wholesale owed" value={`−${usd(result.confirmed.pgWholesale)}`} />
                <Row label="     Triply PG margin" value={usd(result.confirmed.pgMargin)} />
                <Row
                  label="Due-at-location"
                  value={usd(result.confirmed.dueAtLot)}
                  sub="paid to lot directly; never touched Stripe"
                />
              </SectionCard>

              <SectionCard title="ResLab settlement view">
                <Row
                  label="Owed to ResLab (sum location_total)"
                  value={result.confirmed.locationTotalOwed !== null ? usd(result.confirmed.locationTotalOwed) : "—"}
                />
                <Row
                  label="Triply channel commission (channel_total)"
                  value={result.confirmed.channelTotal !== null ? usd(result.confirmed.channelTotal) : "—"}
                />
                {/* commissions_total IS the lot's share of subtotal — verified
                    against ResLab dashboard "Location Commission" column for
                    RTL764193 (probe-reslab-fields run, 2026-06-01): API
                    returned commissions_total=$52.75 matching dashboard's
                    $52.75. Lot share + channel share = subtotal ✓. */}
                <Row
                  label="Lot commission (commissions_total)"
                  value={result.confirmed.commissionsTotal !== null ? usd(result.confirmed.commissionsTotal) : "—"}
                  sub="lot's share — included in 'Owed to ResLab'"
                />
                {result.reslab.grandTotalMismatches.length === 0 && result.reslab.fetched > 0 ? (
                  <div className="mt-3 text-xs text-green-700 flex items-center gap-1">
                    <CheckCircle2 size={14} />
                    All {result.reslab.fetched} ResLab grand_totals match Supabase.
                  </div>
                ) : result.reslab.grandTotalMismatches.length > 0 ? (
                  <div className="mt-3 text-xs text-amber-700">
                    ⚠ {result.reslab.grandTotalMismatches.length} grand_total mismatches (see CSV)
                  </div>
                ) : null}
                {result.reslab.fetchErrors.length > 0 && (
                  <div className="mt-2 text-xs text-red-700">
                    ⚠ {result.reslab.fetchErrors.length} ResLab fetch errors (see CSV)
                  </div>
                )}
                {/* M-P2-6: surface refunded bookings whose ResLab record
                    still shows non-zero location_total — ResLab may invoice
                    for these unless the cancellation propagated. */}
                {(() => {
                  const stragglers = result.bookings.filter(
                    (b) => b.status === "refunded" && (b.reslab_location_total ?? 0) > 0
                  );
                  if (stragglers.length === 0) return null;
                  const sum = stragglers.reduce((s, b) => s + (b.reslab_location_total ?? 0), 0);
                  return (
                    <div className="mt-2 text-xs text-amber-700">
                      ⚠ {stragglers.length} refunded booking{stragglers.length === 1 ? "" : "s"} still
                      show non-zero location_total in ResLab ({usd(sum)}). Verify the cancellation
                      propagated before paying the invoice.
                    </div>
                  );
                })()}
              </SectionCard>
            </div>

            {/* Counts + actions */}
            <div className="bg-white rounded-xl border border-gray-200 p-6 mb-6">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="text-sm text-gray-600">
                  <span className="font-semibold text-gray-900">{result.counts.total}</span> bookings:{" "}
                  {result.counts.confirmed} confirmed, {result.counts.refunded} refunded,{" "}
                  {result.counts.cancelled} cancelled
                  {result.counts.other > 0 ? `, ${result.counts.other} other` : ""}
                  {result.counts.testExcluded > 0 && (
                    <span className="ml-2 text-gray-400">
                      ({result.counts.testExcluded} test booking{result.counts.testExcluded === 1 ? "" : "s"} excluded)
                    </span>
                  )}
                </div>
                <button
                  onClick={() => downloadCsv(result.bookings, csvFilename)}
                  className="px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50 flex items-center gap-2"
                >
                  <Download size={16} />
                  Download CSV
                </button>
              </div>
            </div>

            {/* Per-booking table */}
            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              <div className="px-6 py-4 border-b border-gray-200">
                <h3 className="font-semibold text-gray-900">Per-booking detail</h3>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
                    <tr>
                      <th className="px-4 py-2">Res #</th>
                      <th className="px-4 py-2">Status</th>
                      <th className="px-4 py-2">Trip checkout</th>
                      <th className="px-4 py-2">Lot</th>
                      <th className="px-4 py-2 text-right">Grand total</th>
                      <th className="px-4 py-2 text-right">Owed (ResLab)</th>
                      <th className="px-4 py-2 text-right">Triply ch.</th>
                      <th className="px-4 py-2 text-right">Triply keeps</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {result.bookings.map((b) => (
                      <tr key={b.id} className={b.status !== "confirmed" ? "bg-gray-50" : ""}>
                        <td className="px-4 py-2 font-mono text-xs text-gray-700">{b.reslab_reservation_number}</td>
                        <td className="px-4 py-2">
                          <span
                            className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                              b.status === "confirmed"
                                ? "bg-green-100 text-green-800"
                                : b.status === "refunded"
                                ? "bg-red-100 text-red-800"
                                : "bg-gray-100 text-gray-700"
                            }`}
                          >
                            {b.status}
                          </span>
                        </td>
                        <td className="px-4 py-2 text-gray-600">{b.check_out?.slice(0, 10)}</td>
                        <td className="px-4 py-2 text-gray-700 max-w-xs truncate" title={b.location_name}>
                          {b.airport_code}{" — "}{b.location_name}
                        </td>
                        <td className="px-4 py-2 text-right font-mono text-gray-700">{usd(b.grand_total)}</td>
                        <td className="px-4 py-2 text-right font-mono text-gray-700">
                          {b.reslab_location_total !== null ? usd(b.reslab_location_total) : "—"}
                        </td>
                        <td className="px-4 py-2 text-right font-mono text-gray-700">
                          {b.reslab_channel_total !== null ? usd(b.reslab_channel_total) : "—"}
                        </td>
                        <td className="px-4 py-2 text-right font-mono text-gray-900 font-medium">{usd(b.triply_keeps)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {result.bookings.length === 0 && (
                <p className="px-6 py-12 text-center text-gray-500">No bookings in this window.</p>
              )}
            </div>
          </>
        )}
      </div>
    </main>
  );
}
