import { describe, it, expect } from "vitest";
import { buildComparisonView, buildComparisonSchemas, SNAPSHOT_MAX_AGE_DAYS } from "../build";
import type { AirportComparison } from "@/data/comparison";
import type { Airport } from "@/config/airports";
import type { AirportPageData } from "@/lib/airport-page/data";
import type { UnifiedLot } from "@/types/lot";

const NOW = new Date("2026-08-19T12:00:00Z");
const FRESH = "2026-08-19";
const STALE = "2026-01-01"; // ~230 days — well past SNAPSHOT_MAX_AGE_DAYS

const airport: Airport = {
  code: "BOS",
  name: "Boston Logan International Airport",
  city: "Boston",
  state: "MA",
  timezone: "America/New_York",
  latitude: 42.3656,
  longitude: -71.0096,
  slug: "boston-bos",
  enabled: true,
};

function lot(name: string, minPrice: number, grandTotal?: number): UnifiedLot {
  return {
    id: name,
    source: "reslab",
    sourceId: name,
    name,
    slug: name,
    address: "",
    city: "Boston",
    state: "MA",
    latitude: 0,
    longitude: 0,
    amenities: [],
    photos: [],
    availability: "available",
    pricing: {
      minPrice,
      currency: "USD",
      parkingTypes: [],
      numberOfDays: 7,
      ...(grandTotal !== undefined
        ? { grandTotal, subtotal: grandTotal, feesTotal: 0, taxTotal: 0 }
        : {}),
    },
  } as UnifiedLot;
}

function pageData(lots: UnifiedLot[]): AirportPageData {
  const prices = lots.map((l) => l.pricing!.minPrice);
  return {
    lots,
    topLots: lots.slice(0, 6),
    cheapestLot: lots[0] ?? null,
    cheapestPrice: prices.length ? Math.min(...prices) : null,
    closestLot: null,
    totalLots: lots.length,
    priceRange: prices.length
      ? { min: Math.min(...prices), max: Math.max(...prices) }
      : null,
    hasShuttle: true,
    commonAmenities: [],
    distanceRange: null,
    locationsConsidered: lots.length,
  };
}

function comparison(verifiedOn: string): AirportComparison {
  return {
    code: "BOS",
    slug: "boston-bos",
    status: "live",
    onAirport: [{ label: "Economy Garage", dailyRate: 37 }],
    competitors: [
      {
        key: "apr",
        name: "AirportParkingReservations",
        shortName: "APR",
        url: "https://example.test/apr",
        fromRate: 17.99,
        fromRateLot: "Select Parking at Hampton Inn",
        fromRateHasShuttle: true,
        lotCount: 5,
        lots: [
          { lot: "Broadway Motor Service", dailyRate: 20.0, triplyLotNameContains: "Broadway Motor Service" },
          { lot: "Gone From Triply", dailyRate: 15.0, triplyLotNameContains: "Gone From Triply" },
        ],
        strengths: ["Widest selection"],
        weaknesses: ["Highest floor"],
        verifiedOn,
      },
    ],
    verdict: {
      lede: "Triply is cheapest at {triplyFrom}/day.",
      cheapestPlatform: "triply",
      bestFor: { triply: "Lowest price", apr: "Most lots", spothero: "Best app" },
    },
    faqs: [{ question: "Static Q", answer: "Static A" }],
  };
}

