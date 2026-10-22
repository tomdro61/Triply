import type { ShownPrice } from "./shown-price";
import { formatMoney } from "@/lib/pricing/price-view";
import { TaxesAndFeesIncluded } from "@/components/shared/taxes-fees-included";

/** The price beside a sticky Reserve button (lot page on phones, search slider). */
export function PriceFooter({ shown, dailyRate }: { shown: ShownPrice; dailyRate: number }) {
  if (shown.kind === "message") {
    return <span className="text-sm font-semibold text-gray-700">{shown.short}</span>;
  }
  if (shown.kind === "rate_only") {
    return (
      <div className="flex items-baseline gap-1">
        <span className="text-xl font-bold text-gray-900">{formatMoney(dailyRate)}</span>
        <span className="text-sm text-gray-500">/day</span>
      </div>
    );
  }
  const { view } = shown;
  return (
    <div>
      <div className="flex items-baseline gap-1.5">
        <span className="text-xl font-bold text-gray-900">{formatMoney(view.total)}</span>
        {view.perDay !== null && <span className="text-sm text-gray-500">{formatMoney(view.perDay)}/day</span>}
      </div>
      <TaxesAndFeesIncluded className="text-xs" />
    </div>
  );
}
