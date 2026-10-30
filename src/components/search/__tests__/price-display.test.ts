import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * The search cards and map pins print "Taxes & fees included" — these pin the
 * numbers beside it explicitly, so a snapshot regeneration can't quietly accept
 * a wrong price, and pin the cases where the claim must NOT appear.
 */

vi.mock("next/image", () => ({
  default: (props: { src: string; alt: string }) => createElement("img", { src: props.src, alt: props.alt }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/search",
}));
vi.mock("@/lib/analytics/gtag", () => ({ trackSelectItem: () => {} }));

// The map itself needs a browser; capture what each pin is asked to show.
const pinPrices = new Map<string, number | null>();
vi.mock("@/components/map", () => ({
  MapboxMap: ({ children }: { children: unknown }) => children,
  AirportMarker: () => null,
  PriceMarker: (props: { id: string; price: number | null }) => {
    pinPrices.set(props.id, props.price);
    return null;
  },
}));

import { LotCard } from "../lot-card";
import { MobileMapCard } from "../mobile-map-card";
import { SearchMap } from "../search-map";
import { getAirportByCode } from "@/config/airports";
import { directLotFromRow } from "@/lib/direct/store";
import { directLotToUnified } from "@/lib/direct/adapter";
import { directLotRow } from "@/lib/direct/__tests__/fixtures";
import type { UnifiedLot } from "@/types/lot";

const noop = () => {};
const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);
const INCLUDED = "Taxes &amp; fees included";

// ResLab lot, 3 billed days: 88.40 + service fee max(5.95, 6 % × 77.85) = 94.35 → 31.45/day.
const PRICED: UnifiedLot = {
  id: "reslab-132",
  source: "reslab",
  sourceId: "132",
  reslabLocationId: 132,
  name: "DoubleTree by Hilton",
  slug: "doubletree-by-hilton",
  address: "135-40 140th St",
  city: "Jamaica",
  state: "NY",
  latitude: 40.667,
  longitude: -73.798,
  amenities: [],
  photos: [],
  pricing: {
    minPrice: 24.95,
    currency: "$",
    parkingTypes: [],
    grandTotal: 88.4,
    subtotal: 74.85,
    feesTotal: 3,
    taxTotal: 10.55,
    numberOfDays: 3,
  },
  availability: "available",
  dueAtLocation: true,
};

// A total but no billed-day count: the total still shows, the per-day line doesn't.
const NO_DAYS: UnifiedLot = {
  ...PRICED,
  id: "reslab-133",
  pricing: { ...PRICED.pricing!, numberOfDays: undefined },
};

// A direct lot with no priced window: the daily rate only — never "included".
const directOut = directLotFromRow(directLotRow());
if (!directOut.lot) throw new Error(directOut.reason);
const UNPRICED_DIRECT = directLotToUnified(directOut.lot, getAirportByCode("JFK")!, null);

describe("search price display", () => {
  it("LotCard leads with the fee-inclusive total, its per-day figure and the included line", () => {
    const out = html(createElement(LotCard, { lot: PRICED, isHovered: false, onHover: noop, onSelect: noop }));
    expect(out).toContain("$94.35");
    expect(out).toContain("$31.45/day");
    expect(out).toContain(INCLUDED);
    expect(out).toContain("Pay at Location");
    expect(out).not.toContain("$24.95"); // the pre-tax daily rate without our fee
  });

  it("MobileMapCard shows the same total, per-day figure and included line", () => {
    const out = html(createElement(MobileMapCard, { lot: PRICED, onSelect: noop }));
    expect(out).toContain("$94.35");
    expect(out).toContain("$31.45/day");
    expect(out).toContain(INCLUDED);
    expect(out).not.toContain("$24.95");
  });

  it("without a billed-day count the cards show the total and no per-day figure", () => {
    for (const out of [
      html(createElement(LotCard, { lot: NO_DAYS, isHovered: false, onHover: noop, onSelect: noop })),
      html(createElement(MobileMapCard, { lot: NO_DAYS, onSelect: noop })),
    ]) {
      expect(out).toContain("$94.35");
      expect(out).toContain(INCLUDED);
      expect(out).not.toContain("/day");
    }
  });

  it("a lot with only a daily rate shows it per day and never claims taxes and fees are included", () => {
    expect(UNPRICED_DIRECT.pricing?.grandTotal).toBeUndefined();
    for (const out of [
      html(createElement(LotCard, { lot: UNPRICED_DIRECT, isHovered: false, onHover: noop, onSelect: noop })),
      html(createElement(MobileMapCard, { lot: UNPRICED_DIRECT, onSelect: noop })),
    ]) {
      expect(out).toContain("$9.95");
      expect(out).toContain("/day");
      expect(out).not.toContain("included");
    }
  });

  it("map pins show the card's per-day figure, and no label rather than a fee-less rate", () => {
    pinPrices.clear();
    html(createElement(SearchMap, { lots: [PRICED, NO_DAYS, UNPRICED_DIRECT], hoveredId: null, onHover: noop, onSelect: noop }));
    expect(pinPrices.get(PRICED.id)).toBeCloseTo(31.45, 10);
    expect(pinPrices.get(NO_DAYS.id)).toBeNull();
    expect(pinPrices.get(UNPRICED_DIRECT.id)).toBeNull();
  });
});
