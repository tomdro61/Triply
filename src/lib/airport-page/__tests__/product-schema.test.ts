import { describe, it, expect } from "vitest";
import type { Airport } from "@/config/airports";
import type { UnifiedLot } from "@/types/lot";
import type { LotReviewSummary } from "@/lib/reviews/summary";
import type { AirportPageData } from "../data";
import { buildAirportSchemas } from "../schemas";

/**
 * Product JSON-LD on airport pages: the Triply brand always, and never an
 * aggregateRating — the page lists several lots, and each lot's own verified
 * rating belongs on its lot page (src/lib/seo/lot-schema.ts).
 */
const AIRPORT = { code: "JFK", name: "John F. Kennedy International", city: "New York", state: "NY", slug: "new-york-jfk", latitude: 40.64, longitude: -73.78 } as unknown as Airport;

function lot(id: number, reviews?: LotReviewSummary): UnifiedLot {
  return { id: `reslab-${id}`, reviews } as unknown as UnifiedLot;
}
const summary = (average: number | null, count: number): LotReviewSummary => ({ average, count, published: [] });

function pageData(lots: UnifiedLot[]): AirportPageData {
  return {
    lots,
    topLots: lots,
    cheapestLot: null,
    cheapestPrice: 10,
    closestLot: null,
    totalLots: lots.length,
    priceRange: { min: 10, max: 20 },
    hasShuttle: true,
    commonAmenities: [],
    distanceRange: null,
    locationsConsidered: lots.length,
  };
}

function product(data: AirportPageData): Record<string, unknown> | undefined {
  return buildAirportSchemas(AIRPORT, data, []).find((s) => s["@type"] === "Product");
}

describe("Product JSON-LD", () => {
  it("always carries the Triply brand", () => {
    expect(product(pageData([lot(1)]))?.brand).toEqual({ "@type": "Brand", name: "Triply" });
  });

  it("has no aggregateRating, even when lots show verified ratings", () => {
    expect(product(pageData([lot(1, summary(4.0, 3)), lot(2, summary(5.0, 9))]))).not.toHaveProperty("aggregateRating");
  });

  it("is still omitted entirely when there is no price range", () => {
    expect(product({ ...pageData([lot(1)]), priceRange: null })).toBeUndefined();
  });
});
