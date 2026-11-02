import { Check } from "lucide-react";
import { TAXES_AND_FEES_INCLUDED } from "@/lib/utils/service-fee";

/**
 * "✓ Taxes & fees included" — beside every fee-inclusive total: search cards,
 * map card, lot page, search slider and their sticky footers. Same green check
 * as "Free Cancellation". `className` sets size and alignment per surface.
 */
export function TaxesAndFeesIncluded({ className = "" }: { className?: string }) {
  return (
    <div className={`flex items-center gap-0.5 text-green-600 font-medium whitespace-nowrap ${className}`}>
      <Check size={12} strokeWidth={3} aria-hidden="true" className="flex-shrink-0" />
      {TAXES_AND_FEES_INCLUDED}
    </div>
  );
}
