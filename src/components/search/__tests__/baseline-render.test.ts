import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * Baseline render of the parking search components, captured from `main`
 * BEFORE the Park & Stay PR B edits (CX plan §12.5, R12-M6). PR B may only
 * add optional props / slots to these components; with those unset, the
 * markup must stay byte-identical — so these snapshots are never updated by
 * that PR. A snapshot change here means a customer page changed.
 */

vi.mock("next/image", () => ({
  default: (props: { src: string; alt: string; sizes?: string; loading?: string; fetchPriority?: string }) =>
    createElement("img", { src: props.src, alt: props.alt, "data-sizes": props.sizes, "data-loading": props.loading, "data-priority": props.fetchPriority }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/search",
}));
// LotCard imports gtag for its click handler only; nothing fires during a render.
vi.mock("@/lib/analytics/gtag", () => ({ trackSelectItem: () => {} }));

import { LotCard } from "../lot-card";
import { MobileMapCard } from "../mobile-map-card";
import { SearchHeader } from "../search-header";
import { SearchResultsList } from "../search-results-list";
import type { UnifiedLot } from "@/types/lot";

const noop = () => {};

const FULL_LOT: UnifiedLot = {
  id: "reslab-132",
  source: "reslab",
  sourceId: "132",
  reslabLocationId: 132,
  airportCode: "JFK",
  name: "DoubleTree by Hilton",
  slug: "doubletree-by-hilton",
  address: "135-40 140th St",
  city: "Jamaica",
  state: "NY",
  latitude: 40.667,
  longitude: -73.798,
  amenities: [
    { id: 1, name: "free_shuttle", displayName: "Free Shuttle" },
    { id: 2, name: "covered", displayName: "Covered Parking" },
    { id: 3, name: "security", displayName: "24 Hour Security" },
    { id: 4, name: "valet", displayName: "Valet" },
    { id: 5, name: "ev", displayName: "EV Charging" },
  ],
  photos: [{ id: "p1", url: "https://example.test/lot.jpg" }],
  rating: 4.6,
  reviewCount: 212,
  distanceFromAirport: 0.84,
  pricing: {
    minPrice: 24.95,
    currency: "$",
    parkingTypes: [{ id: 1, name: "Self park", price: 24.95, originalPrice: 29.95 }],
    grandTotal: 88.4,
    subtotal: 74.85,
    feesTotal: 3,
    taxTotal: 10.55,
    numberOfDays: 3,
  },
  availability: "limited",
  badges: ["most_booked", "lowest_total"],
  dueAtLocation: true,
};

const BARE_LOT: UnifiedLot = {
  id: "reslab-7",
  source: "reslab",
  sourceId: "7",
  name: "Plain Lot",
  slug: "plain-lot",
  address: "1 Airport Rd",
  city: "Queens",
  state: "NY",
  latitude: 40.6,
  longitude: -73.7,
  amenities: [],
  photos: [],
  availability: "available",
};

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

describe("parking search components — baseline markup (PR B must not change it)", () => {
  it("LotCard: a full lot, first and hovered", () => {
    expect(html(createElement(LotCard, { lot: FULL_LOT, isHovered: true, onHover: noop, onSelect: noop, isFirst: true }))).toMatchSnapshot();
  });

  it("LotCard: a bare lot, not hovered", () => {
    expect(html(createElement(LotCard, { lot: BARE_LOT, isHovered: false, onHover: noop, onSelect: noop }))).toMatchSnapshot();
  });

  it("MobileMapCard: a full lot and a bare lot", () => {
    expect(html(createElement(MobileMapCard, { lot: FULL_LOT, onSelect: noop }))).toMatchSnapshot();
    expect(html(createElement(MobileMapCard, { lot: BARE_LOT, onSelect: noop }))).toMatchSnapshot();
  });

  it("SearchHeader: JFK with both dates, and with no dates", () => {
    const base = {
      tab: "parking" as const,
      onTabChange: noop,
      onAirportChange: noop,
      onDepartDateChange: noop,
      onReturnDateChange: noop,
      onSearch: noop,
    };
    expect(html(createElement(SearchHeader, { ...base, airport: "JFK", departDate: "2026-11-10", returnDate: "2026-11-14" }))).toMatchSnapshot();
    expect(html(createElement(SearchHeader, { ...base, airport: "ZZZ", departDate: "", returnDate: "" }))).toMatchSnapshot();
  });

  it("SearchResultsList: lots with a partial banner, and the empty list", () => {
    const base = {
      tab: "parking" as const,
      location: "New York",
      sortBy: "popularity" as const,
      onSortChange: noop,
      onHover: noop,
      onSelect: noop,
    };
    expect(
      html(createElement(SearchResultsList, { ...base, lots: [FULL_LOT, BARE_LOT], hoveredId: "reslab-7", partialResults: true, onRetry: noop }))
    ).toMatchSnapshot();
    expect(html(createElement(SearchResultsList, { ...base, lots: [], hoveredId: null, className: "hidden lg:block" }))).toMatchSnapshot();
  });
});
