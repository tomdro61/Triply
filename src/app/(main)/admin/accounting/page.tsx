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
  TrendingUp,
  Receipt,
  Percent,
} from "lucide-react";
import type {
  DateField,
  BookingDetail,
  ReconcileResult,
} from "@/lib/accounting/types";

// ---- Helpers ----

const usd = (n: number) => {
  const abs = Math.abs(n);
  const formatted = (Math.round(abs * 100) / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return n < 0 ? `−$${formatted}` : `$${formatted}`;
};

const pct = (r: number | null) =>
  r === null ? "—" : `${(r * 100).toFixed(1)}%`;

function previousMonthDefaults(): { from: string; to: string } {
  const now = new Date();
  const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
  const y = last.getUTCFullYear();
  const m = String(last.getUTCMonth() + 1).padStart(2, "0");
  const d = String(last.getUTCDate()).padStart(2, "0");
  return { from: `${y}-${m}-01`, to: `${y}-${m}-${d}` };
}

// CSV formula injection: prefix any value starting with `=`, `+`, `-`, `@`,
// `\t`, `\r` with a single quote to neutralize Excel/Sheets execution.
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
    "grand_total", "subtotal", "due_at_location", "parking_online", "triply_service_fee",
    "protection_plan", "protection_plan_price", "pg_identifier",
    "expected_stripe_estimated", "stripe_amount_received", "stripe_amount_refunded",
    "stripe_fee", "stripe_status", "stripe_error",
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
      b.grand_total, b.subtotal, b.due_at_location, b.parking_online, b.triply_service_fee,
      b.protection_plan ?? "", b.protection_plan_price, b.pg_identifier ?? "",
      b.expected_stripe,
      b.stripe_amount_received ?? "", b.stripe_amount_refunded ?? "",
      b.stripe_fee ?? "", b.stripe_status ?? "", b.stripe_error ?? "",
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

// ---- Small components ----

function HeadlineCard({
  title, value, sub, icon: Icon, accent,
}: {
  title: string; value: string; sub?: string;
  icon: React.ElementType;
  accent: "coral" | "green" | "blue" | "purple";
}) {
  const accentCls = {
    coral: "bg-orange-100 text-coral",
    green: "bg-green-100 text-green-700",
    blue: "bg-blue-100 text-blue-700",
    purple: "bg-purple-100 text-purple-700",
  }[accent];
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-6">
      <div className="flex items-center justify-between mb-4">
        <span className="text-sm font-medium text-gray-500">{title}</span>
        <div className={`p-2 rounded-lg ${accentCls}`}><Icon size={20} /></div>
      </div>
      <p className="text-3xl font-bold text-gray-900">{value}</p>
      {sub && <p className="text-sm text-gray-500 mt-1">{sub}</p>}
    </div>
  );
}

function VarianceCard({ value, sub, variant }: {
  value: string; sub?: string; variant: "neutral" | "good" | "warn" | "bad";
}) {
  const ring = {
    neutral: "border-gray-200",
    good: "border-green-300 bg-green-50",
    warn: "border-amber-300 bg-amber-50",
    bad: "border-red-300 bg-red-50",
  }[variant];
  const text = {
    neutral: "text-gray-900",
    good: "text-green-700",
    warn: "text-amber-700",
    bad: "text-red-700",
  }[variant];
  return (
    <div className={`rounded-xl border-2 p-6 ${ring}`}>
      <span className="text-sm font-medium text-gray-600">Variance vs invoice</span>
      <p className={`text-3xl font-bold mt-2 ${text}`}>{value}</p>
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

function SectionCard({ title, subtitle, children, caveat }: {
  title: string; subtitle?: string; children: React.ReactNode; caveat?: React.ReactNode;
}) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6">
      <div className="mb-3">
        <h3 className="font-semibold text-gray-900">{title}</h3>
        {subtitle && <p className="text-xs text-gray-500 mt-0.5">{subtitle}</p>}
      </div>
      {caveat}
      {children}
    </div>
  );
}

function RateRow({ label, question, numerator, denominator, useWhen, value }: {
  label: string;
  question: string;
  numerator: string;
  denominator: string;
  useWhen: string;
  value: string;
}) {
  return (
    <div className="py-4 border-b border-gray-100 last:border-b-0">
      <div className="flex items-baseline justify-between gap-4 mb-2">
        <p className="text-sm font-semibold text-gray-900">{label}</p>
        <span className="text-2xl font-bold text-coral font-mono">{value}</span>
      </div>
      <p className="text-sm text-gray-700 italic mb-3">&ldquo;{question}&rdquo;</p>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-x-6 gap-y-2 text-xs">
        <div>
          <p className="text-gray-500 font-medium uppercase tracking-wider text-[10px] mb-0.5">Numerator</p>
          <p className="text-gray-700">{numerator}</p>
        </div>
        <div>
          <p className="text-gray-500 font-medium uppercase tracking-wider text-[10px] mb-0.5">Denominator</p>
          <p className="text-gray-700">{denominator}</p>
        </div>
        <div>
          <p className="text-gray-500 font-medium uppercase tracking-wider text-[10px] mb-0.5">Use when</p>
          <p className="text-gray-700">{useWhen}</p>
        </div>
      </div>
    </div>
  );
}

