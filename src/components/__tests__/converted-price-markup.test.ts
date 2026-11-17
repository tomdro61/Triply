import { describe, it, expect, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import fs from "node:fs";
import path from "node:path";

/**
 * A lot whose price we convert from Canadian dollars (`lot.fxRateId`) never
 * shows an amount under a bare "$": a customer there reads it as Canadian
 * dollars, and we charge US dollars. Every price surface a converted lot can
 * reach BEFORE paying is rendered here and must show "US$" on every amount.
 *
 * The US side of each surface is pinned in us-price-markup-baseline.test.ts
 * and the search baseline snapshots.
 */

vi.mock("next/image", () => ({
  default: (props: { src: string; alt: string }) => createElement("img", { src: props.src, alt: props.alt }),
}));
vi.mock("next/link", () => ({
  default: (props: { href: string; children?: ReactNode; className?: string }) =>
    createElement("a", { href: props.href, className: props.className }, props.children),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/",
}));
vi.mock("@/lib/analytics/gtag", () => ({ trackSelectItem: () => {} }));
vi.mock("@/components/airport/search-widget", () => ({ SearchWidget: () => null }));
vi.mock("react-map-gl/mapbox", () => ({
  Marker: (props: { children?: ReactNode }) => createElement("div", null, props.children),
}));
// The payment form's Stripe pieces: not loaded in a render, and not a price surface.
vi.mock("@stripe/react-stripe-js", () => ({
  useStripe: () => null,
  useElements: () => null,
  PaymentElement: () => null,
}));
vi.mock("@/components/checkout/protection-plan", () => ({ ProtectionPlan: () => null }));

import { LotCard } from "@/components/search/lot-card";
import { MobileMapCard } from "@/components/search/mobile-map-card";
import { SearchResultsList } from "@/components/search/search-results-list";
import { PriceMarker } from "@/components/map/price-marker";
import { PriceHeadline } from "@/components/lot/price-headline";
import { PriceFooter } from "@/components/lot/price-footer";
import { PriceBreakdown } from "@/components/lot/price-breakdown";
import type { ShownPrice } from "@/components/lot/shown-price";
import { LotGrid } from "@/components/airport/lot-grid";
import { RatesTable } from "@/components/airport/rates-table";
import { HeroSection } from "@/components/airport/hero-section";
import { OrderSummary } from "@/components/checkout/order-summary";
import { StripePaymentForm } from "@/components/checkout/stripe-payment-form";
import { generateSEOContent, generateFAQs } from "@/lib/airport-page/content";
import { buildLotSchema } from "@/lib/seo/lot-schema";
import { fxStampMetadata, PARK_GUARD_ON_CONVERTED_LOTS } from "@/lib/fx/cad-usd";
import { CURRENCY_NOTICE_VERSION, USD_CHARGE_LINE, USD_PRICES_LINE, anyUsdLabelled, currencySign, isUsdLabelled, money } from "@/lib/fx/usd-label";
import type { AirportPageData } from "@/lib/airport-page/data";
import { getAirportByCode, type Airport } from "@/config/airports";
import type { UnifiedLot } from "@/types/lot";
import type { PriceBreakdown as CheckoutPriceBreakdown } from "@/types/checkout";

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);
const noop = () => {};

/** A "$" directly before a digit that is not part of "US$". */
const BARE_DOLLAR = /(?<!US)\$\s*\d/;
/** How many amounts the text shows. */
const amounts = (text: string) => (text.match(/\$\s*\d/g) ?? []).length;

/** Every amount is labelled, and there is at least `atLeast` of them (a surface that lost its prices must not pass). */
function expectAllLabelled(text: string, atLeast: number) {
  expect(text).not.toMatch(BARE_DOLLAR);
  expect(amounts(text)).toBeGreaterThanOrEqual(atLeast);
  expect((text.match(/US\$\s*\d/g) ?? []).length).toBe(amounts(text));
}

const lot = (id: number, name: string, minPrice: number, extra: Partial<UnifiedLot> = {}): UnifiedLot => ({
  id: `reslab-${id}`,
  source: "reslab",
  sourceId: String(id),
  reslabLocationId: id,
  airportCode: "YUL",
  name,
  slug: name.toLowerCase().replace(/\s+/g, "-"),
  address: "1 Rue Test",
  city: "Montreal",
  state: "QC",
  latitude: 45.5,
  longitude: -73.56,
  amenities: [{ id: 1, name: "free_shuttle", displayName: "Free Shuttle" }],
  photos: [{ id: "p1", url: "https://example.test/lot.jpg" }],
  rating: 4.6,
  reviewCount: 12,
  distanceFromAirport: 2.4,
  pricing: {
    minPrice,
    currency: "$",
    parkingTypes: [{ id: 1, name: "Self park", price: minPrice }],
    grandTotal: 62.96,
    subtotal: 55,
    feesTotal: 1.5,
    taxTotal: 6.46,
    numberOfDays: 5,
  },
  availability: "available",
  fxRateId: "r1",
  ...extra,
});

