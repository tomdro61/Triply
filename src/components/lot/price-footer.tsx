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
  if (usdLabel) {
    // "US$" makes the one-line form too wide beside Reserve on a phone: the
    // per-day figure goes above the total, as in PriceHeadline.
    return (
      <div>
        {view.perDay !== null && <div className="text-xs text-gray-500">{money(view.perDay, usdLabel)}/day</div>}
        <div className="text-xl font-bold text-gray-900">{money(view.total, usdLabel)}</div>
        <TaxesAndFeesIncluded className="text-xs" />
      </div>
    );
  }
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
