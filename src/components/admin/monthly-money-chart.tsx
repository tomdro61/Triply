"use client";

/**
 * Two column charts, month by month: what customers paid (stacked by
 * product) and what Triply kept (stacked by source, with a tick at profit
 * after Stripe fees). Two charts with their own scales, not one: revenue
 * runs ~6× what we keep, so on a shared axis the Park Guard slice would be
 * invisible. A negative slice (e.g. Park Guard margin after full refunds)
 * draws below the zero line. Click a month to select it (the page shows its
 * breakdown); hover or focus for its figures.
 */
import { useState } from "react";
import { formatPrice } from "@/lib/utils";
import {
  axisTicks,
  bottomLine,
  compactMoney,
  formatNegative,
  keptSlices,
  stackExtent,
  type MoneyMix,
} from "@/lib/admin/revenue-mix";
import { SERIES } from "./money-breakdown";

export type MonthState = MoneyMix | "loading" | "not-loaded" | { error: string };

export interface ChartMonth {
  key: string;
  /** "Sep" or "Oct*" */
  short: string;
  /** "Sep 2026" */
  label: string;
  state: MonthState;
}

const PLOT_H = 168;
const GAP = 2; // surface gap between stacked segments
const isMix = (s: MonthState): s is MoneyMix => typeof s === "object" && "paid" in s;
const money = (n: number) => (n < 0 ? formatNegative(-n) : formatPrice(n));

interface Segment {
  value: number;
  color: string;
}
/** What a panel draws for one loaded month: a stack, or why it can't. */
type Column =
  | { segments: Segment[]; marker: number | null; tooltip: Array<[string, string]> }
  | { unavailable: string };

