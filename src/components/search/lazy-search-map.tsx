"use client";

import dynamic from "next/dynamic";
import { MapPlaceholder } from "@/components/map/map-placeholder";

/**
 * SearchMap, loaded on demand.
 *
 * mapbox-gl is ~450 KB of JavaScript. Importing SearchMap statically put it in
 * the /search page bundle, so every phone downloaded and parsed it before the
 * results list was usable, even though phones only show the map after a tap
 * on "Map". Loading it through next/dynamic moves it to its own chunk that is
 * fetched the first time a map is actually rendered.
 */
export const LazySearchMap = dynamic(
  () => import("./search-map").then((m) => m.SearchMap),
  {
    ssr: false,
    loading: () => <MapPlaceholder />,
  }
);
