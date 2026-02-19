"use client";

import { useRef, useCallback, useEffect } from "react";
import type { MapRef } from "react-map-gl/mapbox";
import { MapboxMap, PriceMarker, AirportMarker } from "@/components/map";
import { UnifiedLot } from "@/types/lot";
import { Airport } from "@/config/airports";
import { DEFAULT_MAP_CONFIG } from "@/lib/mapbox/config";

interface SearchMapProps {
  lots: UnifiedLot[];
  hoveredId: string | null;
  onHover: (id: string | null) => void;
  onSelect: (lot: UnifiedLot) => void;
  showControls?: boolean;
  airport?: Airport;
}

export function SearchMap({
  lots,
  hoveredId,
  onHover,
  onSelect,
  showControls = true,
  airport,
}: SearchMapProps) {
  const mapRef = useRef<MapRef>(null);

  const fitBounds = useCallback(() => {
    const map = mapRef.current;
    if (!map || lots.length === 0) return;

    const lats = lots.map((l) => l.latitude).filter((l) => l !== 0);
    const lngs = lots.map((l) => l.longitude).filter((l) => l !== 0);

    // Include airport coordinates in bounds
    if (airport) {
      lats.push(airport.latitude);
      lngs.push(airport.longitude);
    }

    if (lats.length === 0 || lngs.length === 0) return;

    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);
    const minLng = Math.min(...lngs);
    const maxLng = Math.max(...lngs);

    map.fitBounds(
      [
        [minLng, minLat],
        [maxLng, maxLat],
      ],
      {
        padding: DEFAULT_MAP_CONFIG.fitBoundsPadding,
        duration: 500,
      }
    );
  }, [lots, airport]);

  useEffect(() => {
    fitBounds();
  }, [fitBounds]);

  const hasCoords = lots.some((l) => l.latitude !== 0 && l.longitude !== 0);
  if (!hasCoords && lots.length > 0) {
    return (
      <div className="w-full h-full bg-gray-100 flex items-center justify-center text-gray-400">
        Map View Unavailable
      </div>
    );
  }

  return (
    <MapboxMap ref={mapRef} onLoad={fitBounds} showControls={showControls}>
      {airport && (
        <AirportMarker
          longitude={airport.longitude}
          latitude={airport.latitude}
          code={airport.code}
        />
      )}
      {lots.map((lot) => {
        if (!lot.latitude || !lot.longitude) return null;
        const price = lot.pricing?.minPrice ?? 0;

        return (
          <PriceMarker
            key={lot.id}
            id={lot.id}
            longitude={lot.longitude}
            latitude={lot.latitude}
            price={price}
            isHovered={hoveredId === lot.id}
            onHover={onHover}
            onClick={() => onSelect(lot)}
          />
        );
      })}
    </MapboxMap>
  );
}
