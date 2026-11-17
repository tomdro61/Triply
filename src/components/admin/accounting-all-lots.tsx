"use client";

import { Download } from "lucide-react";
import { csvEscape } from "@/lib/utils/csv";
import { combinedTotal, directCsv, dollarsToCents } from "@/lib/accounting/all-lots";
import type { DirectBookingDetail, DirectDetail, DirectSum, ReconcileResult } from "@/lib/accounting/types";

/**
 * /admin/accounting: ResLab lots and direct lots side by side, and the direct
 * bookings one by one. Display only. The ResLab figures are the report's own
 * (dollars); the direct figures come from `result.direct.detail` (integer
 * cents, the payout statement's rules). An unknown figure is "—", never $0.
 */

const usdCents = (cents: number) => `${cents < 0 ? "−" : ""}$${(Math.abs(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const STATE_LABEL: Record<DirectBookingDetail["state"], string> = {
  ok: "",
  needs_decision: "Needs your decision",
  adjustment_pending: "Adjustment pending",
  not_read: "Payment not read",
  no_figure: "No figure",
  blocked: "Blocked",
};

function detailOf(result: ReconcileResult): DirectDetail | null {
  const d = result.direct.detail;
  return d && "bookings" in d ? d : null;
}

/** A direct-lot cell: the sum of the bookings that have a figure, and how many that is when not all. */
function DirectCell({ sum }: { sum: DirectSum | null }) {
  if (!sum) return <>—</>;
  if (sum.of === 0) return <>{usdCents(0)}</>;
  return (
    <>
      {sum.known === 0 ? "—" : usdCents(sum.cents)}
      {sum.known < sum.of && (
        <div className="text-xs font-normal text-amber-700">
          {sum.known} of {sum.of} bookings
        </div>
      )}
    </>
  );
}

/** ResLab + direct. "—" when either side is unknown; marked when the direct side is only part of its bookings. */
function TotalCell({ reslabCents, sum, approx }: { reslabCents: number | null; sum: DirectSum | null; approx?: boolean }) {
  const total = combinedTotal(reslabCents, sum);
  if (!total) return <>—</>;
  return (
    <>
      {approx ? "≈ " : ""}
      {usdCents(total.cents)}
      {total.missing > 0 && <div className="text-xs font-normal text-amber-700">without {total.missing} direct booking{total.missing === 1 ? "" : "s"}</div>}
    </>
  );
}

export function AllLotsSummary({ result }: { result: ReconcileResult }) {
  const direct = result.direct;
  const detail = detailOf(result);
  const failed = direct.detail && "error" in direct.detail ? direct.detail.error : null;
  const t = detail?.totals ?? null;
  const net = result.triplyNet;
  const cents = (v: number | null) => (v === null ? null : dollarsToCents(v));
  const reslabCell = (v: number | null, approx = false) => (v === null ? "—" : `${approx ? "≈ " : ""}${usdCents(dollarsToCents(v))}`);
  const waiting = detail ? detail.bookings.filter((b) => b.state !== "ok").length : 0;

  const rows: Array<{ label: string; hint: string; reslab: number | null; approx?: boolean; sum: DirectSum | null; strong?: boolean }> = [
    {
      label: "Collected online, after refunds",
      hint: "What customers paid by card, less refunds. Not Triply's revenue: most of it is owed to the lots.",
      reslab: result.stripe.net,
      approx: result.stripe.isDerived,
      sum: t?.collected ?? null,
    },
    {
      label: "Triply revenue (before Stripe fees)",
      hint: "ResLab lots: service fee + channel commission − ResLab fee − promo discounts + Park Guard margin. Direct lots: what was collected, less what the lot is owed, Park Guard wholesale and tax Triply remits.",
      reslab: net.total,
      sum: t?.gross ?? null,
    },
    { label: "Stripe fees", hint: "Stripe's processing fees on these bookings.", reslab: net.stripeProcessingFees, sum: t?.stripeFees ?? null },
    { label: "Net cash to Triply", hint: "Triply revenue less Stripe fees.", reslab: net.cashTotal, sum: t?.net ?? null, strong: true },
  ];

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6 mb-6">
      <h3 className="font-semibold text-gray-900 mb-1">All lots</h3>
      <p className="text-xs text-gray-500 mb-4">
        ResLab lots and Triply&apos;s direct lots for the dates above, and the two added together. The sections under the &quot;ResLab lots&quot; heading below are ResLab lots only.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-xs text-gray-600 uppercase">
            <tr>
              <th className="px-3 py-2 text-left" />
              <th className="px-3 py-2 text-right">ResLab lots</th>
              <th className="px-3 py-2 text-right">Direct lots</th>
              <th className="px-3 py-2 text-right">Total</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            <tr>
              <td className="px-3 py-2 text-gray-700">Bookings</td>
              <td className="px-3 py-2 text-right font-mono">{result.counts.total}</td>
              <td className="px-3 py-2 text-right font-mono">
                {direct.count}
                {direct.count > 0 && (
                  <div className="text-xs font-normal text-gray-500">
                    {direct.confirmed} confirmed · {direct.refunded + direct.cancelled} cancelled{direct.other > 0 ? ` · ${direct.other} other` : ""}
                  </div>
                )}
              </td>
              <td className="px-3 py-2 text-right font-mono">{result.counts.total + direct.count}</td>
            </tr>
            {rows.map((r) => (
              <tr key={r.label} className={r.strong ? "font-semibold bg-gray-50" : ""}>
                <td className="px-3 py-2 text-gray-700" title={r.hint}>
                  {r.label}
                </td>
                <td className="px-3 py-2 text-right font-mono">{reslabCell(r.reslab, r.approx)}</td>
                <td className="px-3 py-2 text-right font-mono">
                  <DirectCell sum={r.sum} />
                </td>
                <td className={`px-3 py-2 text-right font-mono ${r.strong ? "text-navy" : ""}`}>
                  <TotalCell reslabCents={cents(r.reslab)} sum={r.sum} approx={r.approx} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {failed && <p className="mt-3 text-sm text-red-700">{failed}</p>}
      {!detail && !failed && direct.count > 0 && <p className="mt-3 text-sm text-amber-800">Direct-lot figures were not requested for this report.</p>}
      {net.total === null && net.totalReason && <p className="mt-3 text-xs text-amber-800">ResLab lots: Triply revenue unavailable — {net.totalReason}.</p>}
      {net.total !== null && net.cashTotal === null && <p className="mt-3 text-xs text-amber-800">ResLab lots: Stripe fees could not be read for every booking, so net cash is unavailable.</p>}
      {result.stripe.isDerived && <p className="mt-3 text-xs text-amber-800">≈ ResLab lots: collected online is partly estimated from the booking rows, not read from Stripe.</p>}
      {waiting > 0 && (
        <p className="mt-3 text-xs text-amber-800">
          {waiting} direct booking{waiting === 1 ? " has" : "s have"} no figure yet and {waiting === 1 ? "is" : "are"} left out of the revenue, Stripe fees and net cash rows (a payment that was read is still in &quot;Collected online&quot;, unless the booking is disputed). See &quot;Direct lots — per booking&quot; below for the reason on each.
        </p>
      )}
      {direct.stripeErrors.length > 0 && <p className="mt-3 text-xs text-amber-800">{direct.stripeErrors.length} direct booking payment{direct.stripeErrors.length === 1 ? "" : "s"} could not be read from Stripe.</p>}
      <p className="mt-3 text-xs text-gray-500">
        Disputed bookings: their money is in neither column. The ResLab column still counts their Stripe fee; a disputed direct booking has no figure.
      </p>
      <p className="mt-3 text-xs text-gray-500">
        Direct lots: &quot;owed to lot&quot; is what was recorded as paid when the booking is on a paid statement, and what the payout rules say is due when it is not paid yet. A booking the customer cancelled shows a small loss (the Stripe fee), because the service fee is refunded too.
      </p>
    </div>
  );
}

function downloadDirectCsv(bookings: DirectBookingDetail[], filename: string) {
  const blob = new Blob([directCsv(bookings, csvEscape)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

const cell = (cents: number | null) => (cents === null ? "—" : usdCents(cents));

export function DirectBookingsTable({ result, csvFilename }: { result: ReconcileResult; csvFilename: string }) {
  const detail = detailOf(result);
  if (!detail || detail.bookings.length === 0) return null;
  const t = detail.totals;
  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden mt-6">
      <div className="px-6 py-4 border-b border-gray-200 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-semibold text-gray-900">Direct lots — per booking</h3>
          <p className="text-xs text-gray-500 mt-1">Triply&apos;s own lots, for the dates above. Paying a lot is done in the &quot;Triply lots — payouts&quot; section below.</p>
        </div>
        <button
          onClick={() => downloadDirectCsv(detail.bookings, csvFilename)}
          className="px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50 flex items-center gap-2"
        >
          <Download size={16} />
          Download direct-lot CSV
        </button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
            <tr>
              <th className="px-4 py-2">Booking</th>
              <th className="px-4 py-2">Check-out</th>
              <th className="px-4 py-2">Lot</th>
              <th className="px-4 py-2 text-right">Customer paid / refunded</th>
              <th className="px-4 py-2 text-right">Owed to lot</th>
              <th className="px-4 py-2 text-right">Stripe fee</th>
              <th className="px-4 py-2 text-right" title="After Stripe fees, by the payout statement&apos;s rule. On a paid booking: against what the lot was actually paid.">Triply keeps</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {detail.bookings.map((b) => (
              <tr key={b.reservationNumber} className={b.state === "ok" ? "" : "bg-amber-50/40"}>
                <td className="px-4 py-2 font-mono text-xs">
                  {b.reservationNumber}
                  <div className="text-gray-500">{b.status}</div>
                </td>
                <td className="px-4 py-2 text-gray-600">{b.checkOut.slice(0, 10)}</td>
                <td className="px-4 py-2 text-gray-600">{b.lotName}</td>
                <td className="px-4 py-2 text-right font-mono">
                  {cell(b.receivedCents)}
                  {b.refundedCents !== null && b.refundedCents !== 0 && <div className="text-xs text-gray-500">refunded {usdCents(b.refundedCents)}</div>}
                </td>
                <td className="px-4 py-2 text-right font-mono">
                  {cell(b.owedToLotCents)}
                  {b.owedSource && <div className="text-xs text-gray-500">{b.owedSource === "ledger" ? "paid" : "not paid yet"}</div>}
                </td>
                <td className="px-4 py-2 text-right font-mono">{cell(b.stripeFeeCents)}</td>
                <td className="px-4 py-2 text-right font-mono">
                  {cell(b.netCents)}
                  {b.state !== "ok" && (
                    <div className="text-xs font-normal text-amber-800">
                      {STATE_LABEL[b.state]}
                      {b.reason ? `: ${b.reason}` : ""}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot className="border-t-2 border-gray-200 bg-gray-50 font-semibold">
            <tr>
              <td className="px-4 py-2" colSpan={3}>
                Totals
              </td>
              <td className="px-4 py-2 text-right font-mono">
                <DirectCell sum={t.collected} />
                <div className="text-xs font-normal text-gray-500">after refunds</div>
                {t.collected.of < detail.bookings.length && (
                  <div className="text-xs font-normal text-gray-500">
                    not counting {detail.bookings.length - t.collected.of} disputed booking{detail.bookings.length - t.collected.of === 1 ? "" : "s"}
                  </div>
                )}
              </td>
              <td className="px-4 py-2 text-right font-mono">
                <DirectCell sum={t.owedToLots} />
              </td>
              <td className="px-4 py-2 text-right font-mono">
                <DirectCell sum={t.stripeFees} />
              </td>
              <td className="px-4 py-2 text-right font-mono text-navy">
                <DirectCell sum={t.net} />
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
