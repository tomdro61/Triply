import type { ShownPrice } from "./shown-price";
import { money } from "@/lib/fx/usd-label";
import { TaxesAndFeesIncluded } from "@/components/shared/taxes-fees-included";

/**
 * The price box headline: per-day, total and the included line — or the state
 * message. `usdLabel`: the lot's price is converted from Canadian dollars, so
 * every amount reads "US$".
 */
export function PriceHeadline({ shown, dailyRate, usdLabel }: { shown: ShownPrice; dailyRate: number; usdLabel: boolean }) {
  if (shown.kind === "message") {
    return <p className="text-base font-semibold text-gray-700">{shown.text}</p>;
  }
  if (shown.kind === "rate_only") {
    return (
      <div>
        <span className="text-3xl font-bold text-gray-900">{money(dailyRate, usdLabel)}</span>
        <span className="text-gray-500 font-medium"> / day</span>
      </div>
    );
  }
  const { view } = shown;
  return (
    <div>
      {view.perDay !== null && <div className="text-sm text-gray-500">{money(view.perDay, usdLabel)}/day</div>}
      <div className="text-3xl font-bold text-gray-900">{money(view.total, usdLabel)}</div>
      <TaxesAndFeesIncluded className="text-xs" />
    </div>
  );
}
