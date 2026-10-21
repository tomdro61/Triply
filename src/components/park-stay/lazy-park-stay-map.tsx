"use client";

import dynamic from "next/dynamic";
import { MapPlaceholder } from "@/components/map/map-placeholder";

/**
 * ParkStayMap, loaded on demand — the lazy-search-map.tsx pattern: mapbox-gl
 * (~450 KB) is fetched the first time a map actually renders, not with the
 * page. The chunk-name hint carries the `park-stay-` prefix the plan's
 * service-worker precache exclusion is keyed on (CX plan v2 §1; that
 * exclusion lands with PR B, and Turbopack ignores the hint today).
 */
export const LazyParkStayMap = dynamic(
  () => import(/* webpackChunkName: "park-stay-map" */ "./park-stay-map").then((m) => m.ParkStayMap),
  {
    ssr: false,
    loading: () => <MapPlaceholder />,
  }
);
