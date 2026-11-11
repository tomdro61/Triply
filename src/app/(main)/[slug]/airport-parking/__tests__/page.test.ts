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

import AirportParkingPage, { generateMetadata } from "@/app/(main)/[slug]/airport-parking/page";
import { getNoLotsAirportContent } from "@/data/airport-content/no-lots";

const props = (slug: string) => ({ params: Promise.resolve({ slug }) });

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
