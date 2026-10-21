import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * The optional slots PR B adds to the parking search components (CX plan
 * §4, §12.1). Unset, the markup is the baseline (baseline-render.test.ts);
 * set, the slot renders where the plan says.
 */

vi.mock("next/image", () => ({ default: (props: { src: string; alt: string }) => createElement("img", { src: props.src, alt: props.alt }) }));
vi.mock("@/lib/analytics/gtag", () => ({ trackSelectItem: () => {} }));

import { LotCard } from "../lot-card";
import { MobileMapCard } from "../mobile-map-card";
import { SearchHeader } from "../search-header";
import { SearchResultsList } from "../search-results-list";
import type { UnifiedLot } from "@/types/lot";

const noop = () => {};
const lot = (id: string, reslabLocationId?: number): UnifiedLot => ({
  id,
  source: "reslab",
  sourceId: id,
  reslabLocationId,
  name: `Lot ${id}`,
  slug: id,
  address: "1 Airport Rd",
  city: "Queens",
  state: "NY",
  latitude: 40.6,
  longitude: -73.7,
  amenities: [],
  photos: [],
  availability: "available",
  distanceFromAirport: 1.2,
});
const marker = (text: string) => createElement("b", { "data-slot": "x" }, text);

describe("extraBadge / renderExtraBadge", () => {
  it("LotCard and MobileMapCard render the badge right under the distance line", () => {
    for (const html of [
      renderToStaticMarkup(createElement(LotCard, { lot: lot("a"), isHovered: false, onHover: noop, onSelect: noop, extraBadge: marker("BADGE") })),
      renderToStaticMarkup(createElement(MobileMapCard, { lot: lot("a"), onSelect: noop, extraBadge: marker("BADGE") })),
    ]) {
      expect(html).toContain('<b data-slot="x">BADGE</b>');
      expect(html.indexOf("BADGE")).toBeGreaterThan(html.indexOf("mi from airport"));
    }
  });

  it("SearchResultsList asks renderExtraBadge once per lot and hands each card its own badge", () => {
    const render = vi.fn((l: UnifiedLot) => marker(`for-${l.reslabLocationId ?? "none"}`));
    const html = renderToStaticMarkup(
      createElement(SearchResultsList, {
        lots: [lot("a", 132), lot("b")],
        tab: "parking",
        location: "New York",
        sortBy: "popularity",
        onSortChange: noop,
        hoveredId: null,
        onHover: noop,
        onSelect: noop,
        renderExtraBadge: render,
      })
    );
    expect(render).toHaveBeenCalledTimes(2);
    expect(html).toContain("for-132");
    expect(html).toContain("for-none");
  });
});

describe("SearchHeader modeSwitch", () => {
  it("snapshot: the slot in BOTH the mobile area (above the summary button) and on its own line above the desktop fields", () => {
    const html = renderToStaticMarkup(
      createElement(SearchHeader, {
        tab: "parking",
        onTabChange: noop,
        airport: "JFK",
        onAirportChange: noop,
        departDate: "2026-11-10",
        onDepartDateChange: noop,
        returnDate: "2026-11-14",
        onReturnDateChange: noop,
        onSearch: noop,
        modeSwitch: marker("SWITCH"),
      })
    );
    // The wrappers the slot lands in, in document order (mobile, then desktop)…
    const places = [...html.matchAll(/<div class="([^"]*)"><b data-slot="x">SWITCH<\/b><\/div>/g)].map((m) => m[1]);
    expect(places).toMatchSnapshot();
    // …and the whole header with the slot set.
    expect(html).toMatchSnapshot();
  });

  it("renders above the mobile summary bar (outside its button) and on its own line above the desktop fields (as on /park-stay)", () => {
    const html = renderToStaticMarkup(
      createElement(SearchHeader, {
        tab: "parking",
        onTabChange: noop,
        airport: "JFK",
        onAirportChange: noop,
        departDate: "2026-11-10",
        onDepartDateChange: noop,
        returnDate: "2026-11-14",
        onReturnDateChange: noop,
        onSearch: noop,
        modeSwitch: marker("SWITCH"),
      })
    );
    const first = html.indexOf("SWITCH");
    const second = html.indexOf("SWITCH", first + 1);
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first);
    // Mobile: before the summary <button>, not inside it.
    expect(first).toBeLessThan(html.indexOf("<button"));
    // Desktop: before the airport field of the full form.
    const desktop = html.indexOf("hidden lg:block");
    expect(second).toBeGreaterThan(desktop);
    expect(second).toBeLessThan(html.indexOf("(JFK)", desktop));
    // Its own line: outside (before) the fields row, not an item inside it.
    expect(second).toBeLessThan(html.indexOf("flex flex-col xl:flex-row gap-3", desktop));
  });
});
