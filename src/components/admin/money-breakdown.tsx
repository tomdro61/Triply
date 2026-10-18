/**
 * "Where the money came from / What we kept" — the admin revenue breakdown
 * for one period. Left: what customers paid, by product. Right: what Triply
 * kept, by source, down to the bottom line after Stripe fees. Shared by the
 * dashboard (this month so far) and /admin/numbers (the selected month).
 *
 * Series colours are fixed per ENTITY and shared with MonthlyMoneyChart, so a
 * colour means the same thing on both pages (validated: dataviz palette,
 * adjacent CVD ΔE ≥ 9). Parking is a de-emphasis grey on purpose — most of it
 * passes through to the lot.
 */
import { Loader2, AlertTriangle } from "lucide-react";
import { formatPrice } from "@/lib/utils";
import {
  bottomLine,
  netCommission,
  share,
  type KeptMix,
  type PaidMix,
} from "@/lib/admin/revenue-mix";

export const SERIES = {
  parking: { color: "#7f8ea3", label: "Parking" },
  commission: { color: "#2a78d6", label: "Parking commission" },
  serviceFee: { color: "#eb6834", label: "Service fees" },
  parkGuard: { color: "#1baf7a", label: "Park Guard" },
} as const;

export type KeptState = KeptMix | "loading" | { unavailable: string };

const pctText = (r: number | null) => (r === null ? "—" : `${(r * 100).toFixed(1)}%`);

function Row({
  label,
  amount,
  ratio,
  color,
  note,
}: {
  label: string;
  amount: number;
  /** Share of the column's total, drives the bar; null = no bar. */
  ratio: number | null;
  color: string;
  note?: string;
}) {
  return (
    <div className="mb-3">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="flex items-center gap-2 text-gray-800">
          <span className="inline-block h-2.5 w-2.5 rounded-sm flex-shrink-0" style={{ background: color }} />
          {label}
        </span>
        <span className="flex items-baseline gap-3">
          <span className="font-semibold tabular-nums text-gray-900">{formatPrice(amount)}</span>
          <span className="w-12 text-right text-xs tabular-nums text-gray-500">{pctText(ratio)}</span>
        </span>
      </div>
      <div className="mt-1.5 h-2 rounded-full bg-gray-100 overflow-hidden">
        <div
          className="h-full rounded-full"
          style={{ width: `${Math.max(0, Math.min(1, ratio ?? 0)) * 100}%`, background: color }}
        />
      </div>
      {note && <p className="mt-1 text-xs text-gray-500">{note}</p>}
    </div>
  );
}

function Line({ label, amount, note, muted }: { label: string; amount: string; note?: string; muted?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <span className={muted ? "text-gray-500" : "text-gray-700"}>
        {label}
        {note && <span className="block text-xs text-gray-400">{note}</span>}
      </span>
      <span className={`tabular-nums ${muted ? "text-gray-500" : "font-medium text-gray-900"}`}>{amount}</span>
    </div>
  );
}

const minus = (n: number) => `−${formatPrice(n)}`;

function Headline({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <p className="text-xs font-medium text-gray-500">{label}</p>
      <p className="text-xl font-bold text-gray-900 mt-0.5">{value}</p>
      {sub && <p className="text-xs text-gray-500 mt-0.5">{sub}</p>}
    </div>
  );
}

