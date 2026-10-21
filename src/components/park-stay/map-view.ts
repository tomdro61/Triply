/**
 * Where the Park & Stay map looks (CX plan v2 §3 "States"). Pure, so the
 * three states are testable without mapbox:
 *   - pins: fit the pins AND the airport, never closer than
 *     PARK_STAY_MAP_MAX_FIT_ZOOM (one hotel next to the airport would
 *     otherwise zoom to street level);
 *   - no pins: the airport alone, at PARK_STAY_MAP_AIRPORT_ZOOM;
 *   - nothing known: null (the caller leaves the map where it is).
 */

export interface MapPoint {
  latitude: number;
  longitude: number;
}

export const PARK_STAY_MAP_MAX_FIT_ZOOM = 14;
export const PARK_STAY_MAP_AIRPORT_ZOOM = 12;

export type ParkStayMapView =
  | { kind: "bounds"; bounds: [[number, number], [number, number]]; maxZoom: number }
  | { kind: "center"; longitude: number; latitude: number; zoom: number };

function usable(p: MapPoint): boolean {
  return Number.isFinite(p.latitude) && Number.isFinite(p.longitude) && !(p.latitude === 0 && p.longitude === 0);
}

export function parkStayMapView(pins: readonly MapPoint[], airport: MapPoint | null): ParkStayMapView | null {
  const shown = pins.filter(usable);
  const port = airport && usable(airport) ? airport : null;
  if (shown.length === 0) {
    return port ? { kind: "center", longitude: port.longitude, latitude: port.latitude, zoom: PARK_STAY_MAP_AIRPORT_ZOOM } : null;
  }
  const points = port ? [...shown, port] : shown;
  const lats = points.map((p) => p.latitude);
  const lngs = points.map((p) => p.longitude);
  return {
    kind: "bounds",
    bounds: [
      [Math.min(...lngs), Math.min(...lats)],
      [Math.max(...lngs), Math.max(...lats)],
    ],
    maxZoom: PARK_STAY_MAP_MAX_FIT_ZOOM,
  };
}
