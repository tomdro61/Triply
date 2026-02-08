"use client";

import { MapboxMap, LotMarker } from "@/components/map";
import { DEFAULT_MAP_CONFIG } from "@/lib/mapbox/config";

interface LotLocationMapProps {
  longitude: number;
  latitude: number;
  name: string;
}

export function LotLocationMap({
  longitude,
  latitude,
  name,
}: LotLocationMapProps) {
  if (!latitude || !longitude) {
    return (
      <div className="w-full h-64 bg-gray-200 rounded-xl flex items-center justify-center text-gray-400">
        Map not available
      </div>
    );
  }

  return (
    <div className="w-full h-64 rounded-xl overflow-hidden">
      <MapboxMap
        initialViewState={{
          longitude,
          latitude,
          zoom: DEFAULT_MAP_CONFIG.lotDetailZoom,
        }}
        interactive={false}
        showControls={false}
      >
        <LotMarker longitude={longitude} latitude={latitude} name={name} />
      </MapboxMap>
    </div>
  );
}
