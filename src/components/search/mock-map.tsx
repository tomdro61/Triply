"use client";

import { MapPin } from "lucide-react";
import { UnifiedLot } from "@/types/lot";

interface MockMapProps {
  lots: UnifiedLot[];
  hoveredId: string | null;
  onHover: (id: string | null) => void;
  onSelect: (lot: UnifiedLot) => void;
}

export function MockMap({ lots, hoveredId, onHover, onSelect }: MockMapProps) {
  // Calculate bounds to normalize positions
  const lats = lots.map((l) => l.latitude).filter((l) => l !== 0);
  const lngs = lots.map((l) => l.longitude).filter((l) => l !== 0);

  // Default fallback if no coords
  if (lats.length === 0) {
    return (
      <div className="w-full h-full bg-gray-100 flex items-center justify-center text-gray-400">
        Map View Unavailable
      </div>
    );
  }

  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);

  // Add padding to bounds
  const latSpan = maxLat - minLat || 0.01;
  const lngSpan = maxLng - minLng || 0.01;

  return (
    <div className="w-full h-full relative bg-[#e5e7eb] overflow-hidden group">
      {/* Mock Map Background Texture */}
      <div
        className="absolute inset-0 opacity-30"
        style={{
          backgroundImage: "radial-gradient(#9ca3af 1px, transparent 1px)",
          backgroundSize: "20px 20px",
        }}
      />

      {/* Mock Roads/Rivers (Purely decorative CSS shapes) */}
      <div className="absolute top-1/2 left-0 w-full h-4 bg-white rotate-3 opacity-60" />
      <div className="absolute top-0 left-1/3 w-4 h-full bg-white rotate-12 opacity-60" />

      {/* Pins */}
      {lots.map((lot) => {
        if (!lot.latitude || !lot.longitude) return null;

        // Normalize to percentage (invert lat for Y axis)
        const y = ((maxLat - lot.latitude) / latSpan) * 80 + 10;
        const x = ((lot.longitude - minLng) / lngSpan) * 80 + 10;

        const isHovered = hoveredId === lot.id;
        const price = lot.pricing?.minPrice ?? 0;

        return (
          <div
            key={lot.id}
            className={`absolute transform -translate-x-1/2 -translate-y-1/2 cursor-pointer transition-all duration-300 z-10 ${
              isHovered ? "z-20 scale-110" : ""
            }`}
            style={{ top: `${y}%`, left: `${x}%` }}
            onMouseEnter={() => onHover(lot.id)}
            onMouseLeave={() => onHover(null)}
            onClick={() => onSelect(lot)}
          >
            <div className="relative flex flex-col items-center group">
              <div
                className={`px-3 py-1.5 rounded-lg shadow-md font-bold text-xs whitespace-nowrap mb-1 transition-colors border ${
                  isHovered
                    ? "bg-brand-dark text-white border-brand-dark"
                    : "bg-white text-gray-900 border-gray-200"
                }`}
              >
                ${price}
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
        );
      })}

      {/* Map Controls Mock */}
      <div className="absolute bottom-6 right-6 flex flex-col space-y-2">
        <button className="bg-white p-2 rounded shadow text-gray-600 hover:text-black font-bold">
          +
        </button>
        <button className="bg-white p-2 rounded shadow text-gray-600 hover:text-black font-bold">
          -
        </button>
      </div>

      {/* Mapbox Attribution Placeholder */}
      <div className="absolute bottom-2 left-2 text-[10px] text-gray-500">
        Map powered by Mapbox (Demo Mode)
      </div>
    </div>
  );
}
