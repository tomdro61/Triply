"use client";

import { Marker } from "react-map-gl/mapbox";
import { MapPin } from "lucide-react";

interface PriceMarkerProps {
  id: string;
  longitude: number;
  latitude: number;
  /** Per-day price to label the pin with; null shows the pin without a label. */
  price: number | null;
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
          {price !== null && (
            <>
              <div
                className={`px-3 py-1.5 rounded-lg shadow-md font-bold text-xs whitespace-nowrap mb-1 transition-colors border ${
                  // Navy tag, orange when hovered/selected: a white tag disappeared
                  // into Mapbox Standard's pale background.
                  isHovered
                    ? "bg-brand-orange text-white border-brand-orange"
                    : "bg-brand-dark text-white border-brand-dark"
                }`}
              >
                ${price.toFixed(2)}
              </div>
              <div
                className={`w-3 h-3 rotate-45 transform -mt-2.5 border-r border-b ${
                  isHovered ? "bg-brand-orange border-brand-orange" : "bg-brand-dark border-brand-dark"
                }`}
              />
            </>
          )}
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
