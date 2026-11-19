import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BlogPriceCard } from "../BlogPriceCard";
import { BlogPriceBar } from "../BlogPriceBar";
import type { BlogPriceSnapshot } from "@/lib/blog/price-snapshot";

const snap: BlogPriceSnapshot = {
  airportCode: "JFK",
  airportSlug: "new-york-jfk",
  fromPrice: 12.5,
  fromUsdLabel: false,
  totalLots: 9,
  fetchedAt: 1,
  lots: [
    { name: "Lot A", slug: "lot-a", price: 12.5, usdLabel: false, shuttle: true, distance: 1.24 },
    { name: "Lot B", slug: "lot-b", price: 15, usdLabel: false, shuttle: false, distance: null },
  ],
};

describe("BlogPriceCard", () => {
  const html = renderToStaticMarkup(createElement(BlogPriceCard, { snapshot: snap }));

  it("links each lot to its lot page and the rest to the airport search", () => {
    expect(html).toContain('href="/new-york-jfk/airport-parking/lot-a"');
    expect(html).toContain('href="/new-york-jfk/airport-parking/lot-b"');
    expect(html).toContain('href="/search?airport=JFK"');
    expect(html).toContain("Compare all 9 JFK lots");
  });

  it("shows the from price and each lot's daily rate", () => {
    expect(html).toContain("JFK parking from $12.50/day");
    expect(html).toContain("$15.00");
    expect(html).toContain("1.2 mi");
  });

  it("never claims a lot has no shuttle, and never claims fees are included", () => {
    expect(html.match(/Shuttle/g)?.length).toBe(1);
    expect(html).not.toMatch(/no shuttle/i);
    expect(html).not.toMatch(/fees included/i);
  });

  it("drops 'all N' when every lot is already listed", () => {
    const out = renderToStaticMarkup(createElement(BlogPriceCard, { snapshot: { ...snap, totalLots: 2 } }));
    expect(out).toContain("Compare JFK lots for your dates");
  });

  it("labels US$ on a converted (Canadian) lot", () => {
    const out = renderToStaticMarkup(
      createElement(BlogPriceCard, {
        snapshot: {
          ...snap,
          airportCode: "YYZ",
          airportSlug: "toronto-yyz",
          fromPrice: 18,
          fromUsdLabel: true,
          lots: [{ name: "C", slug: "c", price: 18, usdLabel: true, shuttle: false, distance: null }],
        },
      })
    );
    expect(out).toContain("from US$18.00/day");
    expect(out).toContain("US$18.00");
  });
});

describe("BlogPriceBar", () => {
  it("renders nothing on the server (it only appears after the reader scrolls past the top search box)", () => {
    // Show / hide / close need a browser (IntersectionObserver); this repo's vitest runs in node.
    expect(renderToStaticMarkup(createElement(BlogPriceBar, { airportCode: "JFK", fromPrice: 12.5, fromUsdLabel: false }))).toBe("");
  });
});
