/**
 * The airport page's empty-state wiring: which title, meta, guide and
 * structured data a page gets with and without bookable lots. The builders
 * have their own tests; this pins the page's choices between them, which no
 * other test does (lesson 13).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AirportPageData } from "@/lib/airport-page/data";

const fetchAirportPageData = vi.fn();
vi.mock("@/lib/airport-page/data", () => ({ fetchAirportPageData: (...a: unknown[]) => fetchAirportPageData(...a) }));
const buildAirportSchemas = vi.fn((..._a: unknown[]) => [] as unknown[]);
vi.mock("@/lib/airport-page/schemas", () => ({ buildAirportSchemas: (...a: unknown[]) => buildAirportSchemas(...a) }));

// The search widget is a client component that needs the app router; the hero test only reads its badges.
vi.mock("@/components/airport/search-widget", () => ({ SearchWidget: () => null }));

import { createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import AirportParkingPage, { generateMetadata } from "@/app/(main)/[slug]/airport-parking/page";
import { getNoLotsAirportContent } from "@/data/airport-content/no-lots";
import { SEOContent } from "@/components/airport/seo-content";
import { AirportFAQ } from "@/components/airport/airport-faq";
import { HeroSection } from "@/components/airport/hero-section";
import { getAirportByCode } from "@/config/airports";

const props = (slug: string) => ({ params: Promise.resolve({ slug }) });

/** Every element of this component type in the page's returned tree (props only; nothing is rendered). */
function elementsOf(node: ReactNode, type: unknown): Record<string, unknown>[] {
  if (Array.isArray(node)) return node.flatMap((n) => elementsOf(n, type));
  if (!isValidElement(node)) return [];
  const p = node.props as Record<string, unknown>;
  return [...(node.type === type ? [p] : []), ...elementsOf(p.children as ReactNode, type)];
}

function pageData(totalLots: number, locationsConsidered: number | null): AirportPageData {
  return {
    lots: [],
    topLots: [],
    cheapestLot: null,
    cheapestPrice: totalLots > 0 ? 9 : null,
    closestLot: null,
    totalLots,
    priceRange: totalLots > 0 ? { min: 9, max: 20 } : null,
    hasShuttle: false,
    commonAmenities: [],
    distanceRange: null,
    locationsConsidered,
  };
}

beforeEach(() => {
  fetchAirportPageData.mockReset();
  buildAirportSchemas.mockClear();
});

describe("airport page — nothing bookable, with a guide (DAL)", () => {
  beforeEach(() => {
    fetchAirportPageData.mockResolvedValue(pageData(0, 0));
  });

  it("titles it a guide (no 'Cheap … Rates'), takes the guide's meta, and stays indexable", async () => {
    const guide = await getNoLotsAirportContent("DAL");
    const meta = await generateMetadata(props("dallas-dal") as never);
    expect(meta.title).toBe("Dallas Airport Parking Guide (DAL)");
    expect(meta.title).not.toMatch(/cheap/i);
    expect(meta.description).toBe(guide?.metaDescription);
    expect(meta.robots).toBeUndefined();
  });

  it("feeds the guide's FAQ and dates to the structured data", async () => {
    const guide = await getNoLotsAirportContent("DAL");
    await AirportParkingPage(props("dallas-dal") as never);
    const [, , faqs, content] = buildAirportSchemas.mock.calls[0];
    expect(faqs).toEqual(guide?.faqs);
    expect(content).toEqual(guide);
  });
});

describe("airport page — lots to book (DAL with a lot)", () => {
  beforeEach(() => {
    fetchAirportPageData.mockResolvedValue(pageData(2, 2));
  });

  it("keeps the normal title and meta, and never the guide's", async () => {
    const guide = await getNoLotsAirportContent("DAL");
    const meta = await generateMetadata(props("dallas-dal") as never);
    expect(meta.title).toMatch(/Cheap DAL Parking Rates/);
    expect(meta.description).not.toBe(guide?.metaDescription);
  });

  it("never sends the guide's FAQ or dates to the structured data", async () => {
    const guide = await getNoLotsAirportContent("DAL");
    await AirportParkingPage(props("dallas-dal") as never);
    const [, , faqs, content] = buildAirportSchemas.mock.calls[0];
    expect(faqs).not.toEqual(guide?.faqs);
    expect(content).not.toEqual(guide);
  });
});

describe("airport page — unknown lot count (a failed search at build)", () => {
  beforeEach(() => {
    fetchAirportPageData.mockResolvedValue(pageData(0, null));
  });

  it("shows neither the guide nor its FAQ markup, matching the generic meta", async () => {
    const guide = await getNoLotsAirportContent("DAL");
    const meta = await generateMetadata(props("dallas-dal") as never);
    expect(meta.description).not.toBe(guide?.metaDescription);
    await AirportParkingPage(props("dallas-dal") as never);
    const [, , faqs, content] = buildAirportSchemas.mock.calls[0];
    expect(faqs).toEqual([]);
    expect(content).toBeNull();
  });
});

describe("airport page — what is on screen", () => {
  it("at 0 lots with a guide, the guide's sections and FAQ are rendered (the same ones the structured data gets)", async () => {
    fetchAirportPageData.mockResolvedValue(pageData(0, 0));
    const guide = (await getNoLotsAirportContent("DAL"))!;
    const tree = await AirportParkingPage(props("dallas-dal") as never);
    const [, , schemaFaqs] = buildAirportSchemas.mock.calls[0];
    expect(elementsOf(tree, SEOContent).map((p) => p.sections)).toEqual([guide.sections]);
    expect(elementsOf(tree, AirportFAQ).map((p) => p.faqs)).toEqual([schemaFaqs]);
    expect(schemaFaqs).toEqual(guide.faqs);
  });

  it("with lots, no guide section or FAQ is rendered", async () => {
    fetchAirportPageData.mockResolvedValue(pageData(2, 2));
    const guide = (await getNoLotsAirportContent("DAL"))!;
    const tree = await AirportParkingPage(props("dallas-dal") as never);
    for (const p of elementsOf(tree, SEOContent)) expect(p.sections).not.toEqual(guide.sections);
    for (const p of elementsOf(tree, AirportFAQ)) expect(p.faqs).not.toEqual(guide.faqs);
  });

  it("the hero shows its booking badges only when there is something to book", () => {
    const airport = getAirportByCode("DAL")!;
    const hero = (totalLots: number) =>
      renderToStaticMarkup(createElement(HeroSection, { airport, data: pageData(totalLots, totalLots) }));
    expect(hero(2)).toContain("Free Cancellation");
    expect(hero(0)).not.toMatch(/Free Cancellation|Instant Confirmation|Trusted Lots/);
  });
});

describe("airport page — nothing bookable and no guide (a sold-out week at SLC)", () => {
  beforeEach(() => {
    fetchAirportPageData.mockResolvedValue(pageData(0, 3));
  });

  it("is titled plainly (no 'Guide', no 'Cheap … Rates') and renders no guide", async () => {
    const meta = await generateMetadata(props("salt-lake-city-slc") as never);
    expect(meta.title).toBe("Salt Lake City Airport Parking (SLC)");
    const tree = await AirportParkingPage(props("salt-lake-city-slc") as never);
    expect(elementsOf(tree, SEOContent)).toEqual([]);
    expect(elementsOf(tree, AirportFAQ)).toEqual([]);
  });
});
