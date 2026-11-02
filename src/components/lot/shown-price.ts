import type { LivePrice } from "./use-live-price";
import type { PriceView } from "@/lib/pricing/price-view";

/**
 * What a price box shows right now, from the live state and the price the page
 * was loaded with. One place for the decision and the wording, so the lot page
 * booking box and the search slider can't drift apart.
 */
export type ShownPrice =
  | { kind: "view"; view: PriceView }
  /** No total to show: the lot's daily rate only, and no "included" claim. */
  | { kind: "rate_only" }
  | { kind: "message"; text: string; short: string };

export const PRICE_MESSAGES = {
  needsTimes: { text: "Select your times to see your total", short: "Select times for your total" },
  loading: { text: "Updating price…", short: "Updating price…" },
  soldOut: { text: "Sold out for these dates and times. Try different times.", short: "Sold out" },
  notBookable: { text: "Not available for these dates and times. Try different times.", short: "Not available" },
  closed: { text: "Online booking for this lot opens soon", short: "Opens soon" },
  error: { text: "We couldn't update the price. You'll see the exact total at checkout.", short: "Total shown at checkout" },
} as const;

/** Reserve stays off for these: checkout would refuse the stay on screen. */
export const isUnavailable = (live: LivePrice) => live.kind === "sold_out" || live.kind === "not_bookable";

export function shownPrice(live: LivePrice, loaded: PriceView | null, dailyRate: number): ShownPrice {
  const rateOr = (fallback: { text: string; short: string }): ShownPrice =>
    dailyRate > 0 ? { kind: "rate_only" } : { kind: "message", ...fallback };
  switch (live.kind) {
    case "as_loaded":
      return loaded ? { kind: "view", view: loaded } : rateOr(PRICE_MESSAGES.needsTimes);
    case "closed":
      return rateOr(PRICE_MESSAGES.closed);
    case "ready":
      return { kind: "view", view: live.view };
    case "needs_times":
      return { kind: "message", ...PRICE_MESSAGES.needsTimes };
    case "loading":
      return { kind: "message", ...PRICE_MESSAGES.loading };
    case "sold_out":
      return { kind: "message", ...PRICE_MESSAGES.soldOut };
    case "not_bookable":
      return { kind: "message", ...PRICE_MESSAGES.notBookable };
    case "error":
      return { kind: "message", ...PRICE_MESSAGES.error };
  }
}
