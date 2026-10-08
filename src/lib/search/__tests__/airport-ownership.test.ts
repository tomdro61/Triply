import { describe, it, expect } from "vitest";
import { getAirportByCode, productionAirports, type Airport } from "@/config/airports";
import {
  isOwnAirportFilterEnabled,
  lotBelongsToAirport,
  locationBelongsToAirport,
} from "../airport-ownership";

// Real coordinates from the production ResLab list (2026-10-08).
const LOTS = {
  hyattFlushing: { id: 159, latitude: "40.7589732", longitude: "-73.8323536" }, // LGA lot JFK used to list
  queensCrossing: { id: 112, latitude: "40.7609223", longitude: "-73.8300252" }, // LGA lot JFK used to list
  parkAc: { id: 275, latitude: "40.6637560", longitude: "-73.8152580" }, // JFK
  a1Jfk: { id: 561, latitude: "40.6659081", longitude: "-73.7855037" }, // JFK
  carvia: { id: 388, latitude: "40.7680051", longitude: "-73.8752667" }, // LGA
  marriottLga: { id: 454, latitude: "40.7688530", longitude: "-73.8677325" }, // LGA
  hyattFll: { id: 100, latitude: "26.0978612", longitude: "-80.1334810" }, // nearer POE than FLL
  pier66: { id: 213, latitude: "26.1008389", longitude: "-80.1136397" }, // nearer POE than FLL
  fllSpots: { id: 407, latitude: "26.0302244", longitude: "-80.2074466" }, // FLL
  homewood: { id: 115, latitude: "26.0639965", longitude: "-80.1670098" }, // FLL
};

const airport = (code: string): Airport => {
  const a = getAirportByCode(code);
  if (!a) throw new Error(`no airport ${code}`);
  return a;
};

describe("locationBelongsToAirport", () => {
  it("JFK drops the two Flushing lots LGA is closer to and keeps its own", () => {
    const jfk = airport("JFK");
    expect(locationBelongsToAirport(LOTS.hyattFlushing, jfk)).toBe(false);
    expect(locationBelongsToAirport(LOTS.queensCrossing, jfk)).toBe(false);
    expect(locationBelongsToAirport(LOTS.parkAc, jfk)).toBe(true);
    expect(locationBelongsToAirport(LOTS.a1Jfk, jfk)).toBe(true);
  });

  it("LGA drops JFK lots and keeps its own, including the Flushing lots", () => {
    const lga = airport("LGA");
    expect(locationBelongsToAirport(LOTS.parkAc, lga)).toBe(false);
    expect(locationBelongsToAirport(LOTS.a1Jfk, lga)).toBe(false);
    expect(locationBelongsToAirport(LOTS.carvia, lga)).toBe(true);
    expect(locationBelongsToAirport(LOTS.marriottLga, lga)).toBe(true);
    expect(locationBelongsToAirport(LOTS.hyattFlushing, lga)).toBe(true);
  });

  it("a seaport never takes lots from FLL, and a seaport search keeps every lot", () => {
    const fll = airport("FLL");
    const poe = airport("POE");
    expect(poe.isSeaport).toBe(true);
    // Closer to Port Everglades, but a seaport is not a competing airport.
    expect(locationBelongsToAirport(LOTS.hyattFll, fll)).toBe(true);
    expect(locationBelongsToAirport(LOTS.pier66, fll)).toBe(true);
    // Port Everglades keeps the FLL lots it lists today.
    expect(locationBelongsToAirport(LOTS.fllSpots, poe)).toBe(true);
    expect(locationBelongsToAirport(LOTS.homewood, poe)).toBe(true);
  });

  it("POE is the only seaport, so no other airport is exempt by accident", () => {
    expect(productionAirports.filter((a) => a.isSeaport).map((a) => a.code)).toEqual(["POE"]);
  });

  it("a tie keeps the lot; a single-location (test) airport keeps everything", () => {
    const a = { code: "AAA", latitude: 40, longitude: -74 };
    const b = { code: "BBB", latitude: 40, longitude: -73.8 };
    const midpoint = { latitude: 40, longitude: -73.9 };
    expect(lotBelongsToAirport(midpoint, a, [a, b])).toBe(true);
    expect(lotBelongsToAirport(midpoint, b, [a, b])).toBe(true);
    const test = { code: "TST", latitude: 40, longitude: -74, reslabLocationId: 195 };
    expect(lotBelongsToAirport({ latitude: 40, longitude: -73.81 }, test, [test, b])).toBe(true);
  });

  it("a test airport is never a competitor", () => {
    const real = { code: "AAA", latitude: 40, longitude: -74 };
    const test = { code: "TST", latitude: 40, longitude: -73.81, reslabLocationId: 195 };
    expect(lotBelongsToAirport({ latitude: 40, longitude: -73.81 }, real, [real, test])).toBe(true);
  });

  it("unparseable coordinates keep the lot (the radius filter already said it is near)", () => {
    expect(locationBelongsToAirport({ id: 1, latitude: "", longitude: "x" }, airport("JFK"))).toBe(true);
  });
});

describe("isOwnAirportFilterEnabled", () => {
  const env = (v?: string): NodeJS.ProcessEnv => ({ NODE_ENV: "test", ...(v === undefined ? {} : { SEARCH_OWN_AIRPORT_FILTER: v }) });
  it("on unless switched off; off/false/0/no all count as off", () => {
    expect(isOwnAirportFilterEnabled(env())).toBe(true);
    expect(isOwnAirportFilterEnabled(env("on"))).toBe(true);
    for (const v of [" OFF ", "false", "0", "no"]) expect(isOwnAirportFilterEnabled(env(v))).toBe(false);
  });
});
