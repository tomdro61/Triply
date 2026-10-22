"use client";

import { Marker } from "react-map-gl/mapbox";

/**
 * A Park & Stay map pin: PriceMarker's look, but it shows a label it is
 * GIVEN (the package total, already formatted from cents). PriceMarker
 * formats dollars with toFixed(2), which is the wrong unit here, so it is not
 * reused (CX plan v2 §3).
 */
export function ParkStayPriceMarker({
  id,
  longitude,
  latitude,
  label,
  name,
  isHovered,
  onHover,
  onClick,
}: {
  id: string;
  longitude: number;
  latitude: number;
  label: string;
  /** For the accessible name: "<hotel>, <price>". */
  name: string;
  isHovered: boolean;
  onHover: (id: string | null) => void;
  onClick: () => void;
}) {
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
        role="button"
        tabIndex={0}
        aria-label={`${name}, ${label}`}
        className={`cursor-pointer origin-bottom transition-all duration-300 ${isHovered ? "scale-110" : ""}`}
        onMouseEnter={() => onHover(id)}
        onMouseLeave={() => onHover(null)}
        onFocus={() => onHover(id)}
        onBlur={() => onHover(null)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onClick();
          }
        }}
      >
        <div className="group relative flex flex-col items-center">
          <div
            className={`mb-1 whitespace-nowrap rounded-lg border px-3 py-1.5 text-xs font-bold shadow-md transition-colors ${
              isHovered ? "border-brand-orange bg-brand-orange text-white" : "border-brand-dark bg-brand-dark text-white"
            }`}
          >
            {label}
          </div>
          {/* The tag's pointer marks the lot (anchor="bottom") — no separate pin, same as parking. */}
          <div className={`-mt-2.5 h-3 w-3 rotate-45 transform border-b border-r ${isHovered ? "border-brand-orange bg-brand-orange" : "border-brand-dark bg-brand-dark"}`} />
        </div>
      </div>
    </Marker>
  );
}
