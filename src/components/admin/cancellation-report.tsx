"use client";

import type { CancellationReport } from "@/lib/cancellation/report";
import { CANCELLATION_REASONS, CANCELLATION_REASON_LABELS } from "@/lib/cancellation/reason-codes";

const pct = (r: number) => `${(r * 100).toFixed(1)}%`;

const BY_LABELS: Record<string, string> = {
  customer: "Customer (self-cancel)",
  admin: "Admin",
  system: "System (refund outside the app)",
  unknown: "Not recorded (before migration 032)",
};

/**
 * Admin dashboard section: cancelled count + rate by booking month, broken down
 * by reason, by who cancelled, and by lot. Data comes pre-aggregated from
 * /api/admin/stats (src/lib/cancellation/report.ts); respects the page's date filter.
 */
export function CancellationReportPanel({
  report,
  error,
}: {
  report: CancellationReport | null;
  error: string | null;
}) {
  if (!report) {
    return (
      <div className="mb-8 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
        Cancellation report unavailable{error ? ` (${error})` : ""} — check Sentry. If migration
        032 has not been applied yet, apply it.
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6 mb-8">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-4">
        <h3 className="font-semibold text-gray-900">Cancellations</h3>
        <p className="text-sm text-gray-600">
          {report.totals.cancelled} of {report.totals.bookings} bookings ·{" "}
          <span className="font-semibold text-gray-900">{pct(report.totals.rate)}</span>
        </p>
      </div>

      {report.totals.cancelled === 0 ? (
        <p className="text-sm text-gray-500">No cancellations in range</p>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 overflow-x-auto">
            <h4 className="text-xs font-semibold uppercase text-gray-500 mb-2">By booking month</h4>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-500 uppercase">
                  <th className="pb-2">Month</th>
                  <th className="pb-2 text-right">Bookings</th>
                  <th className="pb-2 text-right">Cancelled</th>
                  <th className="pb-2 text-right">Rate</th>
                  <th className="pb-2 pl-4">Reasons</th>
                </tr>
              </thead>
              <tbody>
                {report.byMonth.map((m) => (
                  <tr key={m.month} className="border-t border-gray-100 align-top">
                    <td className="py-1.5 font-mono text-gray-700">{m.month}</td>
                    <td className="py-1.5 text-right">{m.bookings}</td>
                    <td className="py-1.5 text-right">{m.cancelled}</td>
                    <td className="py-1.5 text-right">{pct(m.rate)}</td>
                    <td className="py-1.5 pl-4 text-xs text-gray-600">
                      {CANCELLATION_REASONS.filter((r) => m.byReason[r] > 0)
                        .sort((a, b) => m.byReason[b] - m.byReason[a])
                        .map((r) => `${CANCELLATION_REASON_LABELS[r]} ${m.byReason[r]}`)
                        .join(" · ") || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="space-y-6">
            <div>
              <h4 className="text-xs font-semibold uppercase text-gray-500 mb-2">By reason</h4>
              <table className="w-full text-sm">
                <tbody>
                  {report.byReason.map((r) => (
                    <tr key={r.reason} className="border-t border-gray-100">
                      <td className="py-1.5 text-gray-700">{CANCELLATION_REASON_LABELS[r.reason]}</td>
                      <td className="py-1.5 text-right">{r.count}</td>
                      <td className="py-1.5 text-right text-gray-500">
                        {pct(r.count / report.totals.cancelled)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div>
              <h4 className="text-xs font-semibold uppercase text-gray-500 mb-2">Cancelled by</h4>
              <table className="w-full text-sm">
                <tbody>
                  {report.byCancelledBy.map((r) => (
                    <tr key={r.by} className="border-t border-gray-100">
                      <td className="py-1.5 text-gray-700">{BY_LABELS[r.by] ?? r.by}</td>
                      <td className="py-1.5 text-right">{r.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="lg:col-span-3 overflow-x-auto">
            <h4 className="text-xs font-semibold uppercase text-gray-500 mb-2">
              By lot (most cancellations first)
            </h4>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-500 uppercase">
                  <th className="pb-2">Lot</th>
                  <th className="pb-2 text-right">Bookings</th>
                  <th className="pb-2 text-right">Cancelled</th>
                  <th className="pb-2 text-right">Rate</th>
                  <th
                    className="pb-2 text-right"
                    title="Cancellations recorded as 'Lot turned customer away' or 'Lot sold out / overbooked'"
                  >
                    Lot turned away
                  </th>
                </tr>
              </thead>
              <tbody>
                {report.byLot.map((l) => (
                  <tr key={l.lot} className="border-t border-gray-100">
                    <td className="py-1.5 text-gray-700">{l.lot}</td>
                    <td className="py-1.5 text-right">{l.bookings}</td>
                    <td className="py-1.5 text-right">{l.cancelled}</td>
                    <td className="py-1.5 text-right">{pct(l.rate)}</td>
                    <td className={`py-1.5 text-right ${l.lotFault > 0 ? "text-red-600 font-medium" : "text-gray-400"}`}>
                      {l.lotFault}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <p className="mt-3 text-xs text-gray-400">
        Cancelled = status cancelled or refunded. Months are the month the booking was made. &quot;Unknown&quot;
        covers every cancellation before reasons were recorded, and customers who skipped the question.
      </p>
    </div>
  );
}
