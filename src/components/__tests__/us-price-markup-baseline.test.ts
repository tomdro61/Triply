import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * Baseline markup and text of every price surface a lot priced in US dollars
 * shows, captured from `main` BEFORE the "US$" label for converted (Canadian)
 * lots was added. The label may only appear on a converted lot: for the US
 * lots below the output must stay byte-identical, so these snapshots are never
 * updated by that work. A snapshot change here means a US customer page changed.
 */

vi.mock("next/image", () => ({
  default: (props: { src: string; alt: string }) => createElement("img", { src: props.src, alt: props.alt }),
}));
vi.mock("next/link", () => ({
  default: (props: { href: string; children?: unknown; className?: string }) =>
    createElement("a", { href: props.href, className: props.className }, props.children as never),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/",
}));
// The hero's search form is not a price surface; its own tests cover it.
vi.mock("@/components/airport/search-widget", () => ({ SearchWidget: () => null }));

import { PriceHeadline } from "@/components/lot/price-headline";
import { PriceFooter } from "@/components/lot/price-footer";
import { PriceBreakdown } from "@/components/lot/price-breakdown";
import type { ShownPrice } from "@/components/lot/shown-price";
import { LotGrid } from "@/components/airport/lot-grid";
import { RatesTable } from "@/components/airport/rates-table";
import { HeroSection } from "@/components/airport/hero-section";
import { OrderSummary } from "@/components/checkout/order-summary";
import { generateSEOContent, generateFAQs } from "@/lib/airport-page/content";
import { buildLotSchema } from "@/lib/seo/lot-schema";
import type { AirportPageData } from "@/lib/airport-page/data";
import type { Airport } from "@/config/airports";
import { getAirportByCode } from "@/config/airports";
import type { UnifiedLot } from "@/types/lot";
import type { PriceBreakdown as CheckoutPriceBreakdown } from "@/types/checkout";

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);
const noop = () => {};

const VIEW: ShownPrice = {
  kind: "view",
  view: { total: 94.35, perDay: 31.45, days: 3, parking: 80.85, discount: 3, taxes: 10.55, serviceFee: 5.95, dueAtLocation: 20 },
};
const RATE_ONLY: ShownPrice = { kind: "rate_only" };
const MESSAGE: ShownPrice = { kind: "message", text: "Select your times to see your total", short: "Select times for your total" };

const lot = (id: number, name: string, minPrice: number, distance: number): UnifiedLot => ({
  id: `reslab-${id}`,
  source: "reslab",
  sourceId: String(id),
  reslabLocationId: id,
  airportCode: "JFK",
  name,
  slug: name.toLowerCase().replace(/\s+/g, "-"),
  address: "135-40 140th St",
  city: "Jamaica",
  state: "NY",
  latitude: 40.667,
  longitude: -73.798,
  amenities: [{ id: 1, name: "free_shuttle", displayName: "Free Shuttle" }],
  photos: [{ id: "p1", url: "https://example.test/lot.jpg" }],
  rating: 4.6,
  reviewCount: 212,
  distanceFromAirport: distance,
  pricing: {
    minPrice,
    currency: "$",
    parkingTypes: [{ id: 1, name: "Self park", price: minPrice }],
    grandTotal: 88.4,
    subtotal: 74.85,
    feesTotal: 3,
    taxTotal: 10.55,
    numberOfDays: 3,
  },
  availability: "available",
});

const LOTS = [lot(132, "DoubleTree by Hilton", 24.95, 0.84), lot(140, "Budget Lot", 9.5, 2.3)];
const JFK = getAirportByCode("JFK") as Airport;
const DATA: AirportPageData = {
  lots: LOTS,
  topLots: LOTS,
  cheapestLot: LOTS[1],
  cheapestPrice: 9.5,
  closestLot: LOTS[0],
  totalLots: 2,
  priceRange: { min: 9.5, max: 24.95 },
  hasShuttle: true,
  commonAmenities: ["Free Shuttle"],
  distanceRange: { min: 0.84, max: 2.3 },
  locationsConsidered: 2,
};

const BREAKDOWN: CheckoutPriceBreakdown = {
  dailyRate: 24.95,
  days: 3,
  subtotal: 74.85,
  discount: 5,
  taxes: 10.55,
  fees: 3,
  serviceFee: 5.95,
  protectionPlan: 12,
  total: 101.35,
  dueNow: 81.35,
  dueAtLocation: 20,
};

const summary = (extra: Partial<Parameters<typeof OrderSummary>[0]> = {}) =>
  createElement(OrderSummary, {
    lot: LOTS[0],
    checkIn: "2026-12-17",
    checkOut: "2026-12-20",
    checkInTime: "8:00 AM",
    checkOutTime: "6:00 PM",
    priceBreakdown: BREAKDOWN,
    promoCode: "WELCOME5",
    promoPercent: null,
    onApplyPromo: async () => ({ ok: true as const }),
    onRemovePromo: noop,
    showFreeCancellation: true,
    usdLabel: false,
    ...extra,
  });

describe("US lots — price markup baseline (the US$ label work must not change it)", () => {
  it("lot page price headline: total, daily rate only, message", () => {
    for (const shown of [VIEW, RATE_ONLY, MESSAGE]) {
      expect(html(createElement(PriceHeadline, { shown, dailyRate: 24.95, usdLabel: false }))).toMatchSnapshot();
    }
  });

  it("lot page price footer: total, daily rate only, message", () => {
    for (const shown of [VIEW, RATE_ONLY, MESSAGE]) {
      expect(html(createElement(PriceFooter, { shown, dailyRate: 24.95, usdLabel: false }))).toMatchSnapshot();
    }
  });

  it("lot page price breakdown", () => {
    expect(html(createElement(PriceBreakdown, { shown: VIEW, usdLabel: false }))).toMatchSnapshot();
  });

  it("airport page: lot grid, rates table, hero", () => {
    expect(html(createElement(LotGrid, { airport: JFK, lots: LOTS }))).toMatchSnapshot();
    expect(html(createElement(RatesTable, { airport: JFK, lots: LOTS }))).toMatchSnapshot();
    expect(html(createElement(HeroSection, { airport: JFK, data: DATA }))).toMatchSnapshot();
  });

  it("airport page: generated text and FAQ", () => {
    expect(generateSEOContent(JFK, DATA)).toMatchSnapshot();
    expect(generateFAQs(JFK, DATA)).toMatchSnapshot();
  });

  it("lot structured data", () => {
    expect(buildLotSchema(LOTS[0], JFK.slug, LOTS[0].slug)).toMatchSnapshot();
  });

  it("checkout order summary: part due at the lot, and an oversized vehicle on a direct lot", () => {
    expect(html(summary())).toMatchSnapshot();
    expect(
      html(
        summary({
          priceBreakdown: { ...BREAKDOWN, dueAtLocation: 0, dueNow: 101.35 },
          vehicleEstimate: { label: "Oversized SUV", surchargeCents: 1000, surchargeTaxCents: 89, atLotCents: 1089, tripTotalCents: 11224 },
        })
      )
    ).toMatchSnapshot();
  });
});
