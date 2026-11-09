"use client";

import Image from "next/image";
import type { ReactNode } from "react";
import { MapPin, Bus, Shield, Warehouse, Sun, Wallet } from "lucide-react";
import { UnifiedLot } from "@/types/lot";
import { customerPerDayFromPricing, customerTotalFromPricing } from "@/lib/utils/service-fee";
import { TaxesAndFeesIncluded } from "@/components/shared/taxes-fees-included";
import { ShuttleChip } from "@/components/shared/shuttle-chip";
import { unmetMinimumStay } from "@/lib/lots/min-stay";
import { amenitiesBesideShuttle, shuttleLabel, shuttleStatus } from "@/lib/lots/shuttle-status";
import { LotBadges } from "./lot-badges";

interface MobileMapCardProps {
  lot: UnifiedLot;
  onSelect: (lot: UnifiedLot) => void;
  /**
   * An optional extra badge under the distance line. Unset renders nothing.
   * A link in it must stop the click's propagation: this card's root opens
   * the lot slider.
   */
  extraBadge?: ReactNode;
}

function getTopAmenityIcon(name: string) {
  const key = name.toLowerCase();
  if (key.includes("shuttle")) return <Bus size={12} className="text-green-600" />;
  if (key.includes("security") || key.includes("guarded")) return <Shield size={12} className="text-blue-600" />;
  if (key.includes("covered") || key.includes("garage")) return <Warehouse size={12} className="text-blue-500" />;
  if (key.includes("outdoor") || key.includes("surface")) return <Sun size={12} className="text-orange-500" />;
  return null;
}

export function MobileMapCard({ lot, onSelect, extraBadge }: MobileMapCardProps) {
  const mainImage = lot.photos[0]?.url || "/placeholder-lot.jpg";
  const price = lot.pricing?.minPrice ?? 0;
  // Headline = the whole stay for the searched dates, taxes and our service fee
  // included, before optional protection or a promo (see lot-card.tsx).
  const grandTotal = customerTotalFromPricing(lot.pricing);
  const perDay = customerPerDayFromPricing(lot.pricing);
  const topAmenities = amenitiesBesideShuttle(lot.amenities, lot.shuttleInfo?.summary).slice(0, 3);
  const minStay = unmetMinimumStay(lot);
  const showsShuttle = shuttleLabel(shuttleStatus(lot.shuttleInfo?.summary)) !== null;

  return (
    <div
      onClick={() => onSelect(lot)}
      className="flex-shrink-0 w-[88vw] snap-center bg-white rounded-2xl shadow-xl border border-gray-100 overflow-hidden"
    >
      {/* Top row: Image + Info */}
      <div className="flex p-3 gap-3">
        {/* Thumbnail */}
        <div className="w-24 h-24 relative flex-shrink-0 rounded-xl overflow-hidden">
          <Image
            src={mainImage}
            alt={lot.name}
            fill
            className="object-cover"
            sizes="96px"
          />
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0 flex flex-col justify-between">
          <div>
            <LotBadges badges={lot.badges} className="mb-1" />
            <h3 className="font-bold text-gray-900 text-base leading-snug line-clamp-2">
              {lot.name}
            </h3>
            <div className="flex items-center text-gray-500 text-xs mt-1">
              <MapPin size={12} className="mr-1 flex-shrink-0 text-brand-orange" />
              <span className="truncate">
                {lot.distanceFromAirport !== undefined
                  ? `${lot.distanceFromAirport.toFixed(1)} mi from airport`
                  : lot.address}
              </span>
            </div>
            {extraBadge}
          </div>

          {/* Price */}
          {grandTotal !== null ? (
            <div className="mt-1">
              <div className="flex items-baseline gap-1.5">
                <span className="text-xl font-bold text-gray-900">
                  ${grandTotal.toFixed(2)}
                </span>
                {perDay !== null && (
                  <span className="text-xs text-gray-500">${perDay.toFixed(2)}/day</span>
                )}
              </div>
              <TaxesAndFeesIncluded className="text-[11px]" />
            </div>
          ) : (
            <div className="flex items-baseline gap-1 mt-1">
              <span className="text-xl font-bold text-gray-900">
                ${price.toFixed(2)}
              </span>
              <span className="text-xs text-gray-500">/day</span>
            </div>
          )}
          {/* Same small notes as the list card (lot-card.tsx). */}
          {lot.dueAtLocation && (
            <div className="flex items-center gap-1 text-[10px] text-amber-700 font-medium mt-0.5">
              <Wallet size={10} aria-hidden />
              Pay at Location
            </div>
          )}
          {minStay !== null && (
            <div className="text-[10px] text-red-600 font-medium mt-0.5">Minimum {minStay} days</div>
          )}
        </div>
      </div>

      {/* Amenity tags, shuttle first (same chip style) */}
      {(topAmenities.length > 0 || showsShuttle) && (
        <div className="flex gap-1.5 flex-wrap px-3">
          <ShuttleChip
            shuttleInfo={lot.shuttleInfo}
            className="inline-flex items-center gap-1 text-[11px] text-gray-600 bg-gray-100 px-2 py-1 rounded-full"
          />
          {topAmenities.map((a) => {
            const icon = getTopAmenityIcon(a.displayName);
            return (
              <span
                key={a.id}
                className="inline-flex items-center gap-1 text-[11px] text-gray-600 bg-gray-100 px-2 py-1 rounded-full"
              >
                {icon}
                {a.displayName}
              </span>
            );
          })}
        </div>
      )}

      {/* Book button */}
      <div className="px-3 pb-3 pt-2">
        <button className="w-full bg-brand-orange text-white text-sm font-bold py-2.5 rounded-lg">
          Book Now
        </button>
      </div>
    </div>
  );
}