export function MoneyBreakdown({
  paid,
  kept,
  directConfirmed = 0,
}: {
  /** null when the paid figures failed to load. */
  paid: PaidMix | null;
  kept: KeptState;
  /** Direct-lot bookings, which the profit figures leave out (reconciler scope). */
  directConfirmed?: number;
}) {
  const keptMix = typeof kept === "object" && !("unavailable" in kept) ? kept : null;
  const profit = keptMix ? bottomLine(keptMix) : null;
  const profitLabel = keptMix && keptMix.net === null ? "Kept (before Stripe fees)" : "Profit";

  // Bars on the right are shares of what we kept BEFORE Stripe: the three
  // sources add up to that total, so the bars add up to 100%.
  const keptBase = keptMix ? Math.max(0, netCommission(keptMix)) + Math.max(0, keptMix.serviceFee) + Math.max(0, keptMix.pgMargin) : 0;

  return (
    <div>
      {/* The four numbers asked for, side by side. */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 pb-5 mb-5 border-b border-gray-200">
        <Headline
          label="Revenue"
          value={paid ? formatPrice(paid.total) : "—"}
          sub={paid?.bookings != null ? `${paid.bookings} confirmed booking${paid.bookings === 1 ? "" : "s"}` : undefined}
        />
        <Headline
          label={profitLabel}
          value={profit !== null ? formatPrice(profit) : kept === "loading" ? "…" : "—"}
          sub={
            profit !== null && paid
              ? `${pctText(share(profit, paid.total))} of revenue${paid.bookings ? ` · ${formatPrice(profit / paid.bookings)}/booking` : ""}`
              : kept === "loading"
                ? "loading from ResLab + Stripe"
                : undefined
          }
        />
        <Headline label="Service fees" value={paid ? formatPrice(paid.serviceFee) : "—"} sub="all ours" />
        <Headline
          label="Park Guard margin"
          value={keptMix ? formatPrice(keptMix.pgMargin) : kept === "loading" ? "…" : "—"}
          sub={paid ? `${formatPrice(paid.parkGuard)} in premiums` : undefined}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-10 gap-y-8">
        {/* --- What customers paid --- */}
        <section>
          <h3 className="font-semibold text-gray-900">Where the money came from</h3>
          <p className="text-xs text-gray-500 mb-4">What customers paid, confirmed bookings</p>
          {paid ? (
            <>
              <Row
                label={SERIES.parking.label}
                amount={paid.parking}
                ratio={share(paid.parking, paid.total)}
                color={SERIES.parking.color}
                note="mostly the lot's money — we earn a commission on it"
              />
              <Row
                label={SERIES.serviceFee.label}
                amount={paid.serviceFee}
                ratio={share(paid.serviceFee, paid.total)}
                color={SERIES.serviceFee.color}
                note="ours — never shared with a lot"
              />
              <Row
                label={SERIES.parkGuard.label}
                amount={paid.parkGuard}
                ratio={share(paid.parkGuard, paid.total)}
                color={SERIES.parkGuard.color}
                note={
                  paid.pgOptIns !== null && paid.bookings
                    ? `${paid.pgOptIns} of ${paid.bookings} bookings protected · ${pctText(share(paid.pgOptIns, paid.bookings))} attach`
                    : "premiums, before Park Guard's wholesale"
                }
              />
              <div className="mt-3 pt-3 border-t-2 border-gray-300">
                <Line label="Revenue" amount={formatPrice(paid.total)} />
              </div>
            </>
          ) : (
            <p className="text-sm text-amber-700 flex items-center gap-1.5">
              <AlertTriangle size={14} /> Revenue figures unavailable.
            </p>
          )}
        </section>

        {/* --- What we kept --- */}
        <section>
          <h3 className="font-semibold text-gray-900">What we kept</h3>
          <p className="text-xs text-gray-500 mb-4">Our share, after the lots, ResLab, Park Guard and Stripe</p>
          {kept === "loading" ? (
            <div className="flex items-center gap-2 text-sm text-gray-500 py-6">
              <Loader2 className="h-4 w-4 animate-spin text-brand-orange" />
              Working out the commission from ResLab and Stripe — can take ~30 seconds.
            </div>
          ) : !keptMix ? (
            <p className="text-sm text-amber-700 flex items-start gap-1.5">
              <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
              <span>
                Profit unavailable{typeof kept === "object" && "unavailable" in kept ? ` — ${kept.unavailable}` : ""}.
              </span>
            </p>
          ) : (
            <>
              <Row
                label={SERIES.commission.label}
                amount={netCommission(keptMix)}
                ratio={share(Math.max(0, netCommission(keptMix)), keptBase)}
                color={SERIES.commission.color}
                note={`${formatPrice(keptMix.parkingCommission)} commission less ResLab's ${formatPrice(keptMix.reslabFee)} channel fee`}
              />
              <Row
                label={SERIES.serviceFee.label}
                amount={keptMix.serviceFee}
                ratio={share(Math.max(0, keptMix.serviceFee), keptBase)}
                color={SERIES.serviceFee.color}
                note={
                  paid && keptMix.serviceFee - paid.serviceFee > 0.005
                    ? `kept in full, incl. ${formatPrice(keptMix.serviceFee - paid.serviceFee)} kept on refunded bookings`
                    : "kept in full"
                }
              />
              <Row
                label={`${SERIES.parkGuard.label} margin`}
                amount={keptMix.pgMargin}
                ratio={share(Math.max(0, keptMix.pgMargin), keptBase)}
                color={SERIES.parkGuard.color}
                note="premiums less Park Guard's wholesale"
              />
              <div className="mt-3 pt-3 border-t border-gray-200 space-y-1.5">
                <Line label="Kept before Stripe fees" amount={formatPrice(keptMix.total)} />
                <Line
                  label="Less Stripe processing fees"
                  amount={keptMix.stripeFees !== null ? minus(keptMix.stripeFees) : "—"}
                  note={keptMix.stripeFees === null ? "Stripe fee data incomplete for this period" : undefined}
                  muted
                />
              </div>
              <div className="mt-3 pt-3 border-t-2 border-gray-300 flex items-baseline justify-between">
                <span className="text-sm font-semibold text-gray-900">{profitLabel}</span>
                <span className="text-sm font-bold tabular-nums text-gray-900">{formatPrice(bottomLine(keptMix))}</span>
              </div>
            </>
          )}
          {directConfirmed > 0 && (
            <p className="mt-3 text-xs text-gray-500">
              {directConfirmed} direct-lot booking{directConfirmed === 1 ? "" : "s"} not in profit yet (payouts are
              tracked on Accounting).
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