const CONVERTED = lot(330, "Autoparc Montreal", 11.3);
const CONVERTED_NO_TOTAL = lot(331, "No Total Lot", 9.03, {
  pricing: { minPrice: 9.03, currency: "$", parkingTypes: [{ id: 1, name: "Self park", price: 9.03 }] },
});
const LOTS = [CONVERTED, lot(178, "Baymont Inn", 13.58)];
const YUL = getAirportByCode("YUL") as Airport;
const DATA: AirportPageData = {
  lots: LOTS,
  topLots: LOTS,
  cheapestLot: LOTS[0],
  cheapestPrice: 11.3,
  closestLot: LOTS[0],
  totalLots: 2,
  priceRange: { min: 11.3, max: 13.58 },
  hasShuttle: true,
  commonAmenities: ["Free Shuttle"],
  distanceRange: { min: 2.4, max: 2.4 },
  locationsConsidered: 2,
};

const VIEW: ShownPrice = {
  kind: "view",
  view: { total: 68.91, perDay: 13.78, days: 5, parking: 59.5, discount: 3, taxes: 6.46, serviceFee: 5.95, dueAtLocation: 10 },
};
const RATE_ONLY: ShownPrice = { kind: "rate_only" };

const BREAKDOWN: CheckoutPriceBreakdown = {
  dailyRate: 11.9,
  days: 5,
  subtotal: 59.5,
  discount: 5,
  taxes: 6.46,
  fees: 1.5,
  serviceFee: 5.95,
  protectionPlan: 0,
  total: 68.41,
  dueNow: 58.41,
  dueAtLocation: 10,
};

const summary = (usdLabel: boolean) =>
  createElement(OrderSummary, {
    lot: CONVERTED,
    checkIn: "2026-12-17",
    checkOut: "2026-12-22",
    checkInTime: "8:00 AM",
    checkOutTime: "6:00 PM",
    priceBreakdown: BREAKDOWN,
    promoCode: "WELCOME5",
    promoPercent: null,
    onApplyPromo: async () => ({ ok: true as const }),
    onRemovePromo: noop,
    showFreeCancellation: true,
    usdLabel,
  });

const payStep = (usdLabel: boolean, dueAtLocation = false) =>
  createElement(StripePaymentForm, {
    priceBreakdown: dueAtLocation ? BREAKDOWN : { ...BREAKDOWN, dueAtLocation: 0, dueNow: BREAKDOWN.total },
    acceptedTerms: true,
    onTermsChange: noop,
    onBack: noop,
    onPaymentSuccess: async () => {},
    dueAtLocation,
    protectionHidden: true,
    protectionPlanChoice: "none",
    usdLabel,
    onProtectionPlanChange: noop,
  });

describe("the label helpers", () => {
  it("money and currencySign: US$ only when asked, and the plain form is today's formatting", () => {
    expect(money(30.385, false)).toBe("$" + (30.385).toFixed(2));
    expect(money(30.39, true)).toBe("US$30.39");
    expect(money(9.5, true, 0)).toBe("US$" + (9.5).toFixed(0));
    expect(currencySign(false)).toBe("$");
    expect(currencySign(true)).toBe("US$");
  });

  it("a lot is labelled only when it carries a rate id; a page when any of its lots does", () => {
    expect(isUsdLabelled({ fxRateId: "r1" })).toBe(true);
    for (const l of [{}, { fxRateId: undefined }, { fxRateId: "" }]) expect(isUsdLabelled(l)).toBe(false);
    expect(anyUsdLabelled([{}, { fxRateId: "r1" }])).toBe(true);
    expect(anyUsdLabelled([{}, {}])).toBe(false);
    expect(anyUsdLabelled([])).toBe(false);
  });
});

