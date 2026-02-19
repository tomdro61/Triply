"use client";

import { Marker } from "react-map-gl/mapbox";
import { Plane } from "lucide-react";

interface AirportMarkerProps {
  longitude: number;
  latitude: number;
  code: string;
}

export function AirportMarker({ longitude, latitude, code }: AirportMarkerProps) {
  return (
    <Marker
      longitude={longitude}
      latitude={latitude}
      anchor="center"
      style={{ zIndex: 5 }}
    >
      <div className="flex flex-col items-center">
        <div className="bg-brand-dark text-white px-2.5 py-1 rounded-md shadow-lg font-bold text-xs whitespace-nowrap flex items-center gap-1.5">
          <Plane size={14} className="fill-white" />
          {code}
        </div>
        <div className="w-2 h-2 rotate-45 bg-brand-dark -mt-1 shadow-lg" />
      </div>
    </Marker>
  );
}
