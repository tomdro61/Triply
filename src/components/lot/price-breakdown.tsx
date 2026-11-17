import type { ReactNode } from "react";
import type { ShownPrice } from "./shown-price";
import type { PriceView } from "@/lib/pricing/price-view";
import { money } from "@/lib/fx/usd-label";

function Line({ label, value, className = "text-gray-600" }: { label: string; value: string; className?: string }) {
  return (
    <div className={`flex justify-between text-sm mb-2 ${className}`}>
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}

function Lines({ view, usdLabel }: { view: PriceView; usdLabel: boolean }) {
  const formatMoney = (n: number) => money(n, usdLabel);
  const parkingLabel =
    view.days !== null
      ? `${formatMoney(view.parking / view.days)} x ${view.days} ${view.days === 1 ? "day" : "days"}`
      : "Parking";
  return (
    <>
      <Line label={parkingLabel} value={formatMoney(view.parking)} />
      {view.discount > 0 && <Line label="Long-stay discount" value={`−${formatMoney(view.discount)}`} className="text-green-700" />}
      <Line label="Taxes" value={formatMoney(view.taxes)} />
      {view.serviceFee > 0 && <Line label="Service fee" value={formatMoney(view.serviceFee)} />}
      <div className="border-t border-gray-200 pt-2 flex justify-between font-bold text-gray-900 text-lg">
        <span>Total</span>
        <span>{formatMoney(view.total)}</span>
      </div>
      {view.dueAtLocation > 0 && (
        <div className="mt-2 pt-2 border-t border-gray-200 flex justify-between text-sm text-amber-700">
          <span>Due at location</span>
          <span>{formatMoney(view.dueAtLocation)}</span>
        </div>
      )}
    </>
  );
}

/**
 * The itemised price box: lines that add up to the headline total, shown only
 * beside a real total for the stay on screen, plus any note (e.g. a direct
 * lot's oversized-vehicle surcharge, paid at the lot). `usdLabel`: the lot's
 * price is converted from Canadian dollars, so every amount reads "US$".
 */
export function PriceBreakdown({
  shown,
  usdLabel,
  note,
  className = "",
}: {
  shown: ShownPrice;
  usdLabel: boolean;
  note?: ReactNode;
  className?: string;
}) {
  if (shown.kind !== "view" && !note) return null;
  return (
    <div className={`bg-gray-50 rounded-lg p-4 border border-gray-100 ${className}`}>
      {shown.kind === "view" && <Lines view={shown.view} usdLabel={usdLabel} />}
      {note}
    </div>
  );
}
