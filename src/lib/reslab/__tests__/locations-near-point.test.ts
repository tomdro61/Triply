import { describe, it, expect } from "vitest";
import { locationsNearPoint, AIRPORT_SEARCH_RADIUS_KM } from "../search";
import type { ReslabLocation } from "../client";

const JFK = { lat: 40.6413, lng: -73.7781 };
function at(id: number, latitude: string, longitude = String(JFK.lng)): ReslabLocation {
  return { id, name: `Lot ${id}`, latitude, longitude } as ReslabLocation;
}

describe("locationsNearPoint (search + sitemap radius)", () => {
  // 0.126° of latitude ≈ 14 km; 0.18° ≈ 20 km — 12.4 mi, which would be
  // inside the radius if the km value were wrongly compared as miles.
  const near = at(1, String(JFK.lat + 0.126));
  const far = at(2, String(JFK.lat + 0.18));

  it("includes a lot ~14 km away and excludes one ~20 km away at the 15 km radius", () => {
    const ids = locationsNearPoint([near, far], JFK.lat, JFK.lng, AIRPORT_SEARCH_RADIUS_KM).map((l) => l.id);
    expect(ids).toEqual([1]);
  });

  it("a wider radius includes the farther lot", () => {
    expect(locationsNearPoint([near, far], JFK.lat, JFK.lng, 30).map((l) => l.id)).toEqual([1, 2]);
  });

  it("drops lots with unparseable coordinates", () => {
    expect(locationsNearPoint([at(3, "abc")], JFK.lat, JFK.lng, AIRPORT_SEARCH_RADIUS_KM)).toEqual([]);
  });
});
