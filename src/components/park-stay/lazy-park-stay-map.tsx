"use client";

import dynamic from "next/dynamic";
import { MapPlaceholder } from "@/components/map/map-placeholder";

/**
 * ParkStayMap, loaded on demand — the lazy-search-map.tsx pattern: mapbox-gl
 * (~450 KB) is fetched the first time a map actually renders, not with the
 * page. (No chunk-name hint: Turbopack ignores it, and there is no
 * service-worker precache to exclude it from — CX plan §12.5, R12-H1.)
 */
export const LazyParkStayMap = dynamic(
  () => import("./park-stay-map").then((m) => m.ParkStayMap),
  {
    ssr: false,
    loading: () => <MapPlaceholder />,
  }
);
