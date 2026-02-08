"use client";

import { forwardRef, useRef, useImperativeHandle } from "react";
import Map, { MapRef, NavigationControl } from "react-map-gl/mapbox";
import "mapbox-gl/dist/mapbox-gl.css";
import {
  MAPBOX_TOKEN,
  MAPBOX_STYLE,
  DEFAULT_MAP_CONFIG,
} from "@/lib/mapbox/config";

interface MapboxMapProps {
  children?: React.ReactNode;
  initialViewState?: {
    longitude: number;
    latitude: number;
    zoom: number;
  };
  interactive?: boolean;
  showControls?: boolean;
  style?: React.CSSProperties;
  className?: string;
  onLoad?: () => void;
}

export const MapboxMap = forwardRef<MapRef, MapboxMapProps>(
  function MapboxMap(
    {
      children,
      initialViewState,
      interactive = true,
      showControls = true,
      style,
      className,
      onLoad,
    },
    ref
  ) {
    const mapRef = useRef<MapRef>(null);
    useImperativeHandle(ref, () => mapRef.current!);

    if (!MAPBOX_TOKEN) {
      return (
        <div
          className={`w-full h-full bg-gray-100 flex items-center justify-center text-gray-400 ${className || ""}`}
        >
          Map unavailable (no token configured)
        </div>
      );
    }

    return (
      <Map
        ref={mapRef}
        mapboxAccessToken={MAPBOX_TOKEN}
        initialViewState={
          initialViewState || {
            longitude: DEFAULT_MAP_CONFIG.defaultCenter.longitude,
            latitude: DEFAULT_MAP_CONFIG.defaultCenter.latitude,
            zoom: DEFAULT_MAP_CONFIG.defaultZoom,
          }
        }
        style={style || { width: "100%", height: "100%" }}
        mapStyle={MAPBOX_STYLE}
        interactive={interactive}
        minZoom={DEFAULT_MAP_CONFIG.minZoom}
        maxZoom={DEFAULT_MAP_CONFIG.maxZoom}
        attributionControl={true}
        onLoad={onLoad}
        reuseMaps
      >
        {showControls && interactive && (
          <NavigationControl position="bottom-right" showCompass={false} />
        )}
        {children}
      </Map>
    );
  }
);
