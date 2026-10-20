import { describe, expect, it } from "vitest";
import { PARK_STAY_MAP_AIRPORT_ZOOM, PARK_STAY_MAP_MAX_FIT_ZOOM, parkStayMapView } from "../map-view";

const JFK = { latitude: 40.6413, longitude: -73.7781 };
const doubletree = { latitude: 40.6673095, longitude: -73.7984598 };
const hampton = { latitude: 40.667479, longitude: -73.7949621 };

describe("the Park & Stay map view (CX plan v2 §3 states)", () => {
  it("pins: fits the pins and the airport, capped at a minimum zoom-out", () => {
    expect(parkStayMapView([doubletree, hampton], JFK)).toEqual({
      kind: "bounds",
      bounds: [
        [doubletree.longitude, JFK.latitude],
        [JFK.longitude, hampton.latitude],
      ],
      maxZoom: PARK_STAY_MAP_MAX_FIT_ZOOM,
    });
  });

  it("one pin: still the pin AND the airport, still capped", () => {
    const v = parkStayMapView([doubletree], JFK);
    expect(v?.kind).toBe("bounds");
    if (v?.kind === "bounds") {
      expect(v.bounds[0][1]).toBe(JFK.latitude);
      expect(v.bounds[1][1]).toBe(doubletree.latitude);
      expect(v.maxZoom).toBe(PARK_STAY_MAP_MAX_FIT_ZOOM);
    }
  });

  it("no pins: the airport alone", () => {
    expect(parkStayMapView([], JFK)).toEqual({ kind: "center", longitude: JFK.longitude, latitude: JFK.latitude, zoom: PARK_STAY_MAP_AIRPORT_ZOOM });
  });

  it("unusable points are ignored; nothing known → null", () => {
    expect(parkStayMapView([{ latitude: 0, longitude: 0 }, { latitude: Number.NaN, longitude: 1 }], JFK)?.kind).toBe("center");
    expect(parkStayMapView([], null)).toBeNull();
  });
});
