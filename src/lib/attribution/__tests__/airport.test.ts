import { describe, it, expect } from "vitest";
import { resolveAirportCode, validCoords } from "../airport";
import { productionAirports } from "@/config/airports";

// Real lots from the bookings table.
const PARK_AC_JFK = { lat: 40.6675, lng: -73.7845 }; // ~2 mi from JFK
const HILTON_EWR = { lat: 40.6956, lng: -74.1795 };
const LIC_HOTEL = { lat: 40.75, lng: -73.95 }; // between JFK and LGA, nearer LGA
const BROADWAY_BOS = { lat: 42.3676, lng: -71.0359 };

describe("validCoords", () => {
  it("accepts numeric strings (ResLab returns strings)", () => {
    expect(validCoords("40.6413", "-73.7781")).toEqual({ lat: 40.6413, lng: -73.7781 });
  });
  it.each([
    ["NaN", "x", "y"],
    ["null island", "0", "0"],
    ["out of range", "95", "10"],
    ["undefined", undefined, undefined],
  ])("rejects %s", (_n, lat, lng) => {
    expect(validCoords(lat, lng)).toBeNull();
  });
});

describe("resolveAirportCode", () => {
  it("nearest production airport within 25 mi", () => {
    expect(resolveAirportCode({ ...PARK_AC_JFK })).toBe("JFK");
    expect(resolveAirportCode({ ...HILTON_EWR })).toBe("EWR");
    expect(resolveAirportCode({ ...BROADWAY_BOS })).toBe("BOS");
  });

  it("the searched airport wins within 40 mi — a JFK customer at a Long-Island-City lot is JFK", () => {
    expect(resolveAirportCode({ ...LIC_HOTEL })).toBe("LGA"); // nearest-wins alone mislabels
    expect(resolveAirportCode({ ...LIC_HOTEL, contextAirport: "JFK" })).toBe("JFK");
    expect(resolveAirportCode({ ...LIC_HOTEL, contextAirport: "jfk" })).toBe("JFK");
  });

  it("a stale context from another metro falls through to nearest", () => {
    expect(resolveAirportCode({ ...BROADWAY_BOS, contextAirport: "JFK" })).toBe("BOS");
  });

  it("an unknown or test context airport is ignored", () => {
    expect(resolveAirportCode({ ...PARK_AC_JFK, contextAirport: "ZZZ" })).toBe("JFK");
    expect(resolveAirportCode({ ...PARK_AC_JFK, contextAirport: "TEST-NY" })).toBe("JFK");
  });

  it("never returns a test airport, even when it is the nearest", () => {
    // TEST-OH sits ~10 mi from CVG in config; a downtown-Cincinnati lot must resolve to CVG.
    expect(productionAirports.some((a) => a.isTest)).toBe(false);
    expect(resolveAirportCode({ lat: 39.103, lng: -84.512 })).toBe("CVG");
  });

  it("no production airport within 25 mi → null (never a guess)", () => {
    expect(resolveAirportCode({ lat: 44.0, lng: -100.0 })).toBeNull();
  });

  it("known context but unverifiable coordinates → null", () => {
    expect(resolveAirportCode({ contextAirport: "JFK", lat: undefined, lng: undefined })).toBeNull();
    expect(resolveAirportCode({ contextAirport: "JFK", lat: "0", lng: "0" })).toBeNull();
    expect(resolveAirportCode({ contextAirport: "JFK", lat: "abc", lng: "def" })).toBeNull();
  });
});

describe("resolveAirportCode — thresholds are pinned in MILES", () => {
  // Fixture airports on a flat-ish latitude; 1° latitude ≈ 69.1 mi.
  const A = { code: "AAA", latitude: 40.0, longitude: -74.0 };
  const B = { code: "BBB", latitude: 40.0, longitude: -74.0 - 30 / 52.9 }; // ~30 mi west of A at 40°N
  const mk = (a: typeof A) =>
    ({ ...a, name: a.code, city: "", state: "", timezone: "UTC", slug: a.code.toLowerCase(), enabled: true }) as never;
  const airports = [mk(A), mk(B)];

  it("a context airport just inside 40 mi wins over a nearer airport; just outside falls through", () => {
    // Lot 5 mi from B, ~35 mi from A.
    const nearB = { lat: 40.0, lng: B.longitude + 5 / 52.9 };
    expect(resolveAirportCode({ ...nearB, contextAirport: "AAA", airports })).toBe("AAA");
    // Lot 5 mi from B, ~41 mi from A.
    const farFromA = { lat: 40.0, lng: -74.0 - 41 / 52.9 };
    expect(resolveAirportCode({ ...farFromA, contextAirport: "AAA", airports })).toBe("BBB");
  });

  it("nearest resolves at 24 mi and is null at 26 mi", () => {
    expect(resolveAirportCode({ lat: 40.0 + 24 / 69.1, lng: -74.0, airports: [mk(A)] })).toBe("AAA");
    expect(resolveAirportCode({ lat: 40.0 + 26 / 69.1, lng: -74.0, airports: [mk(A)] })).toBeNull();
  });
});
