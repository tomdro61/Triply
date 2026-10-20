/**
 * The Park & Stay price column (mockup screen 7, P3's layout, plan v3 §5.4).
 * Interim label until the accountant answers M16 — never "Total includes
 * taxes and fees". The "tax rules pending" note is said once, in the
 * PreviewBanner, and money paid at the hotel is the card's amber tag.
 */

import { PARK_STAY_TOTAL_LABEL_INTERIM } from "@/lib/pricing/copy";
import type { PackagePrice as PackagePriceCents } from "@/lib/hotels/pricing";
import { formatCents } from "./format";
import { packageLabel } from "./card-facts";

export function PackagePrice({ price, returnDate, align = "end" }: { price: PackagePriceCents; returnDate: string; align?: "start" | "end" }) {
  return (
    <div className={align === "end" ? "text-right" : "text-left"}>
      <p className="text-xs text-muted-foreground">{packageLabel(returnDate)}</p>
      <p className="font-heading text-[26px] font-bold leading-tight text-foreground">{formatCents(price.headlineTotalCents)}</p>
      <p className="text-[11.5px] text-muted-foreground">{PARK_STAY_TOTAL_LABEL_INTERIM}</p>
    </div>
  );
}
