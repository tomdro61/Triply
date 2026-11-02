import { describe, expect, it } from "vitest";
import { productionAirports } from "@/config/airports";
import type { UnifiedLot } from "@/types/lot";
import { SITE_ORIGIN, buildLotSchema, canonicalAirportFor, lotCanonicalPath } from "../lot-schema";

// The booking-widget fixture: loaded 10 AM → 2 PM, $76.10 total for 4 days
// ($70.15 + $5.95 service fee), shown as $19.03/day with "Taxes & fees included".
const LOT: UnifiedLot = {
  id: "reslab-275",
  source: "reslab",
  sourceId: "275",
  reslabLocationId: 275,
  name: "PARK AC JFK Airport Parking",
  slug: "park-ac-jfk-airport-parking",
  address: "126-20 152nd Ave",
  city: "New York",
  state: "NY",
  latitude: 40.66,
  longitude: -73.79,
  amenities: [],
  photos: [{ id: "placeholder", url: "/placeholder-parking.jpg" }],
  pricing: { minPrice: 15.96, currency: "$", parkingTypes: [], grandTotal: 70.15, subtotal: 59.85, feesTotal: 3.99, taxTotal: 6.31, numberOfDays: 4 },
  availability: "available",
  dueAtLocation: true,
  dueAtLocationAmount: 54.95,
};

const airport = (code: string) => {
  const a = productionAirports.find((x) => x.code === code);
  if (!a) throw new Error(`no airport ${code}`);
  return a;
};

describe("buildLotSchema", () => {
  const schema = buildLotSchema(LOT, "new-york-jfk", "park-ac-jfk-airport-parking");

  it("publishes the fee-inclusive per-day figure the page shows — never the pre-fee minPrice, never `offers`", () => {
    // Same arithmetic path as the page (priceViewFromPricing → perDay.toFixed(2)).
    expect(schema.priceRange).toBe("From $19.03/day, taxes & fees included");
    expect(JSON.stringify(schema)).not.toContain("15.96");
    expect(schema).not.toHaveProperty("offers");
  });

  it("omits the price entirely when no total can be built", () => {
    const noTotals = buildLotSchema({ ...LOT, pricing: { minPrice: 15.96, currency: "$", parkingTypes: [] } }, "new-york-jfk", LOT.slug);
    expect(noTotals).not.toHaveProperty("priceRange");
    expect(JSON.stringify(noTotals)).not.toContain("15.96");
  });

  it("never sends the placeholder photo as image; keeps a real absolute photo URL", () => {
    expect(schema).not.toHaveProperty("image");
    const withPhoto = buildLotSchema({ ...LOT, photos: [{ id: "p1", url: "https://cdn.example.com/lot.jpg" }] }, "new-york-jfk", LOT.slug);
    expect(withPhoto.image).toBe("https://cdn.example.com/lot.jpg");
    const relative = buildLotSchema({ ...LOT, photos: [{ id: "p1", url: "/photos/lot.jpg" }] }, "new-york-jfk", LOT.slug);
    expect(relative).not.toHaveProperty("image");
  });

  it("type, url and address", () => {
    expect(schema["@type"]).toEqual(["ParkingFacility", "LocalBusiness"]);
    expect(schema.url).toBe(`${SITE_ORIGIN}/new-york-jfk/airport-parking/park-ac-jfk-airport-parking`);
    expect(schema.address).toMatchObject({ "@type": "PostalAddress", streetAddress: "126-20 152nd Ave", addressLocality: "New York", addressRegion: "NY" });
  });

  it("the lot's own slug wins over the URL's (numeric / reslab-<id> URLs canonicalise to the slug)", () => {
    const s = buildLotSchema(LOT, "new-york-jfk", "275");
    expect(s.url).toBe(`${SITE_ORIGIN}/new-york-jfk/airport-parking/park-ac-jfk-airport-parking`);
    const noSlug = buildLotSchema({ ...LOT, slug: "" }, "new-york-jfk", "275");
    expect(noSlug.url).toBe(`${SITE_ORIGIN}/new-york-jfk/airport-parking/275`);
  });

  it("aggregateRating only with a real rating AND a positive review count", () => {
    expect(schema).not.toHaveProperty("aggregateRating");
    expect(buildLotSchema({ ...LOT, rating: 4.6 }, "new-york-jfk", LOT.slug)).not.toHaveProperty("aggregateRating");
    expect(buildLotSchema({ ...LOT, rating: 4.6, reviewCount: 0 }, "new-york-jfk", LOT.slug)).not.toHaveProperty("aggregateRating");
    const rated = buildLotSchema({ ...LOT, rating: 4.6, reviewCount: 7 }, "new-york-jfk", LOT.slug);
    expect(rated.aggregateRating).toEqual({ "@type": "AggregateRating", ratingValue: "4.6", reviewCount: 7, bestRating: "5", worstRating: "1" });
  });
});

describe("canonicalAirportFor", () => {
  it("a JFK lot reached through the LGA URL canonicalises to JFK; through JFK stays JFK", () => {
    expect(canonicalAirportFor(LOT, airport("LGA")).code).toBe("JFK");
    expect(canonicalAirportFor(LOT, airport("JFK")).code).toBe("JFK");
  });

  it("a direct lot keeps the airport it was served under", () => {
    const direct: UnifiedLot = { ...LOT, source: "direct", sourceId: "1", reslabLocationId: undefined };
    expect(canonicalAirportFor(direct, airport("LGA")).code).toBe("LGA");
  });
});

describe("lotCanonicalPath", () => {
  it("is the route shape", () => {
    expect(lotCanonicalPath("new-york-jfk", "park-ac-jfk-airport-parking")).toBe("/new-york-jfk/airport-parking/park-ac-jfk-airport-parking");
  });
});
