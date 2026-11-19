import { describe, it, expect } from "vitest";
import type { Airport } from "@/config/airports";
import type { UnifiedLot } from "@/types/lot";
import type { AirportPageData } from "../data";
import { generateFAQs, generateSEOContent } from "../content";
import { lotRunsShuttle, runsShuttle } from "../shuttle";

/**
 * The template copy on airport pages without a hand-written guide. On 19 Nov the Norfolk page, with one lot whose shuttle was
 * suspended, read "daily rates ranging from $8–$8/day", "Most lots offer
 * complimentary shuttle service" and "see all 1 ORF parking lots".
 */
const AIRPORT = { code: "ORF", name: "Norfolk International Airport", city: "Norfolk", state: "VA", slug: "norfolk-orf" } as unknown as Airport;

function lot(name: string, price: number, miles: number, shuttle: string | undefined): UnifiedLot {
  return {
    id: name,
    name,
    pricing: { minPrice: price },
    distanceFromAirport: miles,
    shuttleInfo: shuttle === undefined ? undefined : { summary: shuttle },
    amenities: [],
  } as unknown as UnifiedLot;
}

function pageData(lots: UnifiedLot[]): AirportPageData {
  const prices = lots.map((l) => l.pricing?.minPrice ?? 0);
  const miles = lots.map((l) => l.distanceFromAirport ?? 0);
  const cheapest = lots.reduce((a, b) => ((a.pricing?.minPrice ?? 0) <= (b.pricing?.minPrice ?? 0) ? a : b));
  const closest = lots.reduce((a, b) => ((a.distanceFromAirport ?? 0) <= (b.distanceFromAirport ?? 0) ? a : b));
  return {
    lots,
    topLots: lots,
    cheapestLot: cheapest,
    cheapestPrice: Math.min(...prices),
    closestLot: closest,
    totalLots: lots.length,
    priceRange: { min: Math.min(...prices), max: Math.max(...prices) },
    hasShuttle: lots.some(lotRunsShuttle),
    commonAmenities: [],
    distanceRange: { min: Math.min(...miles), max: Math.max(...miles) },
    locationsConsidered: lots.length,
  };
}

const allText = (data: AirportPageData) =>
  [
    ...generateSEOContent(AIRPORT, data).map((s) => s.body),
    ...generateFAQs(AIRPORT, data).map((f) => f.answer),
  ].join("\n");

describe("runsShuttle", () => {
  it("reads a shuttle from the lot's summary", () => {
    expect(runsShuttle("24/7 on demand")).toBe(true);
    expect(runsShuttle("5:00 AM - 12:00 AM: Shuttle runs every 30 minutes.  12:00 AM - 5:00 AM: No shuttle.")).toBe(true);
  });

  it("is false when the summary says there is none, or it's suspended", () => {
    expect(runsShuttle("No Shuttle")).toBe(false);
    expect(runsShuttle("Shuttle temporarily suspended. You may arrange for your own Uber/Lyft")).toBe(false);
    expect(runsShuttle("")).toBe(false);
    expect(runsShuttle(undefined)).toBe(false);
  });
});

describe("lotRunsShuttle", () => {
  const amenity = [{ id: 1, name: "free_shuttle", displayName: "Free Shuttle" }];
  it("trusts the lot's own summary over its shuttle amenity", () => {
    expect(lotRunsShuttle({ shuttleInfo: { summary: "Shuttle temporarily suspended." }, amenities: amenity } as never)).toBe(false);
  });
  it("claims no shuttle without a summary, even with a shuttle amenity", () => {
    expect(lotRunsShuttle({ shuttleInfo: undefined, amenities: amenity } as never)).toBe(false);
  });
});