describe("a converted lot before paying — every amount reads US$", () => {
  it("search card: with a total, and with only a daily rate", () => {
    expectAllLabelled(html(createElement(LotCard, { lot: CONVERTED, isHovered: false, onHover: noop, onSelect: noop })), 2);
    expectAllLabelled(html(createElement(LotCard, { lot: CONVERTED_NO_TOTAL, isHovered: false, onHover: noop, onSelect: noop })), 1);
  });

  it("mobile map card: with a total, and with only a daily rate", () => {
    expectAllLabelled(html(createElement(MobileMapCard, { lot: CONVERTED, onSelect: noop })), 2);
    expectAllLabelled(html(createElement(MobileMapCard, { lot: CONVERTED_NO_TOTAL, onSelect: noop })), 1);
  });

  it("map pin", () => {
    const pin = (usdLabel: boolean) =>
      html(createElement(PriceMarker, { id: "a", longitude: 0, latitude: 0, price: 13.78, usdLabel, isHovered: false, onHover: noop, onClick: noop }));
    expectAllLabelled(pin(true), 1);
    expect(pin(false)).toContain("$13.78");
    expect(pin(false)).not.toContain("US$");
  });

  it("results list: says the prices are US dollars, only when a listed lot is converted", () => {
    const base = { tab: "parking" as const, location: "Montreal", sortBy: "popularity" as const, onSortChange: noop, onHover: noop, onSelect: noop, hoveredId: null };
    const us = { ...CONVERTED, id: "reslab-9", fxRateId: undefined };
    const mixed = html(createElement(SearchResultsList, { ...base, lots: [us, CONVERTED] }));
    // On its own line, not beside the count (it squeezed the sort control).
    expect(mixed).toContain(`>${USD_PRICES_LINE}</p>`);
    expect(mixed).not.toContain("Results ·");
    expect(html(createElement(SearchResultsList, { ...base, lots: [us] }))).not.toContain(USD_PRICES_LINE);
    expect(html(createElement(SearchResultsList, { ...base, lots: [] }))).not.toContain(USD_PRICES_LINE);
  });

  it("lot page and side panel: headline, footer and breakdown", () => {
    expectAllLabelled(html(createElement(PriceHeadline, { shown: VIEW, dailyRate: 11.3, usdLabel: true })), 2);
    expectAllLabelled(html(createElement(PriceHeadline, { shown: RATE_ONLY, dailyRate: 11.3, usdLabel: true })), 1);
    expectAllLabelled(html(createElement(PriceFooter, { shown: VIEW, dailyRate: 11.3, usdLabel: true })), 2);
    expectAllLabelled(html(createElement(PriceFooter, { shown: RATE_ONLY, dailyRate: 11.3, usdLabel: true })), 1);
    // parking label + parking + discount + taxes + service fee + total + due at location
    expectAllLabelled(html(createElement(PriceBreakdown, { shown: VIEW, usdLabel: true })), 7);
  });

  it("airport page: grid, rates table, hero, generated text, FAQ and lot structured data", () => {
    expectAllLabelled(html(createElement(LotGrid, { airport: YUL, lots: LOTS })), 2);
    expectAllLabelled(html(createElement(RatesTable, { airport: YUL, lots: LOTS })), 2);
    expectAllLabelled(html(createElement(HeroSection, { airport: YUL, data: DATA })), 1);
    expectAllLabelled(JSON.stringify(generateSEOContent(YUL, DATA)), 3);
    expectAllLabelled(JSON.stringify(generateFAQs(YUL, DATA)), 1);
    expectAllLabelled(String(buildLotSchema(CONVERTED, YUL.slug, CONVERTED.slug).priceRange), 1);
  });

  it("an airport page that lists one converted lot labels its page-level figures even when the cheapest lot is not converted", () => {
    const us = { ...LOTS[1], fxRateId: undefined };
    const data = { ...DATA, lots: [us, CONVERTED], cheapestLot: us };
    expectAllLabelled(html(createElement(HeroSection, { airport: YUL, data })), 1);
    expectAllLabelled(JSON.stringify(generateSEOContent(YUL, data)), 3);
  });

  it("checkout summary: every row, the promo line, and the total row says USD", () => {
    const out = html(summary(true));
    // rate label, subtotal, promo widget, promo row, fees, service fee, taxes, total, due now, due at location
    expectAllLabelled(out, 10);
    expect(out).toContain("Total (USD)");
    const us = html(summary(false));
    expect(us).not.toContain("US$");
    expect(us).not.toContain("(USD)");
  });

  it("Pay step: the sentence sits above the Pay button, and the button carries US$", () => {
    const out = html(payStep(true));
    expect(out).toContain(USD_CHARGE_LINE);
    expect(out).toContain("Complete Booking - US$68.41");
    expect(out.indexOf(USD_CHARGE_LINE)).toBeLessThan(out.indexOf("Complete Booking - US$"));
    expectAllLabelled(out, 1);

    const withDue = html(payStep(true, true));
    expect(withDue).toContain("Pay Now - US$58.41");
    expectAllLabelled(withDue, 2);

    const us = html(payStep(false));
    expect(us).toContain("Complete Booking - $68.41");
    expect(us).not.toContain("US$");
    expect(us).not.toContain(USD_CHARGE_LINE);
  });

  it("the sticky footer of a converted lot puts the per-day figure above the total (US$ is too wide for one row on a phone)", () => {
    const converted = html(createElement(PriceFooter, { shown: VIEW, dailyRate: 11.3, usdLabel: true }));
    expect(converted.indexOf("US$13.78/day")).toBeLessThan(converted.indexOf("US$68.91"));
    expect(converted).not.toContain("items-baseline");
  });

  it("a page listing a converted and a US lot labels each row by its own lot", () => {
    const us = lot(9, "US Lot", 20, { fxRateId: undefined });
    for (const out of [
      html(createElement(LotGrid, { airport: YUL, lots: [CONVERTED, us] })),
      html(createElement(RatesTable, { airport: YUL, lots: [CONVERTED, us] })),
    ]) {
      expect(out).toContain("US$11.30");
      expect(out).toMatch(/(?<!US)\$20\.00/);
    }
  });

  it("the wording version: the stamp helper writes none (the checkout POST stamps the version the page sent)", () => {
    expect(fxStampMetadata({ id: "r1", micros: 720_000 })).toEqual({ reslabCurrency: "CAD", fxRateId: "r1", fxRateMicros: "720000" });
    expect(fxStampMetadata(null)).toEqual({ reslabCurrency: "USD" });
    expect(CURRENCY_NOTICE_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("protection plans (which print a bare $) stay off converted lots", () => {
    // protection-plan.tsx is exempt below only because of this switch.
    expect(PARK_GUARD_ON_CONVERTED_LOTS).toBe(false);
  });
});

/**
 * A new price surface must not forget the label. Any component or page-text
 * file under src/components, src/app/(main), src/app/api/chat or
 * src/lib/{airport-page,seo,promo,checkout-recovery} that formats a lot's
 * price must be one this file renders with a converted
 * lot (COVERED) or be listed in NOT_REACHABLE with the reason a converted lot
 * cannot show a price there.
 */
describe("no price surface is left out", () => {
  const ROOT = path.resolve(__dirname, "../..");
  const COVERED = new Set([
    "components/search/lot-card.tsx",
    "components/search/mobile-map-card.tsx",
    "components/search/search-map.tsx", // passes usdLabel to the pin (asserted below)
    "components/map/price-marker.tsx",
    "components/lot/price-headline.tsx",
    "components/lot/price-footer.tsx",
    "components/lot/price-breakdown.tsx",
    "components/airport/lot-grid.tsx",
    "components/airport/rates-table.tsx",
    "components/airport/hero-section.tsx",
    "components/checkout/order-summary.tsx",
    "components/checkout/promo-code.tsx",
    "components/checkout/stripe-payment-form.tsx",
    "components/checkout/checkout-form.tsx", // the dev-only button; passes usdLabel down (asserted below)
    "lib/airport-page/content.ts",
    "lib/seo/lot-schema.ts",
    "app/(main)/[slug]/airport-parking/page.tsx", // title and meta: page.test.ts
    "lib/promo/discount.ts", // the refusal's minimum: discount.test.ts and the checkout POST test
    "lib/checkout-recovery/email.ts", // the abandoned-checkout email: asserted below
    "app/api/chat/route.ts", // the assistant's price strings: asserted below
  ]);
  const NOT_REACHABLE: Record<string, string> = {
    "components/shared/featured-parking.tsx": "home page; fixed to JFK, LAX, ORD and MIA",
    "components/shared/comparison.tsx": "the home page's savings calculator: JFK and LGA figures, hard-coded",
    "components/comparison/comparison-body.tsx": "comparison pages cover BOS, DEN and PHX only",
    "components/chat/chat-parking-results.tsx": "prints the price strings app/api/chat/route.ts builds, which carry the label",
    "components/checkout/vehicle-size-selector.tsx": "direct lots only: priced in US dollars, never converted",
    "components/lot/vehicle-size-modal.tsx": "direct lots only: priced in US dollars, never converted",
    "components/checkout/protection-plan.tsx": "Park Guard is not offered on a converted lot (PARK_GUARD_ON_CONVERTED_LOTS)",
    "app/(main)/[slug]/spothero-vs-airportparkingreservations-vs-triply/page.tsx": "comparison pages cover BOS, DEN and PHX only",
  };
  /** Read a lot's price but print no amount themselves. */
  const NO_AMOUNT: Record<string, string> = {
    "components/lot/booking-widget.tsx": "hands the figures and the lot's label to the price boxes (asserted below)",
    "components/search/product-detail-slider.tsx": "hands the figures and the lot's label to the price boxes (asserted below)",
    "app/(main)/search/page.tsx": "an analytics value, not text on the page",
    "lib/airport-page/data.ts": "builds the page's figures; the components and text builders print them",
    "lib/airport-page/schemas.ts": "structured data: bare numbers beside priceCurrency USD, which is right for a converted price",
  };
  /** After paying, or staff-only: the record's label is its own piece of work (bookings.reslab_currency). */
  const AFTER_PAYING = /^(components\/(confirmation|reservations|admin|partner|park-stay|support)\/|app\/\(main\)\/(admin|partner|confirmation|reservations|checkout\/complete|park-stay)\b)/;

  // A lot's money fields and helpers, or a literal "$" written before a value
  // ("$${" in a template string; "${" opening a line or following a tag in JSX).
  const PRICE_CODE = /customer(Total|PerDay)FromPricing|priceViewFromPricing|pricing[?!]?\.(minPrice|grandTotal)|cheapestPrice|priceRange\.|priceBreakdown\.\w+\.toFixed|\$\$\{|^\s*\$\{[^}\n]*toFixed|>\$\{[^}\n]*toFixed|formatMoney\(|formatPrice\(/m;

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "__tests__" || entry.name === "__snapshots__") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, out);
      else if (/\.tsx?$/.test(entry.name)) out.push(full);
    }
    return out;
  }
  const rel = (f: string) => path.relative(ROOT, f).split(path.sep).join("/");

  it("every file that formats a lot price is covered here or named as unreachable", () => {
    const files = [
      ...walk(path.join(ROOT, "components")),
      ...walk(path.join(ROOT, "app/(main)")),
      ...walk(path.join(ROOT, "lib/airport-page")),
      ...walk(path.join(ROOT, "lib/seo")),
      ...walk(path.join(ROOT, "lib/promo")),
      ...walk(path.join(ROOT, "lib/checkout-recovery")),
      ...walk(path.join(ROOT, "app/api/chat")),
    ];
    const priced = files.filter((f) => PRICE_CODE.test(fs.readFileSync(f, "utf8"))).map(rel);
    // The scan itself must see the surfaces we know about, or it proves nothing.
    for (const known of ["components/search/lot-card.tsx", "components/airport/rates-table.tsx", "components/checkout/order-summary.tsx", "lib/airport-page/content.ts"]) {
      expect(priced).toContain(known);
    }
    const unaccounted = priced.filter((f) => !COVERED.has(f) && !(f in NOT_REACHABLE) && !(f in NO_AMOUNT) && !AFTER_PAYING.test(f));
    expect(unaccounted).toEqual([]);
  });

  it("the lists name real files", () => {
    for (const f of [...COVERED, ...Object.keys(NOT_REACHABLE), ...Object.keys(NO_AMOUNT)]) expect(fs.existsSync(path.join(ROOT, f)), f).toBe(true);
  });

  it("the callers hand the lot's own label down", () => {
    const read = (f: string) => fs.readFileSync(path.join(ROOT, f), "utf8");
    expect(read("components/search/search-map.tsx")).toMatch(/usdLabel=\{isUsdLabelled\(lot\)\}/);
    for (const f of ["components/lot/booking-widget.tsx", "components/search/product-detail-slider.tsx"]) {
      expect((read(f).match(/usdLabel=\{isUsdLabelled\(lot\)\}/g) ?? []).length).toBe(3);
    }
    const form = read("components/checkout/checkout-form.tsx");
    expect(form).toMatch(/const converted = !!\(costData\?\.fxRateId \|\| lot\.fxRateId\);/);
    expect((form.match(/usdLabel=\{converted\}/g) ?? []).length).toBe(2);
    expect(form).toMatch(/promoRefusalMessage\(discount\.refused, rule, converted\)/);
    // The assistant and the abandoned-checkout email build their own price strings.
    expect((read("app/api/chat/route.ts").match(/money\([^)]*, isUsdLabelled\(lot\)\)/g) ?? []).length).toBe(2);
    expect(read("app/api/chat/route.ts")).not.toMatch(/`\$\$\{/);
    expect(read("lib/checkout-recovery/email.ts")).toMatch(/money\(c\.amountCents \/ 100, c\.usdLabel\)/);
    expect(read("lib/checkout-recovery/select.ts")).toMatch(/usdLabel: readFxStamp\(pi\.metadata\)\.kind === "cad"/);
  });
});
