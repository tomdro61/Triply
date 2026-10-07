"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { MapPlaceholder } from "@/components/map/map-placeholder";
import { DEFAULT_MAP_CONFIG } from "@/lib/mapbox/config";

// mapbox-gl is ~450 KB; the lot page used to download it on load even though
// the map sits below the fold. It now loads when the map is about to scroll
// into view.
const LotMap = dynamic(() => import("./lot-map"), {
  ssr: false,
  loading: () => <MapPlaceholder />,
});

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
  const containerRef = useRef<HTMLDivElement>(null);
  const [nearViewport, setNearViewport] = useState(false);
  const hasCoords = Boolean(latitude && longitude);

  useEffect(() => {
    if (!hasCoords || nearViewport) return;
    const el = containerRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setNearViewport(true);
          observer.disconnect();
        }
      },
      // Start loading a little before it is on screen.
      { rootMargin: "300px 0px" }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasCoords, nearViewport]);

  if (!hasCoords) {
    return (
      <div className="w-full h-64 bg-gray-200 rounded-xl flex items-center justify-center text-gray-400">
        Map not available
      </div>
    );
  }

  return (
    <div ref={containerRef} className="w-full h-64 rounded-xl overflow-hidden">
      {nearViewport ? (
        <LotMap
          longitude={longitude}
          latitude={latitude}
          name={name}
          zoom={DEFAULT_MAP_CONFIG.lotDetailZoom}
        />
      ) : (
        <MapPlaceholder />
      )}
    </div>
  );
}
