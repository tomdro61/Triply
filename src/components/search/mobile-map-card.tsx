"use client";

import Image from "next/image";
import { MapPin, Bus, Shield, Warehouse, Sun } from "lucide-react";
import { UnifiedLot } from "@/types/lot";

interface MobileMapCardProps {
  lot: UnifiedLot;
  onSelect: (lot: UnifiedLot) => void;
}

function getTopAmenityIcon(name: string) {
  const key = name.toLowerCase();
  if (key.includes("shuttle")) return <Bus size={12} className="text-green-600" />;
  if (key.includes("security") || key.includes("guarded")) return <Shield size={12} className="text-blue-600" />;
  if (key.includes("covered") || key.includes("garage")) return <Warehouse size={12} className="text-blue-500" />;
  if (key.includes("outdoor") || key.includes("surface")) return <Sun size={12} className="text-orange-500" />;
  return null;
}

export function MobileMapCard({ lot, onSelect }: MobileMapCardProps) {
  const mainImage = lot.photos[0]?.url || "/placeholder-lot.jpg";
  const price = lot.pricing?.minPrice ?? 0;
  const grandTotal = lot.pricing?.grandTotal;
  const topAmenities = lot.amenities.slice(0, 3);

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
          </div>

          {/* Price */}
          <div className="flex items-baseline gap-1 mt-1">
            <span className="text-xl font-bold text-gray-900">
              ${price.toFixed(2)}
            </span>
            <span className="text-xs text-gray-500">/day</span>
            {grandTotal != null && (
              <span className="text-xs text-gray-400 ml-1">
                ${grandTotal.toFixed(2)} total
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Amenity tags */}
      {topAmenities.length > 0 && (
        <div className="flex gap-1.5 flex-wrap px-3">
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
