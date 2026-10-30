"use client";

/**
 * "Park & Stay offered here · Add a night" on a parking card for a hotel's
 * own lot (CX plan §4, §12.3, R12-M7), loaded lazily by the slot. No price
 * and no availability claim: rooms for these dates haven't been checked.
 * Shown only when the switch's Park & Stay side is enabled (same function),
 * so it never links where the switch is greyed out — and not on same-day
 * searches. The click never reaches the card: the mobile map card's root
 * opens the lot slider (mobile-map-card.tsx).
 */

import Link from "next/link";
import { BedDouble } from "lucide-react";
import type { ParkStayAccess } from "@/lib/hotels/access";
import { lotBadgeHref, parkStayFromParking, type RawParkingSearch } from "./from-parking";

export function ParkStayLotBadge({ access, search, reslabLocationId }: { access: ParkStayAccess; search: RawParkingSearch; reslabLocationId: number | null }) {
  const href = lotBadgeHref(parkStayFromParking(search, access, new Date()), access.hotels, reslabLocationId);
  if (href === null) return null;
  return (
    <Link
      href={href}
      onClick={(e) => e.stopPropagation()}
      className="mt-1.5 inline-flex items-center gap-1 rounded-full border border-orange-200 bg-orange-50 px-2 py-0.5 text-[11px] font-semibold text-gray-900 hover:border-brand-orange"
    >
      <BedDouble size={11} className="text-orange-700" aria-hidden="true" />
      Park &amp; Stay offered here ·{" "}
      <span className="text-orange-700 underline-offset-2 hover:underline">Add a night</span>
    </Link>
  );
}