describe("buildComparisonView", () => {
  it("asserts prices and keeps the recorded verdict when Triply is genuinely cheapest", () => {
    const view = buildComparisonView(
      airport,
      comparison(FRESH),
      pageData([lot("Broadway Motor Service (BOS)", 12.55, 87.85)]),
      NOW
    );

    expect(view.pricesAsserted).toBe(true);
    expect(view.cheapestPlatform).toBe("triply");
    expect(view.lede).toBe("Triply is cheapest at $12.55/day.");
    expect(view.competitors[0].fromRate).toBe(17.99);
  });

  it("drops the price claim when the live Triply rate is no longer the lowest", () => {
    // The data file still says "Triply is cheapest". Rates moved. The page
    // must not repeat a boast the live numbers contradict.
    const view = buildComparisonView(
      airport,
      comparison(FRESH),
      pageData([lot("Broadway Motor Service (BOS)", 24.0, 168)]),
      NOW
    );

    expect(view.cheapestPlatform).toBe("apr");
    expect(view.lede).not.toContain("Triply is cheapest");
    expect(view.lede).toContain("APR");
  });

  it("suppresses competitor prices once the snapshot goes stale", () => {
    const view = buildComparisonView(
      airport,
      comparison(STALE),
      pageData([lot("Broadway Motor Service (BOS)", 12.55, 87.85)]),
      NOW
    );

    expect(view.competitors[0].stale).toBe(true);
    expect(view.competitors[0].ageDays).toBeGreaterThan(SNAPSHOT_MAX_AGE_DAYS);
    expect(view.competitors[0].fromRate).toBeNull();
    expect(view.pricesAsserted).toBe(false);
    // Qualitative rows survive — only the price rots in a month.
    expect(view.competitors[0].strengths).toContain("Widest selection");
    // …and no same-lot row is built off a stale competitor price.
    expect(view.sameLot).toHaveLength(0);
  });

  it("matches same-lot rows against LIVE names and drops lots we no longer carry", () => {
    const view = buildComparisonView(
      airport,
      comparison(FRESH),
      pageData([lot("Broadway Motor Service (BOS)", 12.55, 87.85)]),
      NOW
    );

    expect(view.sameLot).toHaveLength(1);
    expect(view.sameLot[0]).toMatchObject({
      lot: "Broadway Motor Service",
      triplyRate: 12.55,
      competitorRate: 20.0,
      triplyWins: true,
    });
  });

  it("counts same-lot MATCHUPS, not lots — one lot on two platforms is not two wins", () => {
    const twoRivals = comparison(FRESH);
    twoRivals.competitors.push({
      key: "spothero",
      name: "SpotHero",
      shortName: "SpotHero",
      url: "https://example.test/sh",
      fromRate: 17.0,
      fromRateHasShuttle: true,
      lotCount: 6,
      lots: [
        { lot: "Broadway Motors", dailyRate: 17.0, triplyLotNameContains: "Broadway Motor Service" },
      ],
      strengths: ["Best app"],
      weaknesses: ["Priciest"],
      verifiedOn: FRESH,
    });

    const view = buildComparisonView(
      airport,
      twoRivals,
      pageData([lot("Broadway Motor Service (BOS)", 12.55, 87.85)]),
      NOW
    );

    // One physical lot, two competitor rows → two matchups, both won.
    expect(view.sameLot).toHaveLength(2);
    const sameLotFaq = view.faqs.find((f) => f.question.startsWith("Is the same"))!;
    expect(sameLotFaq.answer).toContain("2 of 2 matchups");
    expect(sameLotFaq.answer).not.toContain("2 of the lots");
    // No double spaces from an empty clause.
    expect(sameLotFaq.answer).not.toMatch(/ {2}/);
  });

  it("substitutes live inventory counts into the lede instead of hardcoding them", () => {
    const tokenised = comparison(FRESH);
    tokenised.verdict.lede = "{under9} of {lotCount} lots are under $9, from {triplyFrom}.";

    const view = buildComparisonView(
      airport,
      tokenised,
      pageData([
        lot("Broadway Motor Service (BOS)", 8.5, 59.5),
        lot("Other Lot", 12.0, 84),
      ]),
      NOW
    );

    expect(view.lede).toBe("1 of 2 lots are under $9, from $8.50.");
  });

  it("reports an all-in daily rate that includes the service fee floor", () => {
    // $5.22/day × 7 = $36.54 base → 6% is $2.19, so the $5.95 minimum binds.
    const view = buildComparisonView(
      airport,
      comparison(FRESH),
      pageData([lot("Residence Inn (DEN)", 5.22, 36.54)]),
      NOW
    );

    expect(view.triplyAllInTotal).toBeCloseTo(42.49, 2);
    expect(view.triplyAllInDaily).toBeCloseTo(6.07, 2);
    // The fee floor is why the headline rate understates a short trip.
    expect(view.triplyAllInDaily!).toBeGreaterThan(view.triplyFrom!);
  });

  it("survives a degraded ResLab response without asserting anything", () => {
    const view = buildComparisonView(airport, comparison(FRESH), pageData([]), NOW);

    expect(view.triplyFrom).toBeNull();
    expect(view.pricesAsserted).toBe(false);
    expect(view.cheapestPlatform).toBeNull();
    expect(view.sameLot).toHaveLength(0);
    expect(view.faqs.every((f) => !f.answer.includes("$"))).toBe(true);
  });
});

describe("buildComparisonSchemas", () => {
  const fresh = buildComparisonView(
    airport,
    comparison(FRESH),
    pageData([lot("Broadway Motor Service (BOS)", 12.55, 87.85)]),
    NOW
  );

  it("emits BreadcrumbList, WebPage, Product, and FAQPage", () => {
    const types = buildComparisonSchemas(fresh).map((s) => s["@type"]);
    expect(types).toEqual(
      expect.arrayContaining(["BreadcrumbList", "WebPage", "Product", "FAQPage"])
    );
  });

  it("never marks up a review or rating of a competitor", () => {
    // Self-serving competitor reviews are a structured-data violation and put
    // the whole domain at manual-action risk.
    const blob = JSON.stringify(buildComparisonSchemas(fresh));
    expect(blob).not.toContain("AggregateRating");
    expect(blob).not.toContain('"@type":"Review"');
  });

  it("omits the Product/AggregateOffer when prices are not asserted", () => {
    const stale = buildComparisonView(
      airport,
      comparison(STALE),
      pageData([lot("Broadway Motor Service (BOS)", 12.55, 87.85)]),
      NOW
    );
    const types = buildComparisonSchemas(stale).map((s) => s["@type"]);
    expect(types).not.toContain("Product");
  });

  it("puts every FAQ that renders into the FAQPage schema, and nothing else", () => {
    const faqSchema = buildComparisonSchemas(fresh).find(
      (s) => s["@type"] === "FAQPage"
    ) as { mainEntity: { name: string }[] };
    expect(faqSchema.mainEntity).toHaveLength(fresh.faqs.length);
    expect(faqSchema.mainEntity.map((q) => q.name)).toEqual(
      fresh.faqs.map((f) => f.question)
    );
  });
});
