/**
 * The "US$" label for a lot whose price we convert from Canadian dollars
 * (today: ResLab lots in Canada). A customer there reads a bare "$" as
 * Canadian dollars; we charge US dollars, so every amount such a lot shows
 * before paying carries "US$" and the Pay step says so in a sentence. After
 * paying, the record (confirmation, emails, My Reservations, cancel) carries
 * the label too.
 *
 * A US-dollar lot keeps the plain "$" and nothing here changes its output.
 * Before paying the label is decided per lot (`lot.fxRateId`); for a page's
 * own figures ("from $X/day"), by whether it lists such a lot; on checkout,
 * from the figures the server sent (`costData.fxRateId`) or the lot. After
 * paying: from the booking row (`isUsdLabelledBooking`), or from the
 * PaymentIntent's `reslabCurrency` stamp where no row is read. Constants and
 * pure helpers only: safe to import from client components.
 */
import { formatUsd } from "@/lib/booking/cost-breakdown";

/** The sign before an amount: "US$" on a converted lot, "$" otherwise. */
export function currencySign(usdLabel: boolean): "US$" | "$" {
  return usdLabel ? "US$" : "$";
}

/** "$30.39", or "US$30.39" on a converted lot. `usdLabel` is required: no surface gets a default. */
export function money(amount: number, usdLabel: boolean, digits = 2): string {
  return currencySign(usdLabel) + amount.toFixed(digits);
}

/**
 * A cents amount on the RECORD of a booking (confirmation page and email, My
 * Reservations card): `formatUsd`'s exact text, with "US$" when the booking
 * is labelled. `usdLabel` is required: no surface gets a default.
 */
export function moneyCents(cents: number, usdLabel: boolean, credit = false): string {
  const text = formatUsd(cents, credit);
  return usdLabel ? text.replace("$", "US$") : text;
}

/**
 * Whether a booking's record carries the label: its row says the lot is priced
 * in Canadian dollars at the source (`bookings.reslab_currency`, migration
 * 052). Every charge and refund is US dollars, so "US$" is true for such a
 * row whatever its rate. A US lot, a direct lot and an unreadable row: false.
 */
export function isUsdLabelledBooking(row: { reslab_currency?: unknown } | null | undefined): boolean {
  return row?.reslab_currency === "CAD";
}

/**
 * The same question asked of a PaymentIntent, where no booking row is read
 * (the page after card verification, payment alerts, abandoned checkouts):
 * the checkout stamped it `reslabCurrency: "CAD"`. The key is spelled out
 * (FX_KEYS.currency in fx/cad-usd.ts; a test pins the two together) so this
 * file stays free of imports a client bundle should not carry.
 */
export function isUsdLabelledPayment(metadata: Record<string, string | undefined> | null | undefined): boolean {
  return metadata?.reslabCurrency === "CAD";
}

/** Whether a lot's price is a converted one. */
export function isUsdLabelled(lot: { fxRateId?: string }): boolean {
  return !!lot.fxRateId;
}

/**
 * Whether a page that shows several lots (search results, an airport page)
 * lists a converted one. Every price on such a page is US dollars (a direct
 * lot there is priced in US dollars too), so its page-level figures ("from
 * $X/day") all take the label.
 */
export function anyUsdLabelled(lots: readonly { fxRateId?: string }[]): boolean {
  return lots.some((lot) => isUsdLabelled(lot));
}

/**
 * Whether a checkout is for a converted lot: the figures the server sent say
 * so, or (before they arrive, or on a path that has none) the lot does.
 * Either is enough — a converted checkout must never fall back to a bare "$".
 */
export function isConvertedCheckout(
  lot: { fxRateId?: string },
  costData: { fxRateId?: string } | null | undefined
): boolean {
  return !!(costData?.fxRateId || lot.fxRateId);
}

/** On its own line under the results count, on a search that lists a converted lot. */
export const USD_PRICES_LINE = "Prices are in US dollars";

/**
 * Every wording of the Pay step's US-dollar sentence, by version: what a
 * PaymentIntent's `currencyNotice` stamp means later (dispute evidence quotes
 * it). To reword: ADD an entry and point CURRENCY_NOTICE_VERSION at it; never
 * edit or remove an old one (same pattern as checkout/terms-acceptance.ts).
 */
const CURRENCY_NOTICES = {
  "2026-11-17": "You will be charged in US dollars (USD). Your card issuer may convert this and add a fee.",
} as const;

/**
 * The version in force. The checkout page sends the version in its own
 * bundle with the payment request; the server refuses any other and stamps
 * it on the converted lot's PaymentIntent (`currencyNotice`).
 */
export const CURRENCY_NOTICE_VERSION: keyof typeof CURRENCY_NOTICES = "2026-11-17";

/** On the Pay step of a converted lot, above the Pay button. */
export const USD_CHARGE_LINE: string = CURRENCY_NOTICES[CURRENCY_NOTICE_VERSION];

/** Beside a refund amount on a labelled booking (cancel preview, cancellation email). */
export const USD_REFUND_LINE = "Refunds are made in US dollars; the amount on your statement may differ.";

/** The sentence a payment's `currencyNotice` stamp names; null when it has none or the version is unknown. */
export function currencyNoticeTextFor(version: unknown): string | null {
  if (typeof version !== "string" || !Object.hasOwn(CURRENCY_NOTICES, version)) return null;
  return CURRENCY_NOTICES[version as keyof typeof CURRENCY_NOTICES];
}
