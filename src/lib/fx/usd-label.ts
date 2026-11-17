/**
 * The "US$" label for a lot whose price we convert from Canadian dollars
 * (today: ResLab lots in Canada). A customer there reads a bare "$" as
 * Canadian dollars; we charge US dollars, so every amount such a lot shows
 * carries "US$" and the Pay step says so in a sentence.
 *
 * A US-dollar lot keeps the plain "$" and nothing here changes its output.
 * The label is decided per lot (`lot.fxRateId`) or, on checkout, from the
 * figures the server sent (`costData.fxRateId`). Constants and pure helpers
 * only: safe to import from client components.
 */

/** The sign before an amount: "US$" on a converted lot, "$" otherwise. */
export function currencySign(usdLabel: boolean): "US$" | "$" {
  return usdLabel ? "US$" : "$";
}

/** "$30.39", or "US$30.39" on a converted lot. `usdLabel` is required: no surface gets a default. */
export function money(amount: number, usdLabel: boolean, digits = 2): string {
  return currencySign(usdLabel) + amount.toFixed(digits);
}

/** Whether a lot's price is a converted one. */
export function isUsdLabelled(lot: { fxRateId?: string } | null | undefined): boolean {
  return !!lot?.fxRateId;
}

/**
 * Whether a page that shows several lots (search results, an airport page)
 * lists a converted one. Every price on such a page is US dollars (a direct
 * lot there is priced in US dollars too), so its page-level figures ("from
 * $X/day") all take the label.
 */
export function anyUsdLabelled(lots: readonly { fxRateId?: string }[]): boolean {
  return lots.some((lot) => !!lot.fxRateId);
}

/** Under the results count on a search that lists a converted lot. */
export const USD_PRICES_LINE = "Prices are in US dollars";

/** On the Pay step of a converted lot, above the Pay button. */
export const USD_CHARGE_LINE =
  "You will be charged in US dollars (USD). Your card issuer may convert this and add a fee.";

/**
 * Names the wording of USD_CHARGE_LINE. Stamped on a converted lot's
 * PaymentIntent (`currencyNotice`), so the record says which sentence the
 * checkout showed. Change the sentence → change this.
 */
export const CURRENCY_NOTICE_VERSION = "2026-11-17";
