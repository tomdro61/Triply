"use client";

import { Marker } from "react-map-gl/mapbox";
import { MapPin } from "lucide-react";

interface LotMarkerProps {
  longitude: number;
  latitude: number;
  name: string;
}

export function LotMarker({ longitude, latitude, name }: LotMarkerProps) {
  return (
    <Marker longitude={longitude} latitude={latitude} anchor="bottom">
      <div className="relative flex flex-col items-center">
        <div className="px-3 py-1.5 rounded-lg shadow-md font-bold text-xs whitespace-nowrap mb-1 bg-brand-dark text-white border-brand-dark">
          {name}
        </div>
        <div className="w-3 h-3 rotate-45 transform -mt-2.5 bg-brand-dark border-r border-b border-brand-dark" />
        <MapPin
          size={28}
          className="text-brand-orange fill-brand-orange drop-shadow-md -mt-1"
        />
      </div>
    </Marker>
  );
}
