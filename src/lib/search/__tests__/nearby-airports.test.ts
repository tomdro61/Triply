import { describe, it, expect } from "vitest";
import { nearbyAirports, NEARBY_MAX_MILES } from "../nearby-airports";

describe("nearbyAirports", () => {
  it("JFK: the other New York airports first", () => {
    const codes = nearbyAirports("JFK").map((x) => x.airport.code);
    expect(codes.slice(0, 2).sort()).toEqual(["EWR", "LGA"]);
    expect(codes).not.toContain("JFK");
  });

  it("closest first, never further than the cap", () => {
    const out = nearbyAirports("SLC", 5);
    expect(out.length).toBeGreaterThan(1);
    for (let i = 1; i < out.length; i++) expect(out[i].miles).toBeGreaterThanOrEqual(out[i - 1].miles);
    for (const x of out) expect(x.miles).toBeLessThanOrEqual(NEARBY_MAX_MILES);
  });

  it("never offers a seaport", () => {
    expect(nearbyAirports("FLL", 5).map((x) => x.airport.code)).not.toContain("POE");
  });

  it("unknown code → nothing", () => {
    expect(nearbyAirports("ZZZ")).toEqual([]);
  });
});
