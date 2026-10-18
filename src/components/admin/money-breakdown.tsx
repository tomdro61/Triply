/**
 * "Where the money came from / What we kept" — the admin revenue breakdown
 * for one period. Left: what customers paid, by product. Right: what Triply
 * kept, by source, down to the bottom line after Stripe fees. Shared by the
 * dashboard (this month so far) and /admin/numbers (the selected month).
 *
 * Series colours are fixed per ENTITY and shared with MonthlyMoneyChart, so a
 * colour means the same thing on both pages. The three coloured slots are
 * the dataviz reference palette's first three (validator: adjacent CVD
 * ΔE ≥ 9.2, normal-vision ≥ 27). Parking is a de-emphasis grey on purpose —
 * most of it passes through to the lot.
 */
import { Loader2, AlertTriangle } from "lucide-react";
import { formatPrice } from "@/lib/utils";
import {
  bottomLine,
  formatNegative,
  keptSlices,
  share,
  type KeptState,
  type PaidMix,
} from "@/lib/admin/revenue-mix";

export const SERIES = {
  parking: { color: "#7f8ea3", label: "Parking" },
  commission: { color: "#2a78d6", label: "Parking commission" },
  serviceFee: { color: "#eb6834", label: "Service fees" },
  parkGuard: { color: "#1baf7a", label: "Park Guard" },
} as const;

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
  /** Share of the column's total; drives the bar. A negative share shows its figure but no bar. */
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
          <span className="font-semibold tabular-nums text-gray-900">
            {amount < 0 ? formatNegative(-amount) : formatPrice(amount)}
          </span>
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

const money = (n: number) => (n < 0 ? formatNegative(-n) : formatPrice(n));

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
  directConfirmed,
  pgWholesaleMissing,
  paidNote,
}: {
  /** null when the paid figures failed to load. */
  paid: PaidMix | null;
  kept: KeptState;
  /**
   * Direct-lot bookings left out of these figures (reconciler scope); null
   * while unknown. Pass `paid` from the reconciler whenever `kept` has
   * figures, so both sides — and every ratio — cover the same bookings.
   */
  directConfirmed: number | null;
  /** PG opt-ins whose missing wholesale overstates margin and profit (accounting's warning). */
  pgWholesaleMissing: number;
  /** Where the revenue figures came from, when it isn't the reconciler. */
  paidNote?: string;
}) {
  const keptMix = typeof kept === "object" && !("unavailable" in kept) ? kept : null;
  const profit = keptMix ? bottomLine(keptMix) : null;
  const profitLabel = keptMix && keptMix.net === null ? "Kept (before Stripe fees)" : "Profit";
  const slices = keptMix ? keptSlices(keptMix) : null;
  // Fee kept on refunded bookings: reconciler service fee (confirmed + kept
  // on refunds) less confirmed-only — same booking set on both sides.
  const refundFeeKept = keptMix && paid ? keptMix.serviceFee - paid.serviceFee : 0;

  return (
    <div>
      {/* The four numbers asked for, side by side. */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 pb-5 mb-5 border-b border-gray-200">
        <Headline
          label="Revenue"
          value={paid ? formatPrice(paid.total) : "—"}
          sub={paid ? `${paid.bookings} confirmed booking${paid.bookings === 1 ? "" : "s"}` : undefined}
        />
        <Headline
          label={profitLabel}
          value={profit !== null ? money(profit) : kept === "loading" ? "…" : "—"}
          sub={
            profit !== null && paid
              ? `${pctText(share(profit, paid.total))} of revenue${paid.bookings > 0 ? ` · ${money(profit / paid.bookings)}/booking` : ""}`
              : kept === "loading"
                ? "loading from ResLab + Stripe"
                : "unavailable — see below"
          }
        />
        {/* Accounting's service-fee figure (incl. fees kept on refunds) once known. */}
        <Headline
          label="Service fees"
          value={keptMix ? formatPrice(keptMix.serviceFee) : paid ? formatPrice(paid.serviceFee) : "—"}
          sub={
            keptMix
              ? refundFeeKept > 0.005
                ? `incl. ${formatPrice(refundFeeKept)} kept on refunds`
                : "all ours"
              : paid
                ? "confirmed bookings"
                : undefined
          }
        />
        <Headline
          label="Park Guard margin"
          value={keptMix ? money(keptMix.pgMargin) : kept === "loading" ? "…" : "—"}
          sub={paid ? `${formatPrice(paid.parkGuard)} in premiums` : undefined}
        />
      </div>

      {pgWholesaleMissing > 0 && (
        <p className="mb-5 text-sm text-amber-700 flex items-start gap-1.5">
          <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
          <span>
            {pgWholesaleMissing} Park Guard booking{pgWholesaleMissing === 1 ? " has" : "s have"} no wholesale cost
            recorded, so Park Guard margin and profit are overstated until repaired (see Accounting).
          </span>
        </p>
      )}

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
                note={`${paid.pgOptIns} of ${paid.bookings} bookings protected · ${pctText(share(paid.pgOptIns, paid.bookings))} attach`}
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
          ) : !keptMix || !slices ? (
            <p className="text-sm text-amber-700 flex items-start gap-1.5">
              <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
              <span>Profit unavailable{"unavailable" in kept ? ` — ${kept.unavailable}` : ""}.</span>
            </p>
          ) : (
            <>
              {/* Shares are of "Kept before Stripe fees" below, so a negative slice shows as one. */}
              <Row
                label={SERIES.commission.label}
                amount={slices.commission}
                ratio={share(slices.commission, keptMix.total)}
                color={SERIES.commission.color}
                note={`${formatPrice(keptMix.parkingCommission)} commission less ResLab's ${formatPrice(keptMix.reslabFee)} channel fee`}
              />
              <Row
                label={SERIES.serviceFee.label}
                amount={slices.serviceFee}
                ratio={share(slices.serviceFee, keptMix.total)}
                color={SERIES.serviceFee.color}
                note={
                  refundFeeKept > 0.005
                    ? `kept in full, incl. ${formatPrice(refundFeeKept)} kept on refunded bookings`
                    : "kept in full"
                }
              />
              <Row
                label={`${SERIES.parkGuard.label} margin`}
                amount={slices.pgMargin}
                ratio={share(slices.pgMargin, keptMix.total)}
                color={SERIES.parkGuard.color}
                note="premiums less Park Guard's wholesale, refunded opt-ins included"
              />
              <div className="mt-3 pt-3 border-t border-gray-200 space-y-1.5">
                <Line label="Kept before Stripe fees" amount={money(keptMix.total)} />
                <Line
                  label="Less Stripe processing fees"
                  amount={keptMix.stripeFees !== null ? formatNegative(keptMix.stripeFees) : "—"}
                  note={keptMix.stripeFees === null ? "Stripe fee data incomplete for this period" : undefined}
                  muted
                />
              </div>
              <div className="mt-3 pt-3 border-t-2 border-gray-300 flex items-baseline justify-between">
                <span className="text-sm font-semibold text-gray-900">{profitLabel}</span>
                <span className="text-sm font-bold tabular-nums text-gray-900">{money(bottomLine(keptMix))}</span>
              </div>
            </>
          )}
        </section>
      </div>

      {paidNote && <p className="mt-5 text-xs text-gray-500">{paidNote}</p>}
      {directConfirmed !== null && directConfirmed > 0 && (
        <p className="mt-5 text-xs text-gray-500">
          {directConfirmed} direct-lot booking{directConfirmed === 1 ? " is" : "s are"} not in these figures yet —
          their payouts are tracked on Accounting.
        </p>
      )}
    </div>
  );
}
