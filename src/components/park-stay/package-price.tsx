/**
 * The Park & Stay price block, in P3's layout (plan v3 §5.4). Interim label
 * until the accountant answers M16 — never "Total includes taxes and fees".
 */

import { Check } from "lucide-react";
import { PARK_STAY_TAX_PENDING_NOTE, PARK_STAY_TOTAL_LABEL_INTERIM, paidAtHotelLine } from "@/lib/pricing/copy";
import type { PackagePrice as PackagePriceCents } from "@/lib/hotels/pricing";
import { formatCents, formatIsoDay } from "./format";

export function PackagePrice({ price, returnDate }: { price: PackagePriceCents; returnDate: string }) {
  return (
    <div className="text-right">
      <p className="text-xs text-muted-foreground">1 night + parking to {formatIsoDay(returnDate)}</p>
      <p className="font-heading text-2xl font-bold text-foreground">{formatCents(price.headlineTotalCents)}</p>
      <p className="flex items-center justify-end gap-1 text-xs text-foreground">
        <Check className="h-3 w-3" aria-hidden="true" />
        {PARK_STAY_TOTAL_LABEL_INTERIM}
      </p>
      <p className="text-[11px] italic text-muted-foreground">{PARK_STAY_TAX_PENDING_NOTE}</p>
      {price.propertyFeesDueAtHotelCents > 0 && (
        <p className="text-xs text-muted-foreground">{paidAtHotelLine(formatCents(price.propertyFeesDueAtHotelCents))}</p>
      )}
    </div>
  );
}
