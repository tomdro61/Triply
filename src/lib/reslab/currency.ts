/**
 * Which ResLab lots can be sold, in which currency, and the conversion of a
 * ResLab price for a lot priced in Canadian dollars.
 *
 * Imports nothing from search.ts: lib/booking may import this file
 * (no-reslab-list-in-booking.test.ts forbids the location list there).
 */
import type { ReslabCostResponse, ReslabMinPriceResponse } from "./client";
import { currentCadRate, toUsd, type FxRate, type FxStamp, type FxUnusable, type ReslabMoneyParts } from "@/lib/fx/cad-usd";

export type LotCurrency =
  /** Priced in US dollars: sold as is. */
  | { kind: "usd" }
  /** Priced in Canadian dollars and sellable now: convert with `rate`. */
  | { kind: "cad"; rate: FxRate }
  /** Not sold: an unknown or third currency, a Canadian lot with no stated
   *  currency, a Canadian lot that collects at the lot, or no rate is set. */
  | { kind: "hidden"; reason: "currency" | "currency_missing" | "no_rate" | "pay_at_lot" };

interface CurrencyFields {
  currency?: { code?: string } | null;
  country?: { code?: string } | null;
  parking_due_at_location?: boolean | number;
}

/**
 * A location with no currency at all is USD, as it always has been — except a
 * lot in Canada, which must say CAD explicitly: a Canadian lot whose record
 * lost its currency would otherwise be sold one-for-one in US dollars (the
 * Nov 3, 2026 bug).
 */
export function lotCurrency(
  location: CurrencyFields,
  now: Date = new Date(),
  // The rate for new bookings. Left out, it is read from the setting
  // (currentCadRate); tests pass one, or null for "no rate set".
  cadRate: FxRate | null | undefined = undefined
): LotCurrency {
  const code = (location.currency?.code ?? "").trim().toUpperCase();
  const inCanada = (location.country?.code ?? "").trim().toUpperCase() === "CA";
  if (code === "" || code === "USD") {
    return inCanada ? { kind: "hidden", reason: "currency_missing" } : { kind: "usd" };
  }
  if (code !== "CAD") return { kind: "hidden", reason: "currency" };
  // The lot collects in Canadian dollars at the counter; a converted figure
  // would be an estimate shown as exact.
  if (location.parking_due_at_location) return { kind: "hidden", reason: "pay_at_lot" };
  const rate = cadRate === undefined ? currentCadRate(now) : cadRate;
  return rate ? { kind: "cad", rate } : { kind: "hidden", reason: "no_rate" };
}

export function isSellableLocation(
  location: CurrencyFields,
  now: Date = new Date(),
  cadRate: FxRate | null | undefined = undefined
): boolean {
  return lotCurrency(location, now, cadRate).kind !== "hidden";
}

/** The currency fields a lot's `pricing` reports. A converted lot's figures are US dollars. */
export function pricingCurrencyFields(location: CurrencyFields, currency: LotCurrency): { currency: string; currencyCode: string } {
  if (currency.kind === "cad") return { currency: "$", currencyCode: "USD" };
  const currencyCode = location.currency?.code || "USD";
  return { currency: currencyCode === "USD" ? "$" : currencyCode, currencyCode };
}

/** `lot.fxRateId` for a converted lot; nothing for a US lot (the key is absent, not undefined). */
export function lotFxFields(currency: LotCurrency): { fxRateId?: string } {
  return currency.kind === "cad" ? { fxRateId: currency.rate.id } : {};
}

/** Min-price data for a lot, converted when the lot is priced in CAD. null = no usable price. */
export function minPriceInUsd(
  data: ReslabMinPriceResponse | null,
  currency: LotCurrency
): { data: ReslabMinPriceResponse | null; unusable: string | null } {
  if (data === null || currency.kind === "usd") return { data, unusable: null };
  if (currency.kind === "hidden") return { data: null, unusable: `hidden_${currency.reason}` };
  const converted = convertMinPrice(data, currency.rate);
  return converted.ok ? { data: converted.value, unusable: null } : { data: null, unusable: `fx_${converted.reason}` };
}

type PriceReservation = ReslabMinPriceResponse["reservation"] | ReslabCostResponse["reservation"];
/** The shape both price responses share (a cost response only adds optional fields). */
type ConvertedReservation = ReslabMinPriceResponse["reservation"];

export type ConvertedPrice<T> = { ok: true; value: T } | { ok: false; reason: FxUnusable | "discount" | "pay_at_lot" };

/**
 * A min-price or cost `reservation` in CAD → the same shape in USD. Built
 * field by field: nothing unconverted rides along. Never throws.
 *
 * Refused (the caller treats the lot as unpriced / refuses the checkout):
 *  - parts that do not add up, a bad amount, a bad rate (see toUsd);
 *  - a nonzero `discount` — it is not part of ResLab's sum and we do not know
 *    what it would mean on a converted price;
 *  - any pay-at-lot amount (collected in Canadian dollars).
 */
