import { describe, it, expect } from "vitest";
import type { Airport } from "@/config/airports";
import type { UnifiedLot } from "@/types/lot";
import type { LotReviewSummary } from "@/lib/reviews/summary";
import type { AirportPageData } from "../data";
import { airportRating, buildAirportSchemas } from "../schemas";

/**
 * Product JSON-LD on airport pages: Brand always; AggregateRating only from
 * verified Triply reviews (lot.reviews), never invented, never a source's own
 * rating, and never when no lot shows a rating of its own.
 */
const AIRPORT = { code: "JFK", name: "John F. Kennedy International", city: "New York", state: "NY", slug: "new-york-jfk", latitude: 40.64, longitude: -73.78 } as unknown as Airport;

function lot(id: number, reviews?: LotReviewSummary, rating?: number): UnifiedLot {
  return { id: `reslab-${id}`, reviews, rating } as unknown as UnifiedLot;
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

describe("airportRating", () => {
  it("weights each lot's verified average by its review count", () => {
    // (4.0*3 + 5.0*9) / 12 = 4.75 → 4.8
    expect(airportRating([lot(1, summary(4.0, 3)), lot(2, summary(5.0, 9))])).toEqual({ average: 4.8, count: 12 });
  });

  it("skips lots below the display minimum (average withheld) and lots with no reviews", () => {
    expect(airportRating([lot(1, summary(4.5, 4)), lot(2, summary(null, 2)), lot(3)])).toEqual({ average: 4.5, count: 4 });
  });

  it("is null when no lot shows a verified rating (always so with display off)", () => {
    expect(airportRating([lot(1, summary(null, 2)), lot(2)])).toBeNull();
    expect(airportRating([])).toBeNull();
  });

  it("ignores a rating that didn't come from booking_reviews", () => {
    expect(airportRating([lot(1, undefined, 4.9)])).toBeNull();
  });
});

describe("Product JSON-LD", () => {
  it("always carries the Triply brand", () => {
    expect(product(pageData([lot(1)]))?.brand).toEqual({ "@type": "Brand", name: "Triply" });
  });

  it("has no aggregateRating without verified ratings", () => {
    expect(product(pageData([lot(1), lot(2, summary(null, 2))]))).not.toHaveProperty("aggregateRating");
  });

  it("carries the same aggregateRating the hero shows", () => {
    const lots = [lot(1, summary(4.0, 3)), lot(2, summary(5.0, 9))];
    expect(product(pageData(lots))?.aggregateRating).toEqual({
      "@type": "AggregateRating",
      ratingValue: "4.8",
      ratingCount: 12,
      bestRating: 5,
      worstRating: 1,
    });
  });

  it("is still omitted entirely when there is no price range", () => {
    expect(product({ ...pageData([lot(1, summary(4.0, 3))]), priceRange: null })).toBeUndefined();
  });
});
