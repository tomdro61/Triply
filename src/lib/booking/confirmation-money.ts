/**
 * The money on a ResLab reservation, as the confirmation page may show it.
 *
 * ResLab answers in the lot's own currency. For a lot it prices in Canadian
 * dollars the customer was charged US dollars at ONE rate, kept on the booking
 * row (`bookings.reslab_currency` / `fx_rate`, migration 052). Every later
 * view converts ResLab's live figures with THAT rate, so the page keeps
 * agreeing with the stored row and with Stripe however the rate moves.
 *
 * Pure and total: never throws, whatever JSON ResLab sent.
 */
import { rateFromColumn, toUsd } from "@/lib/fx/cad-usd";

/** Typed as ResLab's client types them; the body is untyped JSON, so every reader still checks. */
type Amount = number | null | undefined;

export interface HistoryMoney {
  subtotal: Amount;
  total_fees: Amount;
  total_tax: Amount;
  long_term_discount: Amount;
  grand_total: Amount;
  due_at_location_total: Amount;
}

export type ConfirmationMoney = HistoryMoney & {
  /**
   * "raw"       — ResLab's figures as sent (a US lot; or a booking charged
   *               one-for-one before conversion existed).
   * "converted" — Canadian dollars converted at the booking's stored rate.
   * "withheld"  — the figures are not US dollars and we cannot convert them
   *               reliably: every amount is undefined (the page shows what
   *               Stripe charged and no ResLab figure), never a Canadian
   *               number under a "$".
   */
  basis: "raw" | "converted" | "withheld";
  /** Why amounts were withheld; null otherwise. For the Sentry report. */
  withheldReason: string | null;
};

interface HistoryLike {
  subtotal?: Amount;
  total_fees?: Amount;
  total_tax?: Amount;
  long_term_discount?: Amount;
  grand_total?: Amount;
  due_at_location_total?: Amount;
  location?: { currency?: { code?: unknown } | null } | null;
}

const WITHHELD: HistoryMoney = {
  subtotal: undefined,
  total_fees: undefined,
  total_tax: undefined,
  long_term_discount: undefined,
  grand_total: undefined,
  due_at_location_total: undefined,
};

const asAmount = (v: unknown): number => (typeof v === "number" ? v : Number.NaN);

/**
 * @param history ResLab's `history[0]` (untyped JSON), or undefined.
 * @param row     The booking row's currency columns; null when the row could
 *                not be read (NOT the same as a row whose columns are NULL).
 */
export function reslabHistoryMoney(
  history: HistoryLike | null | undefined,
  row: { reslab_currency?: unknown; fx_rate?: unknown } | null
): ConfirmationMoney {
  const raw: HistoryMoney = {
    subtotal: history?.subtotal,
    total_fees: history?.total_fees,
    total_tax: history?.total_tax,
    long_term_discount: history?.long_term_discount,
    grand_total: history?.grand_total,
    due_at_location_total: history?.due_at_location_total,
  };
  const code = history?.location?.currency?.code;
  const reslabCurrency = typeof code === "string" && code.trim() !== "" ? code.trim().toUpperCase() : null;
  const withheld = (withheldReason: string): ConfirmationMoney => ({ ...WITHHELD, basis: "withheld", withheldReason });

  if (row === null) {
    // No row: we do not know whether, or at what rate, this booking was
    // converted. A reservation ResLab says is not in US dollars is not shown.
    return reslabCurrency !== null && reslabCurrency !== "USD"
      ? withheld(`the booking row could not be read and the reservation is priced in ${reslabCurrency}`)
      : { ...raw, basis: "raw", withheldReason: null };
  }

  const rowCurrency = typeof row.reslab_currency === "string" ? row.reslab_currency.trim().toUpperCase() : null;
  if (rowCurrency === null || rowCurrency === "") {
    // A US lot — or one of the bookings charged one-for-one before conversion
    // existed, whose stored figures ARE ResLab's raw numbers. Shown as stored.
    return { ...raw, basis: "raw", withheldReason: null };
  }
  if (rowCurrency !== "CAD") return withheld(`the booking row has an unknown currency (${rowCurrency})`);
  // Marked as charged one-for-one (the pre-conversion bookings): raw.
  if (Number(row.fx_rate) === 1) return { ...raw, basis: "raw", withheldReason: null };

  const rate = rateFromColumn(row.fx_rate);
  if (rate === null) return withheld("the booking row's exchange rate is unusable");
  if (reslabCurrency !== null && reslabCurrency !== "CAD") {
    return withheld(`the booking was converted from CAD but the reservation is now priced in ${reslabCurrency}`);
  }
  const converted = toUsd(
    {
      subtotal: asAmount(history?.subtotal),
      feesTotal: asAmount(history?.total_fees),
      taxTotal: asAmount(history?.total_tax),
      longTermDiscount: history?.long_term_discount == null ? 0 : asAmount(history.long_term_discount),
      grandTotal: asAmount(history?.grand_total),
      dueAtLocation: history?.due_at_location_total == null ? 0 : asAmount(history.due_at_location_total),
    },
    rate
  );
  if (!converted.ok) return withheld(`the reservation's CAD figures could not be converted (${converted.reason})`);
  return {
    subtotal: converted.usd.subtotal,
    total_fees: converted.usd.feesTotal,
    total_tax: converted.usd.taxTotal,
    long_term_discount: converted.usd.longTermDiscount,
    grand_total: converted.usd.grandTotal,
    due_at_location_total: converted.usd.dueAtLocation,
    basis: "converted",
    withheldReason: null,
  };
}