function convertReservation(r: PriceReservation, rate: FxRate): ConvertedPrice<ConvertedReservation> {
  if (r?.discount != null && r.discount !== 0) return { ok: false, reason: "discount" };
  const fx = toUsd(
    {
      subtotal: r?.sub_total,
      feesTotal: r?.fees_total,
      taxTotal: r?.tax_total,
      longTermDiscount: r?.long_term_discount ?? 0,
      grandTotal: r?.grand_total,
      dueAtLocation: r?.due_at_location ?? 0,
    },
    rate
  );
  if (!fx.ok) return fx;
  if (fx.usdCents.dueAtLocation > 0) return { ok: false, reason: "pay_at_lot" };
  const value: ConvertedReservation = {
    // The fee list and the lot's commission are ResLab's CAD bookkeeping;
    // nothing on the parking path reads them (Park & Stay does, and never
    // sells a converted lot). Dropped rather than carried unconverted.
    fees: [],
    location_commission: 0,
    discount: 0,
    available_spots: r.available_spots,
    parking_sold_out: r.parking_sold_out,
    sold_out: r.sold_out,
    sub_total: fx.usd.subtotal,
    fees_total: fx.usd.feesTotal,
    tax_total: fx.usd.taxTotal,
    long_term_discount: fx.usd.longTermDiscount,
    grand_total: fx.usd.grandTotal,
    due_at_location: fx.usd.dueAtLocation,
    totals: {
      parking: {
        number_of_days: r.totals?.parking?.number_of_days,
        sub_total: fx.usd.subtotal,
      },
    },
  };
  return { ok: true, value };
}

/** Per-day rates carry the parking type id the lot page needs; their CAD price is never shown. */
function ratesWithoutPrices<T extends { price: number }>(rates: T[] | undefined): T[] {
  return (rates ?? []).map((rate) => ({ ...rate, price: 0 }));
}

export function convertMinPrice(data: ReslabMinPriceResponse, rate: FxRate): ConvertedPrice<ReslabMinPriceResponse> {
  const r = convertReservation(data?.reservation, rate);
  if (!r.ok) return r;
  return { ok: true, value: { rates: ratesWithoutPrices(data.rates), reservation: r.value, warning: data.warning, token: data.token } };
}

/** `costs_token` is kept: it locks ResLab's own (CAD) price for the reservation call. */
export function convertCost(data: ReslabCostResponse, rate: FxRate): ConvertedPrice<ReslabCostResponse> {
  const r = convertReservation(data?.reservation, rate);
  if (!r.ok) return r;
  return { ok: true, value: { rates: ratesWithoutPrices(data.rates), reservation: r.value, warning: data.warning, costs_token: data.costs_token } };
}

/**
 * Why a lot's currency (read fresh from ResLab) does not match the stamp its
 * PaymentIntent was priced under, or null when they agree.
 *  - stamped USD, or no stamp (a PaymentIntent from before the stamp, when
 *    only US lots were sold): the lot must be a US-dollar lot.
 *  - stamped CAD: the lot must be a Canadian-dollar lot we are selling NOW.
 *    The rate may have changed since (the booking keeps its stamped rate),
 *    but a lot that is hidden today is not booked.
 */
export function stampedCurrencyProblem(stamp: FxStamp, lot: LotCurrency): string | null {
  if (stamp.kind === "invalid") return "the PaymentIntent's currency stamp is unusable";
  if (stamp.kind === "cad") {
    return lot.kind === "cad" ? null : `the PaymentIntent is stamped CAD but the lot is ${lot.kind === "usd" ? "priced in USD" : `not sold (${lot.reason})`}`;
  }
  return lot.kind === "usd" ? null : `the PaymentIntent has no conversion (${stamp.kind}) but the lot is ${lot.kind === "cad" ? "priced in CAD" : `not sold (${lot.reason})`}`;
}

// ---------------------------------------------------------------------------
// A reservation's history, read ONE way
// ---------------------------------------------------------------------------

/** ResLab's `history[0]` money as its client types it. The body is untyped JSON, so every reader still checks. */
export type HistoryAmount = number | null | undefined;
export interface ReslabHistoryLike {
  subtotal?: HistoryAmount;
  total_fees?: HistoryAmount;
  total_tax?: HistoryAmount;
  long_term_discount?: HistoryAmount;
  grand_total?: HistoryAmount;
  due_at_location_total?: HistoryAmount;
  location?: { currency?: { code?: unknown } | null } | null;
}

const asAmount = (v: unknown): number => (typeof v === "number" ? v : Number.NaN);

/**
 * A reservation history's money as `toUsd` input. The booking row
 * (fromReslab) and the confirmation page (reslabHistoryMoney) both convert
 * through this, so the same history always gives the same US figures or the
 * same refusal. A missing long-stay discount or pay-at-lot amount is 0;
 * anything else that is not a number is NaN, which toUsd refuses.
 */
export function historyMoneyParts(h: ReslabHistoryLike | null | undefined): ReslabMoneyParts {
  return {
    subtotal: asAmount(h?.subtotal),
    feesTotal: asAmount(h?.total_fees),
    taxTotal: asAmount(h?.total_tax),
    longTermDiscount: h?.long_term_discount == null ? 0 : asAmount(h.long_term_discount),
    grandTotal: asAmount(h?.grand_total),
    dueAtLocation: h?.due_at_location_total == null ? 0 : asAmount(h.due_at_location_total),
  };
}

/**
 * A currency code as ResLab sent it on a reservation: trimmed and upper-cased,
 * or null when there is none. NOT for deciding what to sell (lotCurrency): an
 * unreadable code there must hide the lot, never read as "no currency".
 */
export function reslabCurrencyCode(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim().toUpperCase() : null;
}
