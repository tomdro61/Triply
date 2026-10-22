export const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN || "";

// Mapbox's full-colour street map (was light-v11, grey and white). Used by
// every map: search, lot page, Park & Stay.
export const MAPBOX_STYLE = "mapbox://styles/mapbox/streets-v12";

export const DEFAULT_MAP_CONFIG = {
  // New York area as default center (MVP is JFK + LGA)
  defaultCenter: { latitude: 40.6413, longitude: -73.7781 } as const,
  defaultZoom: 11,
  lotDetailZoom: 14,
  minZoom: 8,
  maxZoom: 18,
  fitBoundsPadding: { top: 50, bottom: 50, left: 50, right: 50 },
};
