import type { ShownPrice } from "./shown-price";
import { money } from "@/lib/fx/usd-label";
import { TaxesAndFeesIncluded } from "@/components/shared/taxes-fees-included";

/** The price beside a sticky Reserve button (lot page on phones, search slider). `usdLabel` as in PriceHeadline. */
export function PriceFooter({ shown, dailyRate, usdLabel }: { shown: ShownPrice; dailyRate: number; usdLabel: boolean }) {
  if (shown.kind === "message") {
    return <span className="text-sm font-semibold text-gray-700">{shown.short}</span>;
  }
  if (shown.kind === "rate_only") {
    return (
      <div className="flex items-baseline gap-1">
        <span className="text-xl font-bold text-gray-900">{money(dailyRate, usdLabel)}</span>
        <span className="text-sm text-gray-500">/day</span>
      </div>
    );
  }
  const { view } = shown;
  return (
    <div>
      <div className="flex items-baseline gap-1.5">
        <span className="text-xl font-bold text-gray-900">{money(view.total, usdLabel)}</span>
        {view.perDay !== null && <span className="text-sm text-gray-500">{money(view.perDay, usdLabel)}/day</span>}
      </div>
      <TaxesAndFeesIncluded className="text-xs" />
    </div>
  );
}
