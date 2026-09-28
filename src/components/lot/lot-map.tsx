"use client";

import { MapboxMap, LotMarker } from "@/components/map";

interface LotMapProps {
  longitude: number;
  latitude: number;
  name: string;
  zoom: number;
}

/**
 * The lot page's static location map. Only ever imported dynamically (see
 * LotLocationMap) so mapbox-gl stays out of the lot page's first-load bundle.
 */
export default function LotMap({ longitude, latitude, name, zoom }: LotMapProps) {
  return (
    <MapboxMap
      initialViewState={{ longitude, latitude, zoom }}
      interactive={false}
      showControls={false}
    >
      <LotMarker longitude={longitude} latitude={latitude} name={name} />
    </MapboxMap>
  );
}
