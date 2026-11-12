/**
 * The standard funnel events (search, select_item, view_item, begin_checkout,
 * add_payment_info): their shapes, that they can never throw into a page, how
 * a checkout load is reported, and where each one fires.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkoutLoadReport, checkoutLoadValue, isPricedLoad } from "../checkout-funnel";
import { trackAddPaymentInfo, trackBeginCheckout, trackLotView, trackSelectItem } from "../gtag";
import { trackSearch } from "../track-search";
import type { SearchEventInput } from "../search-event";

const cost = (over: Record<string, unknown> = {}) => ({
  costsToken: "tok" as string | null,
  grandTotal: 82,
  serviceFee: 10,
  soldOut: false,
  ...over,
});
const directTerms = { days: 4, taxRatePercent: 8, vehicleSurcharges: [] };
const lot = { id: "reslab-132", name: "DoubleTree" };

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
    const direct = cost({ costsToken: null, direct: directTerms });
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

describe("checkoutLoadReport: what a loaded checkout reports", () => {
  it("no lot in the answer is a failed load", () => {
    expect(checkoutLoadReport({ costData: cost() })).toEqual({ failed: "no_lot" });
    expect(checkoutLoadReport(null)).toEqual({ failed: "no_lot" });
  });

  it("a sold-out lot is a failed load: no checkout_view, no begin_checkout", () => {
    expect(checkoutLoadReport({ lot, costData: cost({ soldOut: true }) })).toEqual({ failed: "sold_out" });
  });

  it("a priced load reports the lot and the total the customer sees", () => {
    expect(checkoutLoadReport({ lot, costData: cost() })).toEqual({
      lotId: "reslab-132",
      lotName: "DoubleTree",
      priced: 1,
      total: 92,
    });
  });

  it("an estimate load (no token, not direct) or no cost data: unpriced, no total", () => {
    expect(checkoutLoadReport({ lot, costData: cost({ costsToken: null }) })).toMatchObject({ priced: 0, total: undefined });
    expect(checkoutLoadReport({ lot, costData: null })).toMatchObject({ lotId: "reslab-132", priced: 0, total: undefined });
  });

  it("a direct lot is priced", () => {
    expect(checkoutLoadReport({ lot, costData: cost({ costsToken: null, direct: directTerms }) })).toMatchObject({
      priced: 1,
      total: 92,
    });
  });
});

describe("event shapes", () => {
  const gtag = vi.fn();
  beforeEach(() => {
    gtag.mockReset();
    vi.stubGlobal("window", { gtag });
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each(["search_panel", "lot_page"] as const)("view_item carries an items array and its surface (%s)", (surface) => {
    trackLotView({ id: "reslab-132", name: "DoubleTree", price: 11.25, surface });
    expect(gtag).toHaveBeenCalledWith("event", "view_item", {
      currency: "USD",
      items: [{ item_id: "reslab-132", item_name: "DoubleTree", price: 11.25 }],
      item_surface: surface,
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

  it("add_payment_info keeps its shape", () => {
    trackAddPaymentInfo({ lotId: "reslab-132", lotName: "DoubleTree", total: 104.95 });
    expect(gtag).toHaveBeenCalledWith("event", "add_payment_info", {
      value: 104.95,
      currency: "USD",
      items: [{ item_id: "reslab-132", item_name: "DoubleTree", price: 104.95 }],
    });
  });

  it("search builds its own params from the attempt", () => {
    const input: SearchEventInput = {
      airportCode: "JFK",
      trigger: "submit",
      sortBy: "popularity",
      datesPicked: true,
      checkin: "2026-11-24",
      checkout: "2026-11-28",
      today: "2026-11-12",
      failure: "date_error",
    };
    trackSearch(input);
    expect(gtag).toHaveBeenCalledTimes(1);
    const [, name, params] = gtag.mock.calls[0];
    expect(name).toBe("search");
    expect(params).toMatchObject({ airport_code: "JFK", search_outcome: "date_error", search_trigger: "submit", dates_defaulted: 0 });
  });
});

describe("analytics can never break a page", () => {
  afterEach(() => vi.unstubAllGlobals());
  const search: SearchEventInput = {
    airportCode: "JFK",
    trigger: "initial",
    sortBy: "popularity",
    datesPicked: false,
    checkin: "2026-11-24",
    checkout: "2026-11-28",
    today: "2026-11-12",
    failure: "load_error",
  };

  it("a throwing gtag is swallowed by every funnel event", () => {
    vi.stubGlobal("window", {
      gtag: () => {
        throw new Error("blocked");
      },
    });
    expect(() => trackSearch(search)).not.toThrow();
    expect(() => trackLotView({ id: "a", name: "A", surface: "lot_page" })).not.toThrow();
    expect(() => trackSelectItem({ id: "a", name: "A", list: "search_results" })).not.toThrow();
    expect(() => trackBeginCheckout({ lotId: "a", lotName: "A" })).not.toThrow();
    // Runs inside the PaymentIntent try: a throw would show "Payment Error".
    expect(() => trackAddPaymentInfo({ lotId: "a", lotName: "A", total: 1 })).not.toThrow();
  });

  it("a search answer the builder cannot read is swallowed too", () => {
    vi.stubGlobal("window", { gtag: vi.fn() });
    const junk = { ...search, failure: undefined, answer: { results: [null] } } as unknown as SearchEventInput;
    expect(() => trackSearch(junk)).not.toThrow();
  });

});

// Where each event fires is the point of the 2026-11-12 change, and a
// component effect cannot be exercised in this (node) test environment, so
// the call sites are pinned by reading the source. The decisions themselves
// (which outcome, which total) are unit-tested above and in search-event.test.ts.
describe("where the events fire", () => {
  const SRC = join(process.cwd(), "src");
  const src = (p: string) => readFileSync(join(SRC, p), "utf8");
  const count = (text: string, re: RegExp) => text.match(re)?.length ?? 0;
  /** Every non-test source file that contains `needle`, as forward-slash paths under src/. */
  const filesCalling = (needle: string) =>
    (readdirSync(SRC, { recursive: true }) as string[])
      .map((f) => f.replace(/\\/g, "/"))
      .filter((f) => /\.tsx?$/.test(f) && !f.includes("__tests__") && f !== "lib/analytics/gtag.ts")
      .filter((f) => readFileSync(join(SRC, f), "utf8").includes(needle));

  it("begin_checkout fires from one place: the checkout page, off checkoutLoadReport", () => {
    expect(filesCalling("trackBeginCheckout(")).toEqual(["app/(main)/checkout/page.tsx"]);
    const page = src("app/(main)/checkout/page.tsx");
    expect(count(page, /trackBeginCheckout\(/g)).toBe(1);
    expect(page).toMatch(/trackBeginCheckout\(\{ lotId: report\.lotId, lotName: report\.lotName, total: report\.total \}\)/);
    expect(page).toMatch(/priced: report\.priced/);
    // The payment step still reports itself.
    expect(src("components/checkout/checkout-form.tsx")).toMatch(/trackAddPaymentInfo\(/);
  });

  it("view_item fires from the two places a lot's details are shown, each with its surface", () => {
    expect(filesCalling("trackLotView(").sort()).toEqual(["components/lot/booking-widget.tsx", "components/search/product-detail-slider.tsx"]);
    expect(src("components/search/product-detail-slider.tsx")).toMatch(/trackLotView\(\{[^}]*surface: "search_panel"/);
    expect(src("components/lot/booking-widget.tsx")).toMatch(/trackLotView\(\{[^}]*surface: "lot_page"/);
  });

  it("select_item fires once, from the search page's openLot, for every way a lot opens", () => {
    expect(filesCalling("trackSelectItem(")).toEqual(["app/(main)/search/page.tsx"]);
    const page = src("app/(main)/search/page.tsx");
    expect(count(page, /trackSelectItem\(/g)).toBe(1);
    // The panel opens only through openLot (and closes through onClose).
    expect(count(page, /setSelectedLot\(/g)).toBe(2);
    expect(count(page, /onSelect=\{/g)).toBe(4);
    expect(count(page, /onSelect=\{openFromList\}/g)).toBe(1);
    expect(count(page, /onSelect=\{openFromMap\}/g)).toBe(3);
    expect(page).toMatch(/const openFromList = \(lot: UnifiedLot\) => openLot\(lot, "search_results"\);/);
    expect(page).toMatch(/const openFromMap = \(lot: UnifiedLot\) => openLot\(lot, "search_map"\);/);
  });

  it("the search page reports each attempt once, with the right trigger and the right result", () => {
    const page = src("app/(main)/search/page.tsx");
    for (const trigger of ["initial", "sort", "submit", "retry"]) {
      expect(count(page, new RegExp(`fetchResults\\("${trigger}"\\)`, "g")), trigger).toBe(1);
    }
    expect(page).not.toMatch(/[^a-zA-Z]fetchResults\(\)/);
    expect(page).not.toMatch(/=\{fetchResults\}/);
    // Three exits: the client date check, an answered request, a thrown one.
    expect(count(page, /reportSearch\(trigger, datesPicked, /g)).toBe(3);
    expect(count(page, /reportSearch\(trigger, datesPicked, \{ failure: "date_error" \}\)/g)).toBe(1);
    expect(count(page, /reportSearch\(trigger, datesPicked, searchResultFromResponse\(response\.ok, response\.status, data\)\)/g)).toBe(1);
    expect(count(page, /reportSearch\(trigger, datesPicked, \{ failure: "load_error" \}\)/g)).toBe(1);
    // The answered request reports AFTER the page has set its state for every
    // kind of answer (failed or not) and before the catch. Inside the success
    // branch only, failed answers (400, 5xx, an error body) would send nothing.
    const answeredReport = page.indexOf("reportSearch(trigger, datesPicked, searchResultFromResponse(");
    const failedBranch = page.indexOf("if (!response.ok || data.error)");
    const successBranchEnd = page.lastIndexOf("setDateError(", answeredReport);
    const catchStart = page.indexOf("} catch (err)", failedBranch);
    expect(failedBranch).toBeGreaterThan(0);
    expect(answeredReport).toBeGreaterThan(successBranchEnd);
    expect(answeredReport).toBeLessThan(catchStart);
    // …and at the try's own indent (6 spaces), not nested in a branch.
    expect(page).toMatch(/\n {6}reportSearch\(trigger, datesPicked, searchResultFromResponse\(/);
    // gtag.ts is loaded on every page: the search builder must stay out of it.
    expect(src("lib/analytics/gtag.ts")).not.toMatch(/from ["'][^"']*(search-event|ranking|checkout-funnel)["']/);
    // "Picked" is read when the request starts, from both dates.
    expect(page).toMatch(/const datesPicked = checkinPickedRef\.current && checkoutPickedRef\.current;\s+setLoading\(true\);/);
  });
});
