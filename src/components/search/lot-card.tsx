"use client";

import Image from "next/image";
import { Star, MapPin, Check, X, Sun, Warehouse, Key } from "lucide-react";
import { UnifiedLot } from "@/types/lot";

interface LotCardProps {
  lot: UnifiedLot;
  isHovered: boolean;
  onHover: (id: string | null) => void;
  onSelect: (lot: UnifiedLot) => void;
}

export function LotCard({ lot, isHovered, onHover, onSelect }: LotCardProps) {
  const getAmenityConfig = (name: string) => {
    const key = name.toLowerCase().replace(/\s+/g, "_");
    switch (key) {
      case "shuttle":
      case "free_shuttle":
        return {
          label: "Free Shuttle",
          icon: <Check size={14} className="text-green-600" />,
        };
      case "no_shuttle":
        return {
          label: "No Shuttle",
          icon: <X size={14} className="text-red-500" />,
        };
      case "outdoor_self":
      case "outdoor":
        return {
          label: "Outdoor Self-Park",
          icon: <Sun size={14} className="text-orange-500" />,
        };
      case "covered_self":
      case "covered":
        return {
          label: "Covered Self-Park",
          icon: <Warehouse size={14} className="text-blue-500" />,
        };
      case "outdoor_valet":
      case "valet":
        return {
          label: "Valet",
          icon: <Key size={14} className="text-purple-500" />,
        };
      default:
        return {
          label: name,
          icon: <Check size={14} className="text-gray-500" />,
        };
    }
  };

  const mainImage = lot.photos[0]?.url || "/placeholder-lot.jpg";
  const price = lot.pricing?.minPrice ?? 0;
  const originalPrice = lot.pricing?.parkingTypes[0]?.originalPrice;

  return (
    <div
      className={`group bg-white rounded-xl border transition-all duration-300 flex flex-col sm:flex-row overflow-hidden hover:shadow-lg ${
        isHovered
          ? "ring-2 ring-brand-orange border-transparent shadow-lg"
          : "border-gray-200 shadow-sm"
      }`}
      onMouseEnter={() => onHover(lot.id)}
      onMouseLeave={() => onHover(null)}
    >
      {/* Image */}
      <div className="sm:w-48 sm:h-auto h-48 relative flex-shrink-0">
        <Image
          src={mainImage}
          alt={lot.name}
          fill
          className="object-cover"
          sizes="(max-width: 640px) 100vw, 192px"
        />
        {lot.availability === "limited" && (
          <div className="absolute top-2 left-2 bg-amber-500 text-white text-[10px] font-bold px-2 py-1 rounded shadow-sm uppercase tracking-wide">
            Limited
          </div>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 p-4 flex flex-col">
        {/* Header Row */}
        <div className="flex justify-between items-start mb-1">
          <div>
            <h3 className="font-bold text-gray-900 text-lg leading-tight">
              {lot.name}
            </h3>
            <div className="flex items-center text-gray-500 text-xs mt-1">
              <MapPin size={12} className="mr-1 text-brand-blue" />
              {lot.distanceFromAirport
                ? `${lot.distanceFromAirport.toFixed(1)} mi from airport`
                : lot.address}
            </div>
          </div>
          <div className="text-right">
            {originalPrice && (
              <div className="text-xs text-gray-400 line-through font-medium">
                ${originalPrice}
              </div>
            )}
            <div className="text-xl font-bold text-gray-900">
              ${price}
              <span className="text-xs text-gray-500 font-normal">/day</span>
            </div>
          </div>
        </div>

        {/* Amenities */}
        <div className="flex flex-wrap gap-2 mt-2 mb-3">
          {lot.amenities.slice(0, 3).map((amenity) => {
            const config = getAmenityConfig(amenity.displayName);
            return (
              <div
                key={amenity.id}
                className="inline-flex items-center px-2 py-1 bg-gray-50 border border-gray-100 rounded text-xs text-gray-600"
              >
                <span className="mr-1.5">{config.icon}</span>
                <span className="capitalize">{config.label}</span>
              </div>
            );
          })}
        </div>

        {/* Footer Row */}
        <div className="mt-auto flex items-end justify-between border-t border-gray-50 pt-3">
          <div className="flex items-center">
            {lot.rating && (
              <>
                <div className="flex items-center bg-yellow-50 px-2 py-1 rounded border border-yellow-100">
                  <Star
                    size={12}
                    className="text-yellow-400 fill-yellow-400 mr-1"
                  />
                  <span className="text-xs font-bold text-gray-800">
                    {lot.rating.toFixed(1)}
                  </span>
                </div>
                <span className="text-xs text-gray-400 ml-2">
                  ({lot.reviewCount || 0} reviews)
                </span>
              </>
            )}
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={() => onSelect(lot)}
              className="text-sm font-semibold text-brand-orange hover:text-orange-600 transition-colors"
            >
              View Details
            </button>
            <button
              onClick={() => onSelect(lot)}
              className="bg-brand-orange text-white text-sm font-bold px-4 py-2 rounded-lg hover:bg-orange-600 transition-colors shadow-sm"
            >
              Book Now
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
