import type { ShownPrice } from "./shown-price";
import { formatMoney } from "@/lib/pricing/price-view";
import { TaxesAndFeesIncluded } from "@/components/shared/taxes-fees-included";

/** The price box headline: per-day, total and the included line — or the state message. */
export function PriceHeadline({ shown, dailyRate }: { shown: ShownPrice; dailyRate: number }) {
  if (shown.kind === "message") {
    return <p className="text-base font-semibold text-gray-700">{shown.text}</p>;
  }
  if (shown.kind === "rate_only") {
    return (
      <div>
        <span className="text-3xl font-bold text-gray-900">{formatMoney(dailyRate)}</span>
        <span className="text-gray-500 font-medium"> / day</span>
      </div>
    );
  }
  const { view } = shown;
  return (
    <div>
      {view.perDay !== null && <div className="text-sm text-gray-500">{formatMoney(view.perDay)}/day</div>}
      <div className="text-3xl font-bold text-gray-900">{formatMoney(view.total)}</div>
      <TaxesAndFeesIncluded className="text-xs" />
    </div>
  );
}
