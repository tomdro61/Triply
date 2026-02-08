export const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN || "";

export const MAPBOX_STYLE = "mapbox://styles/mapbox/light-v11";

export const DEFAULT_MAP_CONFIG = {
  // New York area as default center (MVP is JFK + LGA)
  defaultCenter: { latitude: 40.6413, longitude: -73.7781 } as const,
  defaultZoom: 11,
  lotDetailZoom: 14,
  minZoom: 8,
  maxZoom: 18,
  fitBoundsPadding: { top: 50, bottom: 50, left: 50, right: 50 },
};
