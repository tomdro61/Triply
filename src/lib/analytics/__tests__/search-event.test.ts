import { describe, expect, it } from "vitest";
import type { UnifiedLot } from "@/types/lot";
import { answerOutcome, buildSearchEventParams, priceBand, type SearchEventInput } from "../search-event";

/** A priced ResLab lot whose card shows `total` (grand total; no separate fee in this fixture). */
function lot(id: string, grandTotal: number | null): UnifiedLot {
  return {
    id,
    source: "reslab",
    name: `Lot ${id}`,
    pricing:
      grandTotal === null
        ? undefined
        : { minPrice: grandTotal / 4, currency: "USD", grandTotal, subtotal: grandTotal, feesTotal: 0, taxTotal: 0, numberOfDays: 4 },
  } as unknown as UnifiedLot;
}

const base: SearchEventInput = {
  airportCode: "JFK",
  trigger: "initial",
  sortBy: "popularity",
  datesDefaulted: false,
  checkin: "2026-11-24",
  checkout: "2026-11-28",
  today: "2026-11-12",
};

describe("answerOutcome", () => {
  it("names what the page showed", () => {
    expect(answerOutcome({ results: [lot("a", 40)] })).toBe("ok");
    expect(answerOutcome({ results: [] })).toBe("empty");
    expect(answerOutcome({})).toBe("empty");
    expect(answerOutcome({ results: [], closedForToday: true })).toBe("closed_today");
    // closedForToday only matters when nothing can be shown
    expect(answerOutcome({ results: [lot("a", 40)], closedForToday: true })).toBe("ok");
  });

  it.each(["degraded", "reslabUnavailable", "directUnavailable", "listIncomplete"] as const)(
    "a list with %s set is partial",
    (flag) => {
      expect(answerOutcome({ results: [lot("a", 40)], [flag]: true })).toBe("partial");
    },
  );
});

describe("priceBand", () => {
  it("puts each total in one band, with the edges in the higher band", () => {
    expect(priceBand(0)).toBe("under_50");
    expect(priceBand(49.99)).toBe("under_50");
    expect(priceBand(50)).toBe("50_99");
    expect(priceBand(99.99)).toBe("50_99");
    expect(priceBand(100)).toBe("100_199");
    expect(priceBand(200)).toBe("200_plus");
  });
});

describe("buildSearchEventParams", () => {
  it("a complete answer: lots shown, the cheapest card's band, lead time and trip length", () => {
    const p = buildSearchEventParams({ ...base, answer: { results: [lot("a", 120), lot("b", 44.12), lot("c", 70)] } });
    expect(p).toMatchObject({
      search_term: "JFK",
      airport_code: "JFK",
      checkin_date: "2026-11-24",
      checkout_date: "2026-11-28",
      search_outcome: "ok",
      search_trigger: "initial",
      sort_by: "popularity",
      dates_defaulted: 0,
      lead_days: 12,
      stay_days: 4,
      lots_shown: 3,
    });
    // The cheapest card is lot b ($44.12 plus the service fee): one of the two lowest bands.
    expect(["under_50", "50_99"]).toContain(p.price_band);
  });

  it("reports the dates the results were priced for, not the ones sent", () => {
    const p = buildSearchEventParams({
      ...base,
      checkout: "",
      answer: { results: [lot("a", 40)], checkin: "2026-11-24", checkout: "2026-12-01" },
    });
    expect(p.checkout_date).toBe("2026-12-01");
    expect(p.stay_days).toBe(7);
  });

  it("dates the visitor never picked: flagged, with no lead time or trip length", () => {
    const p = buildSearchEventParams({ ...base, datesDefaulted: true, answer: { results: [lot("a", 40)] } });
    expect(p.dates_defaulted).toBe(1);
    expect(p).not.toHaveProperty("lead_days");
    expect(p).not.toHaveProperty("stay_days");
    expect(p.lots_shown).toBe(1);
  });

  it("zero results: lots_shown is 0 (sent, not omitted) and there is no price band", () => {
    const p = buildSearchEventParams({ ...base, answer: { results: [] } });
    expect(p.lots_shown).toBe(0);
    expect(p.search_outcome).toBe("empty");
    expect(p).not.toHaveProperty("price_band");
  });

  it("a partial answer counts its lots but withholds the cheapest", () => {
    const p = buildSearchEventParams({ ...base, answer: { results: [lot("a", 40)], reslabUnavailable: true } });
    expect(p.search_outcome).toBe("partial");
    expect(p.lots_shown).toBe(1);
    expect(p).not.toHaveProperty("price_band");
  });

  it("unpriced lots are counted but cannot be the cheapest", () => {
    const p = buildSearchEventParams({ ...base, answer: { results: [lot("a", null), lot("b", 150)] } });
    expect(p.lots_shown).toBe(2);
    expect(p.price_band).toBe("100_199");
    const none = buildSearchEventParams({ ...base, answer: { results: [lot("a", null)] } });
    expect(none).not.toHaveProperty("price_band");
  });

  it.each(["date_error", "load_error"] as const)("a %s search carries no result fields", (failure) => {
    const p = buildSearchEventParams({ ...base, trigger: "retry", failure });
    expect(p.search_outcome).toBe(failure);
    expect(p.search_trigger).toBe("retry");
    expect(p).not.toHaveProperty("lots_shown");
    expect(p).not.toHaveProperty("price_band");
  });

  it("a failure wins over an answer passed alongside it", () => {
    const p = buildSearchEventParams({ ...base, failure: "load_error", answer: { results: [lot("a", 40)] } });
    expect(p.search_outcome).toBe("load_error");
    expect(p).not.toHaveProperty("lots_shown");
  });

  it("never throws on a malformed answer or dates", () => {
    const junk = { results: [{} as UnifiedLot, lot("a", Number.NaN)], checkin: 42, checkout: null };
    expect(() => buildSearchEventParams({ ...base, checkin: "nope", checkout: "", answer: junk })).not.toThrow();
    const p = buildSearchEventParams({ ...base, checkin: "nope", checkout: "", answer: junk });
    expect(p.lead_days).toBeUndefined();
    expect(p.checkout_date).toBeUndefined();
    expect(p.lots_shown).toBe(2);
  });
});
