import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { LivePrice } from "../use-live-price";

/**
 * What the lot page booking box draws for each live price state — the glue
 * between useLivePrice and the screen. The hook is replaced by a fixed state;
 * its own logic is tested in use-live-price.test.ts.
 */
const state: { current: LivePrice } = { current: { kind: "as_loaded" } };
vi.mock("../use-live-price", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../use-live-price")>()),
  useLivePrice: () => state.current,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, prefetch: () => {} }),
}));
vi.mock("@/lib/analytics/gtag", () => ({ trackLotView: () => {} }));

import { BookingWidget } from "../booking-widget";
import { settleQuote } from "../use-live-price";
import type { UnifiedLot } from "@/types/lot";

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
  photos: [],
  // Loaded at 10 AM → 2 PM: $76.10 for 4 days.
  pricing: { minPrice: 15.96, currency: "$", parkingTypes: [], grandTotal: 70.15, subtotal: 59.85, feesTotal: 3.99, taxTotal: 6.31, numberOfDays: 4 },
  availability: "available",
  dueAtLocation: true,
  dueAtLocationAmount: 54.95,
};

const render = (live: LivePrice) => {
  state.current = live;
  return renderToStaticMarkup(
    createElement(BookingWidget, {
      lot: LOT,
      initialCheckIn: "2026-12-10",
      initialCheckOut: "2026-12-13",
      // Times present so the "select times" gate is off and Reserve depends on the price state.
      initialCheckInTime: "8:00 AM",
      initialCheckOutTime: "8:00 AM",
      airportTimeZone: "America/New_York",
    })
  );
};
const reserveDisabled = (html: string) => /<button[^>]*disabled=""[^>]*>Reserve Now<\/button>/.test(html);

const READY = settleQuote(200, {
  quote: { grandTotal: 55.2, subtotal: 46.25, feesTotal: 3.99, taxTotal: 4.96, serviceFee: 5.95, dueAtLocation: 43.24, numberOfDays: 3, soldOut: false },
});

describe("BookingWidget price states", () => {
  it("as loaded: the page's total, per-day, the included line and a breakdown that matches", () => {
    const html = render({ kind: "as_loaded" });
    expect(html).toContain("$76.10");
    expect(html).toContain("$19.03/day");
    expect(html).toContain("Taxes &amp; fees included");
    expect(html).toContain("$54.95"); // due at location
    expect(reserveDisabled(html)).toBe(false);
  });

  it("re-priced: the quote's figures replace the loaded ones everywhere", () => {
    const html = render(READY);
    expect(html).toContain("$61.15");
    expect(html).toContain("$43.24");
    expect(html).not.toContain("$76.10");
    expect(html).not.toContain("$54.95");
  });

  it.each([
    [{ kind: "needs_times" } as LivePrice, "Select your times to see your total"],
    [{ kind: "loading" } as LivePrice, "Updating price…"],
    [{ kind: "error" } as LivePrice, "You&#x27;ll see the exact total at checkout"],
  ])("%o: a message, no figure, no breakdown", (live, text) => {
    const html = render(live);
    expect(html).toContain(text);
    expect(html).not.toContain("$76.10");
    expect(html).not.toContain("included");
    expect(html).not.toContain(">Total<");
  });

  it.each([{ kind: "sold_out" } as LivePrice, { kind: "not_bookable" } as LivePrice])("%o: Reserve is off", (live) => {
    const html = render(live);
    expect(reserveDisabled(html)).toBe(true);
    expect(html).toContain("Not available for these dates and times");
    expect(html).not.toContain("$76.10");
  });
});
