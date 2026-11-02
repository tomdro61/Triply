"use client";

/**
 * The /park-stay map (CX plan v2 §3): MapboxMap and AirportMarker as on the
 * parking page, a ParkStayPriceMarker per hotel at ITS OWN lot, labelled with
 * the package total. Load it through LazyParkStayMap — mapbox-gl must stay
 * out of the page's first-load bundle (lazy-search-map.tsx).
 *
 * `pins` and `airport` must be referentially stable (memoised by the caller):
 * the view is re-fitted whenever either changes, and a new array on every
 * hover would re-fit on every hover.
 */

import { useCallback, useEffect, useRef } from "react";
import type { MapRef } from "react-map-gl/mapbox";
import { MapboxMap } from "@/components/map/mapbox-map";
import { AirportMarker } from "@/components/map/airport-marker";
import { DEFAULT_MAP_CONFIG } from "@/lib/mapbox/config";
import { ParkStayPriceMarker } from "./park-stay-price-marker";
import { parkStayMapView, type MapPoint } from "./map-view";

export interface ParkStayPin extends MapPoint {
  key: string;
  name: string;
  /** Already formatted (formatCents of the package total). */
  label: string;
}

export interface ParkStayMapProps {
  pins: readonly ParkStayPin[];
  airport: (MapPoint & { code: string }) | null;
  hoveredKey: string | null;
  onHover: (key: string | null) => void;
  onSelect: (key: string) => void;
  showControls?: boolean;
}

export function ParkStayMap({ pins, airport, hoveredKey, onHover, onSelect, showControls = true }: ParkStayMapProps) {
  const mapRef = useRef<MapRef>(null);

  const applyView = useCallback(() => {
    const map = mapRef.current;
    const view = parkStayMapView(pins, airport);
    if (!map || !view) return;
    if (view.kind === "bounds") {
      map.fitBounds(view.bounds, { padding: DEFAULT_MAP_CONFIG.fitBoundsPadding, duration: 500, maxZoom: view.maxZoom });
    } else {
      map.easeTo({ center: [view.longitude, view.latitude], zoom: view.zoom, duration: 500 });
    }
  }, [pins, airport]);

  useEffect(() => {
    applyView();
  }, [applyView]);

  return (
    <MapboxMap ref={mapRef} onLoad={applyView} showControls={showControls}>
      {airport && <AirportMarker longitude={airport.longitude} latitude={airport.latitude} code={airport.code} />}
      {pins.map((p) => (
        <ParkStayPriceMarker
          key={p.key}
          id={p.key}
          longitude={p.longitude}
          latitude={p.latitude}
          label={p.label}
          name={p.name}
          isHovered={hoveredKey === p.key}
          onHover={onHover}
          onClick={() => onSelect(p.key)}
        />
      ))}
    </MapboxMap>
  );
}
