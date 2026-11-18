/**
 * Which currency a ResLab booking's SETTLEMENT figures are in, for accounting.
 *
 * A booking at a Canadian lot is charged in US dollars and its row holds US
 * dollars, but ResLab keeps the reservation in Canadian dollars: its history
 * (`location_total`, `channel_total`, the fee lines, `grand_total` …) is CAD.
 * ResLab invoices Triply in US dollars, converting what is owed at its own
 * rate on the invoice date (ResLab, Nov 17 2026).
 *
 * Two witnesses decide: the booking row (`reslab_currency`, `fx_rate`,
 * migration 052) and the currency ResLab reports on the reservation. Pure:
 * no I/O, never throws.
 */
import { rateFromColumn, rateToColumn, type FxRate } from "@/lib/fx/cad-usd";

/**
 * Converted bookings can only exist from here on (#204 merged Nov 17 2026).
 * A Canadian reservation booked BEFORE it was charged the Canadian figure
 * one-for-one in US dollars: a known set of old bookings, with no rate.
 */
export const CONVERSION_LIVE_FROM = "2026-11-17T00:00:00Z";

export type RowCurrency =
  /** A US-dollar lot: every figure is used exactly as it always was. */
  | { kind: "usd" }
  /** Converted at checkout: ResLab's figures are CAD, converted here at the booking's own rate. */
  | { kind: "cad"; rate: FxRate; rateText: string }
  /**
   * ResLab's figures are CAD and there is no rate to convert them with.
   * `legacy`: one of the old one-for-one bookings (expected, reported apart).
   * Otherwise a data fault, which must hold the month's headline back.
   */
  | { kind: "cad_no_rate"; legacy: boolean; reason: string }
  /** The row and ResLab disagree, or ResLab reports a third currency. Always a fault. */
  | { kind: "conflict"; reason: string };

export const USD_ROW: RowCurrency = { kind: "usd" };

export interface CurrencyWitnessRow {
  reslab_currency?: string | null;
  fx_rate?: string | number | null;
  created_at: string;
}

/**
 * @param reslabCode the reservation's currency as ResLab reports it
 *   (`reslabCurrencyCode`): null when ResLab states none, which is how every
 *   reservation looked before currencies were reported and still means USD
 *   for an unmarked row.
 */
export function classifyRowCurrency(row: CurrencyWitnessRow, reslabCode: string | null): RowCurrency {
  const mark = row.reslab_currency ?? null;
  const created = Date.parse(row.created_at);
  // An unreadable date is NOT legacy: the row is then a fault, the careful side.
  const legacy = Number.isFinite(created) && created < Date.parse(CONVERSION_LIVE_FROM);

  if (mark === null) {
    if (reslabCode === null || reslabCode === "USD") return USD_ROW;
    if (reslabCode === "CAD") {
      return {
        kind: "cad_no_rate",
        legacy,
        reason: legacy
          ? "booked before conversion: charged the Canadian figure one-for-one"
          : "ResLab reports CAD but the booking is not marked as converted",
      };
    }
    return { kind: "conflict", reason: `ResLab reports ${reslabCode}` };
  }
  if (mark !== "CAD") return { kind: "conflict", reason: `the booking is marked ${mark}` };
  if (reslabCode !== null && reslabCode !== "CAD") {
    return { kind: "conflict", reason: `the booking is marked CAD but ResLab reports ${reslabCode}` };
  }
  const rate = rateFromColumn(row.fx_rate);
  if (rate) return { kind: "cad", rate, rateText: rateToColumn(rate) };
  // Rate 1 is the marker a data fix gives the old one-for-one bookings.
  const atOne = row.fx_rate !== null && row.fx_rate !== undefined && Number(row.fx_rate) === 1;
  return {
    kind: "cad_no_rate",
    legacy: atOne && legacy,
    reason: atOne
      ? legacy
        ? "booked before conversion: charged the Canadian figure one-for-one"
        : "marked at rate 1 after conversion went live"
      : "the booking's rate cannot be read",
  };
}

/** ResLab's side of the row is left out of every US-dollar figure. */
export const isLeftOut = (c: RowCurrency): boolean => c.kind === "cad_no_rate" || c.kind === "conflict";

/** One of the old one-for-one bookings: left out, but expected (does not hold the headline back). */
export const isLegacyNoRate = (c: RowCurrency): boolean => c.kind === "cad_no_rate" && c.legacy;
