"use client";

import Image from "next/image";
import {
  Star,
  MapPin,
  Check,
  X,
  Sun,
  Warehouse,
  Key,
  Wallet,
  Bus,
  Shield,
  Car,
  Zap,
  Accessibility,
  Clock,
  Camera,
  Fence,
} from "lucide-react";
import { UnifiedLot } from "@/types/lot";

interface LotCardProps {
  lot: UnifiedLot;
  isHovered: boolean;
  onHover: (id: string | null) => void;
  onSelect: (lot: UnifiedLot) => void;
}

export function LotCard({ lot, isHovered, onHover, onSelect }: LotCardProps) {
  const getAmenityConfig = (name: string) => {
    const key = name.toLowerCase().replace(/\s+/g, "_").replace(/-/g, "_");

    // Shuttle related
    if (key.includes("shuttle") || key.includes("free_shuttle")) {
      if (key.includes("no_shuttle") || key.includes("no shuttle")) {
        return { label: "No Shuttle", icon: <X size={14} className="text-red-500" /> };
      }
      return { label: "Free Shuttle", icon: <Bus size={14} className="text-green-600" /> };
    }

    // Security related
    if (key.includes("security") || key.includes("secure") || key.includes("guarded") || key.includes("attendant")) {
      return { label: "Security", icon: <Shield size={14} className="text-blue-600" /> };
    }

    // Parking type
    if (key.includes("covered") || key.includes("indoor") || key.includes("garage")) {
      return { label: "Covered", icon: <Warehouse size={14} className="text-blue-500" /> };
    }
    if (key.includes("outdoor") || key.includes("open_air") || key.includes("surface")) {
      return { label: "Outdoor", icon: <Sun size={14} className="text-orange-500" /> };
    }
    if (key.includes("valet")) {
      return { label: "Valet", icon: <Key size={14} className="text-purple-500" /> };
    }
    if (key.includes("self_park") || key.includes("self-park")) {
      return { label: "Self-Park", icon: <Car size={14} className="text-gray-600" /> };
    }

    // EV charging
    if (key.includes("ev") || key.includes("electric") || key.includes("charging")) {
      return { label: "EV Charging", icon: <Zap size={14} className="text-green-500" /> };
    }

    // Accessibility
    if (key.includes("handicap") || key.includes("accessible") || key.includes("ada")) {
      return { label: "Accessible", icon: <Accessibility size={14} className="text-blue-600" /> };
    }

    // 24 hour
    if (key.includes("24") || key.includes("hour") || key.includes("always_open")) {
      return { label: "24/7 Access", icon: <Clock size={14} className="text-gray-600" /> };
    }

    // Surveillance
    if (key.includes("camera") || key.includes("surveillance") || key.includes("cctv")) {
      return { label: "Surveillance", icon: <Camera size={14} className="text-gray-600" /> };
    }

    // Fenced
    if (key.includes("fence") || key.includes("gated")) {
      return { label: "Fenced", icon: <Fence size={14} className="text-gray-600" /> };
    }

    // Default - show the display name with a check icon
    return { label: name, icon: <Check size={14} className="text-green-500" /> };
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
              {lot.distanceFromAirport !== undefined
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
              ${price.toFixed(2)}
              <span className="text-xs text-gray-500 font-normal">/day</span>
            </div>
            {lot.pricing?.grandTotal && (
              <div className="text-xs text-gray-500 font-medium">
                ${lot.pricing.grandTotal.toFixed(2)} total
              </div>
            )}
            {lot.dueAtLocation && (
              <div className="flex items-center justify-end gap-1 text-[10px] text-amber-700 font-medium mt-1">
                <Wallet size={10} />
                Pay at Location
              </div>
            )}
          </div>
        </div>

        {/* Amenities */}
        {lot.amenities.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-2 mb-3">
            {lot.amenities.slice(0, 4).map((amenity) => {
              const config = getAmenityConfig(amenity.displayName);
              return (
                <div
                  key={amenity.id}
                  className="inline-flex items-center px-2.5 py-1 bg-white border border-gray-200 rounded-full text-xs text-gray-700 font-medium"
                >
                  <span className="mr-1.5">{config.icon}</span>
                  <span>{config.label}</span>
                </div>
              );
            })}
            {lot.amenities.length > 4 && (
              <div className="inline-flex items-center px-2.5 py-1 bg-gray-100 border border-gray-200 rounded-full text-xs text-gray-500 font-medium">
                +{lot.amenities.length - 4} more
              </div>
            )}
          </div>
        )}

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

          <button
            onClick={() => onSelect(lot)}
            className="bg-brand-orange text-white text-sm font-bold px-4 py-2 rounded-lg hover:bg-orange-600 transition-colors shadow-sm"
          >
            View Details
          </button>
        </div>
      </div>
    </div>
  );
}
