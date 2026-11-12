/**
 * The standard funnel events (search, select_item, view_item, begin_checkout):
 * their shapes, that they can never throw into a page, and where they fire.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkoutLoadValue, isPricedLoad } from "../checkout-funnel";
import { trackBeginCheckout, trackLotView, trackSearch, trackSelectItem } from "../gtag";

const cost = (over: Record<string, unknown> = {}) => ({
  costsToken: "tok" as string | null,
  grandTotal: 82,
  serviceFee: 10,
  soldOut: false,
  ...over,
});

describe("isPricedLoad / checkoutLoadValue", () => {
  it("a ResLab lot with a costs token is priced: grand total plus the service fee", () => {
    expect(isPricedLoad(cost())).toBe(true);
    expect(checkoutLoadValue(cost())).toBe(92);
    expect(checkoutLoadValue(cost({ grandTotal: 44.125, serviceFee: 5.99 }))).toBe(50.12);
  });

  it("a ResLab lot without a token fell back to an estimate: not priced, no value", () => {
    expect(isPricedLoad(cost({ costsToken: null }))).toBe(false);
    expect(checkoutLoadValue(cost({ costsToken: null }))).toBeUndefined();
  });

  it("a direct lot never has a token and is still priced", () => {
    const direct = cost({ costsToken: null, direct: { days: 4, taxRatePercent: 8, vehicleSurcharges: [] } });
    expect(isPricedLoad(direct)).toBe(true);
    expect(checkoutLoadValue(direct)).toBe(92);
  });

  it("sold out, missing, or a total that is not a number: no value", () => {
    expect(isPricedLoad(cost({ soldOut: true }))).toBe(false);
    expect(checkoutLoadValue(null)).toBeUndefined();
    expect(checkoutLoadValue(undefined)).toBeUndefined();
    expect(checkoutLoadValue(cost({ grandTotal: Number.NaN }))).toBeUndefined();
  });
});

describe("event shapes", () => {
  const gtag = vi.fn();
  beforeEach(() => {
    gtag.mockReset();
    vi.stubGlobal("window", { gtag });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("view_item carries an items array and says where the lot was seen", () => {
    trackLotView({ id: "reslab-132", name: "DoubleTree", price: 11.25, surface: "search_panel" });
    expect(gtag).toHaveBeenCalledWith("event", "view_item", {
      currency: "USD",
      items: [{ item_id: "reslab-132", item_name: "DoubleTree", price: 11.25 }],
      item_surface: "search_panel",
    });
  });

  it("select_item names the list and the position", () => {
    trackSelectItem({ id: "reslab-132", name: "DoubleTree", price: 11.25, airport: "JFK", list: "search_map", position: 0 });
    const [, name, params] = gtag.mock.calls[0];
    expect(name).toBe("select_item");
    expect(params).toMatchObject({ item_list_name: "search_map", airport_code: "JFK" });
    expect(params.items[0]).toMatchObject({ item_id: "reslab-132", index: 0 });
  });

  it("begin_checkout sends the value when the load is priced, and none when it is not", () => {
    trackBeginCheckout({ lotId: "reslab-132", lotName: "DoubleTree", total: 92 });
    expect(gtag.mock.calls[0][2]).toMatchObject({ value: 92, currency: "USD" });
    trackBeginCheckout({ lotId: "reslab-132", lotName: "DoubleTree", total: undefined });
    expect(gtag.mock.calls[1][2]).not.toHaveProperty("value");
    expect(gtag.mock.calls[1][2]).not.toHaveProperty("currency");
    expect(gtag.mock.calls[1][2].items[0].item_id).toBe("reslab-132");
  });

  it("search passes its params through", () => {
    trackSearch({ airport_code: "JFK", lots_shown: 0 });
    expect(gtag).toHaveBeenCalledWith("event", "search", { airport_code: "JFK", lots_shown: 0 });
  });
});

describe("analytics can never break a page", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("a throwing gtag is swallowed by every funnel event", () => {
    vi.stubGlobal("window", {
      gtag: () => {
        throw new Error("blocked");
      },
    });
    expect(() => trackSearch({ airport_code: "JFK" })).not.toThrow();
    expect(() => trackLotView({ id: "a", name: "A", surface: "lot_page" })).not.toThrow();
    expect(() => trackSelectItem({ id: "a", name: "A", list: "search_results" })).not.toThrow();
    expect(() => trackBeginCheckout({ lotId: "a", lotName: "A" })).not.toThrow();
  });

  it("no gtag on the page (blocked script): nothing happens", () => {
    vi.stubGlobal("window", {});
    expect(() => trackSearch({ airport_code: "JFK" })).not.toThrow();
    expect(() => trackBeginCheckout({ lotId: "a", lotName: "A", total: 1 })).not.toThrow();
  });
});

// Where each event fires is the whole point of the 2026-11-12 change, and a
// component effect cannot be exercised in this (node) test environment, so the
// call sites are pinned by reading the source.
describe("where the events fire", () => {
  const src = (p: string) => readFileSync(join(process.cwd(), "src", p), "utf8");

  it("begin_checkout fires from the checkout page load, never from the payment step", () => {
    expect(src("app/(main)/checkout/page.tsx")).toMatch(/trackBeginCheckout\(/);
    expect(src("components/checkout/checkout-form.tsx")).not.toMatch(/trackBeginCheckout/);
    expect(src("components/checkout/checkout-form.tsx")).toMatch(/trackAddPaymentInfo\(/);
  });

  it("view_item fires from both places a lot's details are shown", () => {
    expect(src("components/search/product-detail-slider.tsx")).toMatch(/trackLotView\(\{[^}]*surface: "search_panel"/);
    expect(src("components/lot/booking-widget.tsx")).toMatch(/trackLotView\(\{[^}]*surface: "lot_page"/);
  });

  it("select_item fires once, from the search page, for every way a lot opens", () => {
    const page = src("app/(main)/search/page.tsx");
    expect(page).toMatch(/trackSelectItem\(/);
    expect(page).not.toMatch(/onSelect=\{setSelectedLot\}/);
    for (const f of ["lot-card.tsx", "search-map.tsx", "mobile-map-card.tsx"]) {
      expect(src(`components/search/${f}`), f).not.toMatch(/trackSelectItem/);
    }
  });

  it("the search page reports every attempt through the non-throwing reporter", () => {
    const page = src("app/(main)/search/page.tsx");
    expect(page).not.toMatch(/[^a-zA-Z]fetchResults\(\)/);
    expect(page).not.toMatch(/=\{fetchResults\}/);
    expect(page.match(/reportSearch\(trigger,/g)?.length).toBe(4);
  });
});
