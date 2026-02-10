"use client";

import { Marker } from "react-map-gl/mapbox";
import { MapPin } from "lucide-react";

interface PriceMarkerProps {
  id: string;
  longitude: number;
  latitude: number;
  price: number;
  isHovered: boolean;
  onHover: (id: string | null) => void;
  onClick: () => void;
}

export function PriceMarker({
  id,
  longitude,
  latitude,
  price,
  isHovered,
  onHover,
  onClick,
}: PriceMarkerProps) {
  return (
    <Marker
      longitude={longitude}
      latitude={latitude}
      anchor="bottom"
      style={{ zIndex: isHovered ? 20 : 10 }}
      onClick={(e) => {
        e.originalEvent.stopPropagation();
        onClick();
      }}
    >
      <div
        className={`cursor-pointer transition-all duration-300 ${
          isHovered ? "scale-110" : ""
        }`}
        onMouseEnter={() => onHover(id)}
        onMouseLeave={() => onHover(null)}
      >
        <div className="relative flex flex-col items-center group">
          <div
            className={`px-3 py-1.5 rounded-lg shadow-md font-bold text-xs whitespace-nowrap mb-1 transition-colors border ${
              isHovered
                ? "bg-brand-dark text-white border-brand-dark"
                : "bg-white text-gray-900 border-gray-200"
            }`}
          >
            ${price.toFixed(2)}
          </div>
          <div
            className={`w-3 h-3 rotate-45 transform -mt-2.5 ${
              isHovered ? "bg-brand-dark" : "bg-white"
            } border-r border-b border-gray-200`}
          />
          <MapPin
            size={isHovered ? 28 : 24}
            className={`drop-shadow-md -mt-1 transition-colors ${
              isHovered
                ? "text-brand-orange fill-brand-orange"
                : "text-brand-blue fill-brand-blue"
            }`}
          />
        </div>
      </div>
    </Marker>
  );
}