describe("airport page template copy", () => {
  it("one lot with a suspended shuttle: no range, no shuttle claim, no 'all 1 lots'", () => {
    const text = allText(pageData([lot("Econo Lodge Norfolk Airport", 8.4, 1.1, "Shuttle temporarily suspended.")]));
    expect(text).not.toMatch(/\$8–\$8/);
    expect(text).toContain("with rates from $8.40/day");
    expect(text).not.toMatch(/most lots|most facilities|complimentary shuttle|every 5–15 minutes/i);
    expect(text).not.toMatch(/all 1 |compare 1 |between 1\.1 and 1\.1/);
    expect(text).toContain("no shuttle right now");
    expect(text).toContain("1.1 miles from the terminal");
  });

  it("one lot with a shuttle says it runs one", () => {
    const text = allText(pageData([lot("Clarion Inn", 8.49, 1.3, "24/7 on Demand")]));
    expect(text).toContain("It runs a shuttle to and from the terminal.");
    expect(text).not.toMatch(/no shuttle right now/);
  });

  it("counts the lots with a shuttle when only some run one", () => {
    const text = allText(
      pageData([
        lot("Best Western Plus Richmond Airport", 5.2, 1.5, "No Shuttle"),
        lot("DoubleTree Richmond Airport", 10.45, 1.6, "5:00 AM - 12:00 AM every 30 minutes"),
        lot("Sheraton Richmond Airport", 10.49, 1.1, "4:00 AM - 1:00 AM: Shuttle runs every 30 minutes."),
      ])
    );
    expect(text).toContain("2 of the 3 lots run a shuttle to the terminal");
    expect(text).toContain("daily rates ranging from $5–$10/day");
    expect(text).toContain("between 1.1 and 1.6 miles");
    expect(text).not.toMatch(/most lots/i);
  });

  it("says every lot runs one only when every lot does", () => {
    const text = allText(pageData([lot("A", 7.9, 1.7, "24/7, On demand"), lot("B", 12.9, 1.3, "24/7 every 10 minutes")]));
    expect(text).toContain("Every lot listed runs a shuttle");
    expect(text).toContain("see all 2 ORF parking lots");
  });
});

describe("airport page template copy, more branches", () => {
  it("several lots, none with a shuttle", () => {
    const text = allText(pageData([lot("A", 6, 1.2, "No Shuttle"), lot("B", 9, 2.0, "No Shuttle")]));
    expect(text).toContain("None of these lots lists a shuttle right now");
    expect(text).toContain("These lots list no shuttle right now");
    expect(text).toContain("The lots we list near ORF list no shuttle right now");
  });

  it("several lots whose rates round to the same dollar show the cheapest to the cent", () => {
    const text = allText(pageData([lot("A", 7.75, 0.8, "24/7"), lot("B", 8.05, 1.2, "24/7")]));
    expect(text).toContain("with rates from $7.75/day");
    expect(text).not.toMatch(/\$8–\$8/);
  });

  it("several lots at one distance don't read as one lot", () => {
    const text = allText(pageData([lot("A", 6, 1.1, "24/7"), lot("B", 9, 1.1, "24/7")]));
    expect(text).toContain("start 1.1 miles from the terminal");
  });

  it("one lot: the booking and shuttle answers talk about that lot", () => {
    const faqs = generateFAQs(AIRPORT, pageData([lot("Clarion Inn", 8.49, 1.3, "24/7 on Demand")]));
    expect(faqs.map((f) => f.answer).join("\n")).toContain("check the available lot's price");
    expect(faqs.map((f) => f.answer).join("\n")).toContain("The lot's page on Triply lists its shuttle hours.");
    expect(faqs.map((f) => f.answer).join("\n")).not.toMatch(/differ by lot/);
  });

  it("makes no savings claim the data can't back", () => {
    expect(allText(pageData([lot("A", 6, 1.2, "24/7")]))).not.toMatch(/30–60%|save compared/);
  });
});

describe("runsShuttle, other wordings", () => {
  it.each([
    ["N/A", false],
    ["None", false],
    ["Shuttle discontinued", false],
    ["Free shuttle currently not operating", false],
    ["There is no shuttle", false],
    ["Walk to terminal", false],
    ["No shuttle on Sundays; 24/7 otherwise", true],
    ["12:00 AM - 4:00 AM: Shuttle not available.  4:00 AM - 12:00 AM: Shuttle runs every 20 minutes.", true],
    ["Shuttle service suspended 1–4 AM", true],
    ["Complimentary shuttle to the terminal", true],
    ["Shuttle suspended since 3-1-2026", false],
    ["Shuttle discontinued 2024-2025", false],
    ["No shuttle. Call 757-555-1234", false],
    ["No shuttle service. Taxi approx 10-15 min", false],
    ["No complimentary shuttle", false],
    ["No free shuttle", false],
    ["Shuttle does not run", false],
    ["Self-park; no shuttle. Taxi stand 24/7", false],
    ["Shuttle not provided", false],
    ["5:00 AM - 12:00 AM: Shuttle runs every 30 minutes.  12:00 AM - 5:00 AM: No shuttle.", true],
  ])("%s → %s", (summary, expected) => {
    expect(runsShuttle(summary)).toBe(expected);
  });
});