function Panel({
  title,
  note,
  months,
  selectedKey,
  onSelect,
  columnOf,
}: {
  title: string;
  note: string;
  months: ChartMonth[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
  columnOf: (m: MoneyMix) => Column;
}) {
  const [hover, setHover] = useState<string | null>(null);
  const cols = months.map((m): Column | null =>
    isMix(m.state) ? columnOf(m.state) : typeof m.state === "object" ? { unavailable: m.state.error } : null
  );
  let lo = 0;
  let hi = 0;
  for (const c of cols) {
    if (!c || "unavailable" in c) continue;
    const { up, down } = stackExtent(c.segments.map((s) => s.value));
    hi = Math.max(hi, up, c.marker ?? 0);
    lo = Math.min(lo, down, c.marker ?? 0);
  }
  const ticks = axisTicks(lo, hi);
  const tLo = ticks[0];
  const tHi = ticks[ticks.length - 1];
  const y = (v: number) => ((v - tLo) / (tHi - tLo)) * PLOT_H; // px from the plot's bottom
  const zero = y(0);

  return (
    <div>
      <h3 className="font-semibold text-gray-900">{title}</h3>
      <p className="text-xs text-gray-500 mb-4">{note}</p>
      <div className="flex pt-6">
        {/* Y axis */}
        <div className="relative w-11 flex-shrink-0" style={{ height: PLOT_H }}>
          {ticks.map((t) => (
            <span
              key={t}
              className="absolute right-2 text-[11px] leading-none tabular-nums text-gray-400 translate-y-1/2"
              style={{ bottom: y(t) }}
            >
              {compactMoney(t)}
            </span>
          ))}
        </div>
        {/* Plot */}
        <div className="relative flex-1 min-w-0">
          <div className="relative" style={{ height: PLOT_H }}>
            {ticks.map((t) => (
              <div
                key={t}
                className={`absolute inset-x-0 h-px ${t === 0 ? "bg-gray-300" : "bg-gray-100"}`}
                style={{ bottom: y(t) }}
              />
            ))}
            <div className="absolute inset-0 flex">
              {months.map((m, i) => {
                const col = cols[i];
                const selected = m.key === selectedKey;
                const align = i === 0 ? "left-0" : i === months.length - 1 ? "right-0" : "left-1/2 -translate-x-1/2";

                // Signed stack: positives up from zero, negatives down, in order.
                const bars: Array<{ bottom: number; height: number; color: string; round: "t" | "b" | null }> = [];
                let capY: number | null = null;
                let capValue: number | null = null;
                let markerY: number | null = null;
                if (col && !("unavailable" in col)) {
                  const ups = col.segments.filter((s) => s.value > 0);
                  const downs = col.segments.filter((s) => s.value < 0);
                  let acc = 0;
                  ups.forEach((s, j) => {
                    const b = y(acc);
                    acc += s.value;
                    const lift = j > 0 ? GAP : 0;
                    bars.push({
                      bottom: b + lift,
                      height: Math.max(1, y(acc) - b - lift),
                      color: s.color,
                      round: j === ups.length - 1 ? "t" : null,
                    });
                  });
                  const upTop = y(acc);
                  let dacc = 0;
                  downs.forEach((s, j) => {
                    const t = y(dacc);
                    dacc += s.value;
                    const b = y(dacc);
                    const drop = j > 0 ? GAP : 0;
                    bars.push({
                      bottom: b,
                      height: Math.max(1, t - b - drop),
                      color: s.color,
                      round: j === downs.length - 1 ? "b" : null,
                    });
                  });
                  capValue = col.segments.reduce((n, s) => n + s.value, 0);
                  capY = ups.length > 0 ? upTop + 6 : null;
                  markerY = col.marker !== null ? y(col.marker) : null;
                }

                const tooltip: Array<[string, string]> | null = !col
                  ? null
                  : "unavailable" in col
                    ? [["Unavailable", col.unavailable]]
                    : col.tooltip;
                const aria = tooltip
                  ? `${m.label}: ${tooltip.map(([k, v]) => `${k} ${v}`).join(", ")}`
                  : `${m.label}: ${m.state === "loading" ? "loading" : "not loaded — click to load"}`;

                return (
                  <button
                    key={m.key}
                    type="button"
                    onClick={() => onSelect(m.key)}
                    onMouseEnter={() => setHover(m.key)}
                    onMouseLeave={() => setHover((h) => (h === m.key ? null : h))}
                    onFocus={() => setHover(m.key)}
                    onBlur={() => setHover((h) => (h === m.key ? null : h))}
                    aria-label={aria}
                    aria-pressed={selected}
                    className={`relative flex-1 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-brand-orange ${
                      selected ? "bg-gray-100/70" : "hover:bg-gray-50"
                    }`}
                  >
                    <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-6">
                      {bars.map((b, j) => (
                        <div
                          key={j}
                          className={`absolute inset-x-0 ${b.round === "t" ? "rounded-t" : b.round === "b" ? "rounded-b" : ""}`}
                          style={{ bottom: b.bottom, height: b.height, background: b.color }}
                        />
                      ))}
                      {markerY !== null && (
                        <div
                          className="absolute -inset-x-1.5 h-0.5 bg-gray-900"
                          style={{ bottom: markerY - 1, boxShadow: "0 0 0 2px #fff" }}
                        />
                      )}
                      {m.state === "loading" && (
                        <div className="absolute inset-x-0 h-10 rounded-t bg-gray-200 animate-pulse" style={{ bottom: zero }} />
                      )}
                      {m.state === "not-loaded" && (
                        <div className="absolute inset-x-0 h-10 rounded-t border border-dashed border-gray-300" style={{ bottom: zero }} />
                      )}
                      {col && "unavailable" in col && (
                        <span
                          className="absolute left-1/2 -translate-x-1/2 flex h-5 w-5 items-center justify-center rounded-full bg-amber-100 text-[11px] font-bold text-amber-800"
                          style={{ bottom: zero + 4 }}
                        >
                          !
                        </span>
                      )}
                    </div>
                    {/* Cap label: the selected month only (selective labels). */}
                    {selected && capY !== null && capValue !== null && (
                      <span
                        className="absolute left-1/2 -translate-x-1/2 text-[11px] font-semibold tabular-nums text-gray-900 whitespace-nowrap"
                        style={{ bottom: capY }}
                      >
                        {compactMoney(capValue)}
                      </span>
                    )}
                    {hover === m.key && tooltip && (
                      <div
                        className={`absolute bottom-full mb-2 z-10 w-60 rounded-lg border border-gray-200 bg-white p-3 text-left shadow-lg pointer-events-none ${align}`}
                      >
                        <p className="text-xs font-semibold text-gray-900 mb-1.5">{m.label}</p>
                        {tooltip.map(([k, v]) => (
                          <div key={k} className="flex justify-between gap-3 text-xs">
                            <span className="text-gray-500 flex-shrink-0">{k}</span>
                            <span className="tabular-nums font-medium text-gray-900 text-right">{v}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
          {/* X axis */}
          <div className="flex mt-1.5">
            {months.map((m) => (
              <span
                key={m.key}
                className={`flex-1 text-center text-xs ${m.key === selectedKey ? "font-semibold text-gray-900" : "text-gray-500"}`}
              >
                {m.short}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function Key({ color, label }: { color?: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-gray-600">
      {color ? (
        <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: color }} />
      ) : (
        <span className="inline-block h-0.5 w-3.5 bg-gray-900" />
      )}
      {label}
    </span>
  );
}

export function MonthlyMoneyChart({
  months,
  selectedKey,
  onSelect,
}: {
  months: ChartMonth[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
}) {
  return (
    <div>
      <div className="flex flex-wrap gap-x-4 gap-y-1.5 mb-5">
        <Key color={SERIES.parking.color} label={SERIES.parking.label} />
        <Key color={SERIES.commission.color} label={SERIES.commission.label} />
        <Key color={SERIES.serviceFee.color} label={SERIES.serviceFee.label} />
        <Key color={SERIES.parkGuard.color} label={SERIES.parkGuard.label} />
        <Key label="Profit after Stripe fees" />
        <span className="inline-flex items-center gap-1.5 text-xs text-gray-600">
          <span className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-amber-100 text-[9px] font-bold text-amber-800">
            !
          </span>
          Unavailable — hover for why
        </span>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
        <Panel
          title="Revenue"
          note="What customers paid"
          months={months}
          selectedKey={selectedKey}
          onSelect={onSelect}
          columnOf={(m) => ({
            segments: [
              { value: m.paid.parking, color: SERIES.parking.color },
              { value: m.paid.serviceFee, color: SERIES.serviceFee.color },
              { value: m.paid.parkGuard, color: SERIES.parkGuard.color },
            ],
            marker: null,
            tooltip: [
              ["Revenue", formatPrice(m.paid.total)],
              ["Parking", formatPrice(m.paid.parking)],
              ["Service fees", formatPrice(m.paid.serviceFee)],
              ["Park Guard", formatPrice(m.paid.parkGuard)],
            ],
          })}
        />
        <Panel
          title="What we kept"
          note="Bar = commission + service fees + Park Guard margin; tick = profit after Stripe fees"
          months={months}
          selectedKey={selectedKey}
          onSelect={onSelect}
          columnOf={(m) => {
            if (!m.kept) return { unavailable: m.keptReason };
            const s = keptSlices(m.kept);
            const rows: Array<[string, string]> = [
              [m.kept.net !== null ? "Profit" : "Kept (before Stripe)", money(bottomLine(m.kept))],
              ["Parking commission", money(s.commission)],
              ["Service fees", money(s.serviceFee)],
              ["Park Guard margin", money(s.pgMargin)],
              ["Stripe fees", m.kept.stripeFees !== null ? formatNegative(m.kept.stripeFees) : "unknown"],
            ];
            if (m.pgWholesaleMissing > 0) rows.push(["Overstated", `${m.pgWholesaleMissing} PG row(s) lack wholesale`]);
            return {
              segments: [
                { value: s.commission, color: SERIES.commission.color },
                { value: s.serviceFee, color: SERIES.serviceFee.color },
                { value: s.pgMargin, color: SERIES.parkGuard.color },
              ],
              marker: m.kept.net,
              tooltip: rows,
            };
          }}
        />
      </div>
    </div>
  );
}
