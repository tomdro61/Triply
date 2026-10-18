"use client";

/**
 * Two column charts, month by month: what customers paid (stacked by
 * product) and what Triply kept (stacked by source, with a tick at the bottom
 * line after Stripe fees). Two charts with their own scales, not one: revenue
 * runs ~6× what we keep, so on a shared axis the Park Guard slice would be
 * invisible. Click a month to select it (the page shows its breakdown); hover
 * or focus for its figures.
 */
import { useState } from "react";
import { formatPrice } from "@/lib/utils";
import { bottomLine, compactMoney, netCommission, niceTicks, type MoneyMix } from "@/lib/admin/revenue-mix";
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
const isMix = (s: MonthState): s is MoneyMix => typeof s === "object" && "paid" in s;

interface Segment {
  value: number;
  color: string;
}

function Panel({
  title,
  note,
  months,
  selectedKey,
  onSelect,
  segmentsOf,
  capOf,
  markerOf,
  tooltipOf,
}: {
  title: string;
  note: string;
  months: ChartMonth[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
  /** Bottom-to-top stack for a month; null = nothing to draw (no figures). */
  segmentsOf: (m: MoneyMix) => Segment[] | null;
  /** The value labelled on the selected column's cap. */
  capOf: (m: MoneyMix) => number | null;
  /** Optional tick across the column (net after Stripe). */
  markerOf?: (m: MoneyMix) => number | null;
  tooltipOf: (m: MoneyMix) => Array<[string, string]>;
}) {
  const [hover, setHover] = useState<string | null>(null);
  const totals = months.map((m) => {
    if (!isMix(m.state)) return 0;
    const segs = segmentsOf(m.state);
    return segs ? segs.reduce((n, s) => n + Math.max(0, s.value), 0) : 0;
  });
  const ticks = niceTicks(Math.max(...totals, 0));
  const top = ticks[ticks.length - 1];
  const px = (v: number) => (Math.max(0, v) / top) * PLOT_H;

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
              style={{ bottom: px(t) }}
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
                style={{ bottom: px(t) }}
              />
            ))}
            <div className="absolute inset-0 flex">
              {months.map((m, i) => {
                const s = m.state;
                const selected = m.key === selectedKey;
                const segs = isMix(s) ? segmentsOf(s) : null;
                const drawn = segs ? segs.filter((g) => g.value > 0) : [];
                const marker = isMix(s) && markerOf ? markerOf(s) : null;
                const cap = isMix(s) ? capOf(s) : null;
                const showTip = hover === m.key && isMix(s);
                const align = i === 0 ? "left-0" : i === months.length - 1 ? "right-0" : "left-1/2 -translate-x-1/2";
                const aria = isMix(s)
                  ? `${m.label}: ${tooltipOf(s).map(([k, v]) => `${k} ${v}`).join(", ")}`
                  : `${m.label}: ${s === "loading" ? "loading" : s === "not-loaded" ? "not loaded — click to load" : "unavailable"}`;
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
                    className={`relative flex-1 flex flex-col justify-end items-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-brand-orange ${
                      selected ? "bg-gray-100/70" : "hover:bg-gray-50"
                    }`}
                  >
                    {/* Cap label: the selected month only (selective labels). */}
                    {selected && cap !== null && (
                      <span
                        className="absolute text-[11px] font-semibold tabular-nums text-gray-900 whitespace-nowrap"
                        style={{ bottom: px(segs ? segs.reduce((n, g) => n + Math.max(0, g.value), 0) : 0) + 6 }}
                      >
                        {compactMoney(cap)}
                      </span>
                    )}
                    {isMix(s) && drawn.length > 0 ? (
                      <div className="relative flex flex-col-reverse gap-[2px] w-6">
                        {drawn.map((g, j) => (
                          <div
                            key={j}
                            style={{ height: Math.max(1, px(g.value)), background: g.color }}
                            className={j === drawn.length - 1 ? "rounded-t" : ""}
                          />
                        ))}
                        {marker !== null && (
                          <div
                            className="absolute -inset-x-1.5 h-0.5 bg-gray-900"
                            style={{ bottom: px(marker) - 1, boxShadow: "0 0 0 2px #fff" }}
                          />
                        )}
                      </div>
                    ) : s === "loading" ? (
                      <div className="w-6 h-10 rounded-t bg-gray-200 animate-pulse" />
                    ) : s === "not-loaded" ? (
                      <div className="w-6 h-10 rounded-t border border-dashed border-gray-300" />
                    ) : (
                      <div className="w-6 h-1" />
                    )}
                    {showTip && isMix(s) && (
                      <div
                        className={`absolute bottom-full mb-2 z-10 w-56 rounded-lg border border-gray-200 bg-white p-3 text-left shadow-lg pointer-events-none ${align}`}
                      >
                        <p className="text-xs font-semibold text-gray-900 mb-1.5">{m.label}</p>
                        {tooltipOf(s).map(([k, v]) => (
                          <div key={k} className="flex justify-between gap-3 text-xs">
                            <span className="text-gray-500">{k}</span>
                            <span className="tabular-nums font-medium text-gray-900">{v}</span>
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

function Key({ color, label, line }: { color: string; label: string; line?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-gray-600">
      {line ? (
        <span className="inline-block h-0.5 w-3.5 bg-gray-900" />
      ) : (
        <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: color }} />
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
        <Key color="" label="Profit after Stripe fees" line />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
        <Panel
          title="Revenue"
          note="What customers paid"
          months={months}
          selectedKey={selectedKey}
          onSelect={onSelect}
          segmentsOf={(m) => [
            { value: m.paid.parking, color: SERIES.parking.color },
            { value: m.paid.serviceFee, color: SERIES.serviceFee.color },
            { value: m.paid.parkGuard, color: SERIES.parkGuard.color },
          ]}
          capOf={(m) => m.paid.total}
          tooltipOf={(m) => [
            ["Revenue", formatPrice(m.paid.total)],
            ["Parking", formatPrice(m.paid.parking)],
            ["Service fees", formatPrice(m.paid.serviceFee)],
            ["Park Guard", formatPrice(m.paid.parkGuard)],
          ]}
        />
        <Panel
          title="What we kept"
          note="Commission, service fees and Park Guard margin; the tick is profit after Stripe fees"
          months={months}
          selectedKey={selectedKey}
          onSelect={onSelect}
          segmentsOf={(m) =>
            m.kept
              ? [
                  { value: netCommission(m.kept), color: SERIES.commission.color },
                  { value: m.kept.serviceFee, color: SERIES.serviceFee.color },
                  { value: m.kept.pgMargin, color: SERIES.parkGuard.color },
                ]
              : null
          }
          capOf={(m) => (m.kept ? bottomLine(m.kept) : null)}
          markerOf={(m) => m.kept?.net ?? null}
          tooltipOf={(m) =>
            m.kept
              ? [
                  ["Profit", m.kept.net !== null ? formatPrice(m.kept.net) : "—"],
                  ["Parking commission", formatPrice(netCommission(m.kept))],
                  ["Service fees", formatPrice(m.kept.serviceFee)],
                  ["Park Guard margin", formatPrice(m.kept.pgMargin)],
                  ["Stripe fees", m.kept.stripeFees !== null ? `−${formatPrice(m.kept.stripeFees)}` : "—"],
                ]
              : [["Profit", `unavailable — ${m.keptReason ?? "no total"}`]]
          }
        />
      </div>
    </div>
  );
}
