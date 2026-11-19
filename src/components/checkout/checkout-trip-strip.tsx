import { formatDate } from "@/lib/utils";
import type { TripStripPrice } from "@/lib/checkout/total-label";

interface CheckoutTripStripProps {
  lotName: string;
  /** Literal YYYY-MM-DD booking dates (airport-local): shown as calendar days, never converted. */
  checkIn: string;
  checkOut: string;
  /** tripStripPrice(): the order summary's own total, label and split. */
  price: TripStripPrice;
  /** id of the order summary, for the "Price breakdown" link. */
  summaryId: string;
}

/**
 * A short strip above the details form on phones and tablets: which lot, which
 * days, what it costs. Below `lg` the order summary sits under the form, so
 * without this a shopper sees a bare form before typing (32% left the
 * details step without touching a field, 12-17 Nov). Desktop already shows
 * the summary beside the form, so this is hidden there.
 */
export function CheckoutTripStrip({
  lotName,
  checkIn,
  checkOut,
  price: { totalLabel, total, atLotNote, sign },
  summaryId,
}: CheckoutTripStripProps) {
  const day = (d: string) =>
    formatDate(d + "T00:00:00", { weekday: "short", month: "short", day: "numeric" });

  return (
    <div className="lg:hidden mb-4 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm">
      <div className="flex items-baseline justify-between gap-3">
        <p className="font-semibold text-gray-900 truncate min-w-0">{lotName}</p>
        {total !== null && (
          <p className="shrink-0 text-gray-900">
            {totalLabel}{" "}
            <span className="font-bold">
              {sign}
              {total.toFixed(2)}
            </span>
          </p>
        )}
      </div>
      <div className="mt-0.5 flex items-baseline justify-between gap-3 text-xs">
        <span className="text-gray-600">
          {day(checkIn)} – {day(checkOut)}
        </span>
        <a href={`#${summaryId}`} className="shrink-0 text-gray-600 underline hover:text-gray-900">
          Price breakdown
        </a>
      </div>
      {atLotNote && <p className="mt-0.5 text-xs text-amber-700">{atLotNote}</p>}
    </div>
  );
}
