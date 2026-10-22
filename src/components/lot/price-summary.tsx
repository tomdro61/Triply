import type { LivePrice } from "./use-live-price";
import type { PriceView } from "@/lib/pricing/price-view";
import { TAXES_AND_FEES_INCLUDED } from "@/lib/utils/service-fee";

/**
 * What a price box shows right now, from the live state and the price the page
 * was loaded with. One place for the wording, so the lot page booking box and
 * the search slider can't drift apart.
 */
export type ShownPrice =
  | { kind: "view"; view: PriceView }
  /** No total at all: the lot's daily rate only, and no "included" claim. */
  | { kind: "rate_only" }
  | { kind: "message"; text: string; short: string };

export const PRICE_MESSAGES = {
  needsTimes: { text: "Select your times to see your total", short: "Select times for your total" },
  loading: { text: "Updating price…", short: "Updating price…" },
  soldOut: { text: "Not available for these dates and times. Try different times.", short: "Not available" },
  error: { text: "We couldn't update the price. You'll see the exact total at checkout.", short: "Total shown at checkout" },
} as const;

export function shownPrice(live: LivePrice, loaded: PriceView | null): ShownPrice {
  switch (live.kind) {
    case "as_loaded":
      return loaded ? { kind: "view", view: loaded } : { kind: "rate_only" };
    case "ready":
      return { kind: "view", view: live.view };
    case "needs_times":
      return { kind: "message", ...PRICE_MESSAGES.needsTimes };
    case "loading":
      return { kind: "message", ...PRICE_MESSAGES.loading };
    case "sold_out":
      return { kind: "message", ...PRICE_MESSAGES.soldOut };
    case "error":
      return { kind: "message", ...PRICE_MESSAGES.error };
  }
}

const money = (n: number) => `$${n.toFixed(2)}`;

/** The headline: per-day, total and the included line — or the state message. */
export function PriceHeadline({ shown, dailyRate }: { shown: ShownPrice; dailyRate: number }) {
  if (shown.kind === "message") {
    return <p className="text-base font-semibold text-gray-700">{shown.text}</p>;
  }
  if (shown.kind === "rate_only") {
    return (
      <div>
        <span className="text-3xl font-bold text-gray-900">{money(dailyRate)}</span>
        <span className="text-gray-500 font-medium"> / day</span>
      </div>
    );
  }
  const { view } = shown;
  return (
    <div>
      {view.perDay !== null && <div className="text-sm text-gray-500">{money(view.perDay)}/day</div>}
      <div className="text-3xl font-bold text-gray-900">{money(view.total)}</div>
      <div className="text-xs text-gray-500">{TAXES_AND_FEES_INCLUDED}</div>
    </div>
  );
}

/** The itemised lines; they add up to the headline total. */
export function PriceBreakdown({ view }: { view: PriceView }) {
  const line = (label: string, value: string, className = "text-gray-600") => (
    <div className={`flex justify-between text-sm mb-2 ${className}`}>
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
  const parkingLabel =
    view.days !== null
      ? `${money(view.parking / view.days)} x ${view.days} ${view.days === 1 ? "day" : "days"}`
      : "Parking";
  return (
    <>
      {line(parkingLabel, money(view.parking))}
      {view.discount > 0 && line("Long-stay discount", `−${money(view.discount)}`, "text-green-700")}
      {line("Taxes", money(view.taxes))}
      {view.serviceFee > 0 && line("Service fee", money(view.serviceFee))}
      <div className="border-t border-gray-200 pt-2 flex justify-between font-bold text-gray-900 text-lg">
        <span>Total</span>
        <span>{money(view.total)}</span>
      </div>
      {view.dueAtLocation > 0 && (
        <div className="mt-2 pt-2 border-t border-gray-200 flex justify-between text-sm text-amber-700">
          <span>Due at location</span>
          <span>{money(view.dueAtLocation)}</span>
        </div>
      )}
    </>
  );
}