// ---- Page ----

export default function AccountingPage() {
  const defaults = useMemo(() => previousMonthDefaults(), []);
  const [from, setFrom] = useState(defaults.from);
  const [to, setTo] = useState(defaults.to);
  // Default to "created" for general reporting (matches /admin dashboard).
  // Switch to "checkout" when reconciling against a ResLab invoice.
  const [by, setBy] = useState<DateField>("created");
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
          // Non-JSON error body — stick with status.
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
    const r = Math.abs(result.reslab.variance) / Math.max(1, result.reslab.invoiceAmount);
    if (r < 0.01) return "good";
    if (r < 0.05) return "warn";
    return "bad";
  }, [result]);

  const csvFilename = result
    ? `reconcile_${result.options.from}_${result.options.to}_${result.options.by}.csv`
    : "reconcile-revenue.csv";

  const dateFieldHelp = {
    created: "Filter by booking-creation date. Matches the /admin dashboard. Use this for general reporting (\"what did we sell in May\").",
    checkout: "Filter by trip-completion (check-out) date. ResLab invoices use this model — pick a month and the totals will match a ResLab settlement statement.",
    checkin: "Filter by trip start (check-in) date. Less common; useful for arrival-based reporting.",
  }[by];

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
            <h1 className="text-2xl font-bold text-gray-900">Accounting & Reports</h1>
          </div>
          <p className="text-sm text-gray-600 mt-1">
            Pick a date range to see what was sold, what was collected, and what Triply made. Use
            the date-field selector to switch between general reporting and ResLab invoice
            reconciliation.
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
                <option value="created">Booking created (general reports)</option>
                <option value="checkout">Trip checkout (ResLab invoice)</option>
                <option value="checkin">Trip check-in</option>
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
                    Run
                  </>
                )}
              </button>
            </div>
          </div>
          <div className="flex items-start gap-2 mt-3 text-xs text-gray-500">
            <Info size={14} className="mt-0.5 flex-shrink-0" />
            <p>{dateFieldHelp}</p>
          </div>
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
            {/* === REPORTING HEADLINES === */}
            <h2 className="text-sm uppercase font-semibold text-gray-500 tracking-wider mb-3">Reporting</h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
              <HeadlineCard
                title="Total bookings"
                value={String(result.counts.total)}
                sub={`${result.counts.confirmed} confirmed · ${result.counts.refunded} refunded · ${result.counts.cancelled} cancelled${result.counts.testExcluded > 0 ? ` · ${result.counts.testExcluded} test excl.` : ""}`}
                icon={Receipt}
                accent="blue"
              />
              <HeadlineCard
                title="Gross revenue"
                value={usd(result.grossRevenue)}
                sub="sum of grand_total for confirmed bookings (incl. due-at-lot)"
                icon={TrendingUp}
                accent="purple"
              />
              <HeadlineCard
                title="Triply revenue (gross)"
                value={result.triplyNet.total !== null ? usd(result.triplyNet.total) : "—"}
                sub={
                  result.triplyNet.totalReason
                    ? `unavailable — ${result.triplyNet.totalReason}`
                    : result.triplyNet.cashTotal !== null
                    ? `net cash ≈ ${usd(result.triplyNet.cashTotal)} after Stripe fees`
                    : // M3: gross is known, cash isn't — signal this in the headline
                      // so admins don't over-quote the gross number to stakeholders.
                      "service fee + channel commission + PG margin · net cash unavailable (Stripe data missing)"
                }
                icon={Calculator}
                accent="coral"
              />
            </div>

            {/* === TAKE RATES === */}
            <div className="bg-white rounded-xl border border-gray-200 p-6 mb-6">
              <div className="flex items-center gap-2 mb-1">
                <Percent size={18} className="text-coral" />
                <h3 className="font-semibold text-gray-900">Triply take rates</h3>
              </div>
              <p className="text-xs text-gray-500 mb-2">
                Three ways to answer &quot;what % does Triply earn?&quot; — each one slices the
                business differently. The rate to quote depends on the conversation you&apos;re in.
              </p>
              <p className="text-xs text-gray-500 mb-4">
                <strong>Triply income</strong> (the numerator on the first two) ={" "}
                service fee + channel commission (parking-side) + Park Guard margin. See each row
                for the exact components and when each rate matters.
              </p>
              <div className="space-y-1">
                <RateRow
                  label="Effective Stripe take rate"
                  question="Of every dollar customers paid Triply through Stripe, what % did Triply keep?"
                  numerator="service fee + channel commission + Park Guard margin"
                  denominator="Stripe gross collected (sum of amount_received across all bookings)"
                  useWhen="Quoting effective margin on customer payments — investor/board pitch."
                  value={pct(result.takeRates.stripeTakeRate)}
                />
                <RateRow
                  label="Total take rate"
                  question="Of every dollar that moved through the booking (incl. due-at-lot), what % did Triply touch?"
                  numerator="service fee + channel commission + Park Guard margin"
                  denominator="Stripe gross + due-at-lot (the portion customers paid the lot directly at the gate)"
                  useWhen="Conservative view — share of all transaction value, including money Triply never touched."
                  value={pct(result.takeRates.totalTakeRate)}
                />
                <RateRow
                  label="Channel commission rate"
                  question="What % of parking subtotal does ResLab give Triply as the channel's cut?"
                  numerator="ResLab channel_total ONLY — parking-side commission, no service fee, no PG"
                  denominator="ResLab subtotal — parking pre-tax, pre-fee (no due-at-lot)"
                  useWhen="ResLab contract conversations — negotiating per-lot splits. Weighted across all lots in the period."
                  value={pct(result.takeRates.channelCommissionRate)}
                />
                <RateRow
                  label="Net effective take rate (after Stripe fees)"
                  question="Of every dollar customers paid via Stripe, what % does Triply ACTUALLY keep after Stripe's processing fees?"
                  numerator="Triply income MINUS Stripe processing fees (the closest thing to actual cash margin)"
                  denominator="Stripe gross collected"
                  useWhen="Internal P&L / cash-on-hand conversations. The number that hits Triply's bank account."
                  value={pct(result.takeRates.netStripeTakeRate)}
                />
              </div>
            </div>

            {/* === TRIPLY REVENUE BREAKDOWN + CASH FLOW === */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
              <SectionCard
                title="Triply revenue breakdown"
                subtitle="Where the income comes from — and what Triply actually banks"
              >
                <Row
                  label="Channel commission (parking)"
                  value={result.triplyNet.parkingChannelCommission !== null ? usd(result.triplyNet.parkingChannelCommission) : "—"}
                  sub="ResLab channel_total — varies by lot"
                />
                <Row
                  label="Service fee"
                  value={usd(result.triplyNet.serviceFee)}
                  sub="incl. retained on refunds"
                />
                <Row
                  label="Park Guard margin"
                  value={usd(result.triplyNet.pgMargin)}
                  sub={result.triplyNet.pgMargin < 0 ? "⚠ NEGATIVE — see PG opt-ins" : `${result.confirmed.pgOptIns} opt-in${result.confirmed.pgOptIns === 1 ? "" : "s"}`}
                />
                <Row
                  label="Total Triply revenue (gross)"
                  value={result.triplyNet.total !== null ? usd(result.triplyNet.total) : "—"}
                  emphasis
                />
                <Row
                  label="Stripe processing fees"
                  value={
                    // Suppress the deduction line when the gross total is "—"
                    // (M2): showing a concrete fee against an unknown base
                    // produces a visually misleading "we lost $60" reading.
                    result.triplyNet.total === null
                      ? "—"
                      : result.triplyNet.stripeProcessingFees === null
                      ? "—"
                      : result.triplyNet.stripeProcessingFees > 0
                      ? `−${usd(result.triplyNet.stripeProcessingFees)}`
                      : usd(0) // M1: no leading minus when fees are zero
                  }
                  sub={
                    result.triplyNet.total === null
                      ? "n/a — Triply revenue unavailable"
                      : result.triplyNet.stripeProcessingFees !== null
                      ? "balance_transaction.fee on each charge (original capture fee)"
                      : "Stripe data unavailable — enable live Stripe to deduct"
                  }
                />
                <Row
                  label="Net cash to Triply"
                  value={result.triplyNet.cashTotal !== null ? usd(result.triplyNet.cashTotal) : "—"}
                  emphasis
                />
                <p className="text-xs text-gray-400 mt-3">
                  Note: Stripe sometimes refunds the processing fee back on full refunds (varies
                  by country/timing). This figure uses the original capture fee; for partial refunds
                  the actual fee paid may be slightly lower.
                </p>
              </SectionCard>

              <SectionCard
                title="Cash flow"
                subtitle={result.stripe.isDerived ? "Estimated (Stripe lookup unavailable)" : "Live from Stripe"}
                caveat={result.stripe.isDerived ? (
                  <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 mb-3 flex items-start gap-2">
                    <AlertCircle size={16} className="text-amber-600 mt-0.5 flex-shrink-0" />
                    <p className="text-xs text-amber-900">
                      <strong>These are estimates, not Stripe-actual figures.</strong> Computed from
                      booking-row composition because the live Stripe lookup is unavailable
                      (test-mode keys, or {result.stripeFetch.derivedFallbacks} per-booking fetches failed).
                      Promo-discounted bookings will be overstated. Production Vercel env uses live keys.
                    </p>
                  </div>
                ) : undefined}
              >
                <Row
                  label={result.stripe.isDerived ? "Gross collected (≈)" : "Gross collected"}
                  value={usd(result.stripe.gross)}
                />
                <Row
                  label={result.stripe.isDerived ? "Refunded to customers (≈)" : "Refunded to customers"}
                  value={result.stripe.refunded > 0 ? `−${usd(result.stripe.refunded)}` : usd(0)}
                />
                <Row
                  label={result.stripe.isDerived ? "Net Stripe receipts (≈)" : "Net Stripe receipts"}
                  value={usd(result.stripe.net)}
                  emphasis
                />
                {!result.stripe.isDerived && result.stripeFetch.fetched > 0 && (
                  <p className="text-xs text-green-700 mt-3 flex items-center gap-1">
                    <CheckCircle2 size={14} />
                    {result.stripeFetch.fetched} bookings fetched from Stripe (live).
                  </p>
                )}
              </SectionCard>
            </div>

            {/* === RESLAB SETTLEMENT (only relevant when reconciling an invoice) === */}
            <h2 className="text-sm uppercase font-semibold text-gray-500 tracking-wider mb-3">
              ResLab settlement
            </h2>
            <p className="text-xs text-gray-500 mb-3">
              Use this section when you receive a settlement invoice from ResLab. Switch the date
              filter to <strong>Trip checkout</strong> and the invoice month for the totals to
              match.
            </p>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
              <HeadlineCard
                title="Owed to ResLab"
                value={result.reslab.sumLocationTotal !== null ? usd(result.reslab.sumLocationTotal) : "—"}
                sub={`sum location_total · ${result.reslab.fetched} fetched`}
                icon={Receipt}
                accent="blue"
              />
              <HeadlineCard
                title="Invoice amount"
                value={result.reslab.invoiceAmount > 0 ? usd(result.reslab.invoiceAmount) : "—"}
                sub={result.reslab.invoiceAmount > 0 ? "you entered" : "enter to compare"}
                icon={Receipt}
                accent="purple"
              />
              <VarianceCard
                value={result.reslab.variance !== null && result.reslab.invoiceAmount > 0 ? usd(result.reslab.variance) : "—"}
                sub={
                  result.reslab.variance !== null && result.reslab.invoiceAmount > 0
                    ? `${result.reslab.variance >= 0 ? "+" : ""}${((result.reslab.variance / Math.max(1, result.reslab.invoiceAmount)) * 100).toFixed(2)}% vs invoice`
                    : ""
                }
                variant={varianceVariant}
              />
            </div>

            <div className="bg-white rounded-xl border border-gray-200 p-6 mb-6">
              <h3 className="font-semibold text-gray-900 mb-3">ResLab breakdown</h3>
              <Row
                label="Triply channel commission (channel_total)"
                value={result.confirmed.channelTotal !== null ? usd(result.confirmed.channelTotal) : "—"}
                sub="Triply's parking-side income"
              />
              {/* commissions_total IS the lot's share of subtotal —
                  verified against ResLab dashboard "Location Commission"
                  for RTL764193 ($52.75). Lot share + channel share = subtotal. */}
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
                    propagated before paying.
                  </div>
                );
              })()}
            </div>

            {/* === COUNTS + CSV ACTIONS === */}
            <div className="bg-white rounded-xl border border-gray-200 p-6 mb-6">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="text-sm text-gray-600">
                  Filtered by <span className="font-semibold text-gray-900">{by === "created" ? "booking-created" : by === "checkout" ? "trip-checkout" : "trip-checkin"}</span> date,{" "}
                  <span className="font-semibold text-gray-900">{from}</span> to{" "}
                  <span className="font-semibold text-gray-900">{to}</span>.
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

            {/* === PER-BOOKING TABLE === */}
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
                        <td className={`px-4 py-2 text-right font-mono font-medium ${b.triply_keeps < 0 ? "text-red-600" : "text-gray-900"}`}>
                          {usd(b.triply_keeps)}
                        </td>
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
