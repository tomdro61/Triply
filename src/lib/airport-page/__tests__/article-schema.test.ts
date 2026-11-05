import { describe, it, expect } from "vitest";
import type { Airport } from "@/config/airports";
import type { AirportPageData } from "../data";
import { buildAirportSchemas } from "../schemas";
import { getAirportContent } from "@/data/airport-content";
import { productionAirports } from "@/config/airports";

/**
 * Article JSON-LD on airport pages: only when the hand-written guide is shown,
 * with dates from the content file — never the render time.
 */
const AIRPORT = { code: "BOS", name: "Boston Logan International", city: "Boston", state: "MA", slug: "boston-logan", latitude: 42.36, longitude: -71.01 } as unknown as Airport;

const DATA = {
  lots: [],
  topLots: [],
  cheapestLot: null,
  cheapestPrice: 10,
  closestLot: null,
  totalLots: 3,
  priceRange: { min: 10, max: 20 },
  hasShuttle: true,
  commonAmenities: [],
  distanceRange: null,
  locationsConsidered: 3,
} as unknown as AirportPageData;

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

describe("Article JSON-LD", () => {
  it("uses the guide's own dates", () => {
    const article = buildAirportSchemas(AIRPORT, DATA, [], { publishedOn: "2026-04-25", updatedOn: "2026-10-30" })
      .find((s) => s["@type"] === "Article");
    expect(article).toMatchObject({
      datePublished: "2026-04-25",
      dateModified: "2026-10-30",
      mainEntityOfPage: { "@id": "https://www.triplypro.com/boston-logan/airport-parking" },
      about: { "@type": "Airport", iataCode: "BOS" },
    });
  });

  it("is left out when the page has no hand-written guide", () => {
    for (const guide of [undefined, null]) {
      const types = buildAirportSchemas(AIRPORT, DATA, [], guide).map((s) => s["@type"]);
      expect(types).not.toContain("Article");
    }
  });
});

describe("airport content dates", () => {
  it("every guide has valid ISO dates, published on or before updated, none in the future", async () => {
    const today = new Date().toISOString().slice(0, 10);
    let checked = 0;
    for (const airport of productionAirports) {
      const content = await getAirportContent(airport.code);
      if (!content) continue;
      checked++;
      expect(content.publishedOn, airport.code).toMatch(ISO_DAY);
      expect(content.updatedOn, airport.code).toMatch(ISO_DAY);
      expect(Number.isNaN(Date.parse(content.updatedOn)), airport.code).toBe(false);
      expect(content.publishedOn <= content.updatedOn, airport.code).toBe(true);
      expect(content.updatedOn <= today, airport.code).toBe(true);
    }
    expect(checked).toBeGreaterThan(0);
  });
});
