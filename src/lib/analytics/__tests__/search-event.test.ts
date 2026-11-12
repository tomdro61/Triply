import { describe, expect, it } from "vitest";
import type { LotBadge, UnifiedLot } from "@/types/lot";
import { lotTotal } from "@/lib/search/ranking";
import {
  answerOutcome,
  buildSearchEventParams,
  priceBand,
  searchResultFromResponse,
  type SearchAnswer,
  type SearchEventInput,
} from "../search-event";

/**
 * A ResLab lot priced at `grandTotal` for 4 days. Its card shows the grand
 * total PLUS the service fee (lotTotal), which is what price_band is built from.
 */
function lot(id: string, grandTotal: number | null, badges?: LotBadge[]): UnifiedLot {
  return {
    id,
    source: "reslab",
    name: `Lot ${id}`,
    badges,
    pricing:
      grandTotal === null
        ? undefined
        : { minPrice: grandTotal / 4, currency: "USD", grandTotal, subtotal: grandTotal, feesTotal: 0, taxTotal: 0, numberOfDays: 4 },
  } as unknown as UnifiedLot;
}

type Attempt = Pick<SearchEventInput, "airportCode" | "trigger" | "sortBy" | "datesPicked" | "checkin" | "checkout" | "today">;
const base: Attempt = {
  airportCode: "JFK",
  trigger: "initial",
  sortBy: "popularity",
  datesPicked: true,
  checkin: "2026-11-24",
  checkout: "2026-11-28",
  today: "2026-11-12",
};
const answered = (answer: SearchAnswer, over: Partial<Attempt> = {}): SearchEventInput => ({ ...base, ...over, answer });

describe("the fixture", () => {
  it("a card's total is the grand total plus a service fee that crosses the $50 edge for a $45 lot", () => {
    expect(lotTotal(lot("a", 45))).toBeGreaterThan(50);
    expect(lotTotal(lot("a", 45))).toBeLessThan(60);
  });
});

describe("answerOutcome: what the page showed", () => {
  it("lots, none, and closed for today", () => {
    expect(answerOutcome({ results: [lot("a", 40)] })).toBe("ok");
    expect(answerOutcome({ results: [] })).toBe("empty");
    expect(answerOutcome({})).toBe("empty");
    expect(answerOutcome({ results: [], closedForToday: true })).toBe("closed_today");
    // closedForToday only replaces an empty list
    expect(answerOutcome({ results: [lot("a", 40)], closedForToday: true })).toBe("ok");
  });

  it("partial is the page's banner: reslabUnavailable, with or without lots", () => {
    expect(answerOutcome({ results: [lot("a", 40)], reslabUnavailable: true })).toBe("partial");
    // No data is not "nothing exists".
    expect(answerOutcome({ results: [], reslabUnavailable: true })).toBe("partial");
  });

  it.each(["degraded", "directUnavailable", "listIncomplete"] as const)(
    "%s alone shows no banner, so the outcome is still ok",
    (flag) => {
      expect(answerOutcome({ results: [lot("a", 40)], [flag]: true })).toBe("ok");
    },
  );

  it("a non-array results field counts as no lots, never a throw", () => {
    expect(answerOutcome({ results: "oops" } as unknown as SearchAnswer)).toBe("empty");
  });
});

describe("priceBand", () => {
  it("puts each total in one band, with the edges in the higher band", () => {
    expect(priceBand(0)).toBe("under_50");
    expect(priceBand(49.99)).toBe("under_50");
    expect(priceBand(50)).toBe("50_99");
    expect(priceBand(99.99)).toBe("50_99");
    expect(priceBand(100)).toBe("100_199");
    expect(priceBand(199.99)).toBe("100_199");
    expect(priceBand(200)).toBe("200_plus");
  });
});

describe("searchResultFromResponse: each way a request can end", () => {
  it("a 200 with lots is an answer", () => {
    const body = { results: [] };
    expect(searchResultFromResponse(true, 200, body)).toEqual({ answer: body });
  });
  it("a 400 is the 'check your dates' state", () => {
    expect(searchResultFromResponse(false, 400, { error: "x", code: "checkin_in_past" })).toEqual({ failure: "date_error" });
  });
  it("any other failed status is the 'couldn't load' panel", () => {
    expect(searchResultFromResponse(false, 503, { error: "x" })).toEqual({ failure: "load_error" });
    expect(searchResultFromResponse(false, 500, {})).toEqual({ failure: "load_error" });
  });
  it("a 200 carrying an error, or a body that is not an object, is a load error", () => {
    expect(searchResultFromResponse(true, 200, { error: "x" })).toEqual({ failure: "load_error" });
    expect(searchResultFromResponse(true, 200, null)).toEqual({ failure: "load_error" });
    expect(searchResultFromResponse(true, 200, "<html>")).toEqual({ failure: "load_error" });
  });
});

describe("buildSearchEventParams", () => {
  it("an answered search: lots shown, the cheapest card's band, lead time, trip length, the sort", () => {
    // Cheapest card: $45 + fee = just over $50 (the fee moves it across the
    // edge); the next lot is two bands up, so banding the wrong lot fails too.
    const p = buildSearchEventParams(answered({ results: [lot("a", 150), lot("b", 45), lot("c", 300)] }, { sortBy: "price_asc" }));
    expect(p).toEqual({
      search_term: "JFK",
      airport_code: "JFK",
      checkin_date: "2026-11-24",
      checkout_date: "2026-11-28",
      search_outcome: "ok",
      search_trigger: "initial",
      sort_by: "price_asc",
      dates_defaulted: 0,
      lead_days: 12,
      stay_days: 4,
      lots_shown: 3,
      price_band: "50_99",
    });
  });

  it("the band comes from the lot the server badged 'Lowest total', even when a flag says incomplete", () => {
    // A hidden other-airport lot failed to price (degraded): the page still
    // shows the full list and the badge, so the event must agree with it.
    const p = buildSearchEventParams(
      answered({ results: [lot("a", 150, ["lowest_total"]), lot("b", 300, ["most_booked"])], degraded: true }),
    );
    expect(p.search_outcome).toBe("ok");
    expect(p.price_band).toBe("100_199");
  });

  it("badges present but none is 'Lowest total': the server withheld it, so no band", () => {
    const p = buildSearchEventParams(answered({ results: [lot("a", 150, ["most_booked"]), lot("b", 45)] }));
    expect(p).not.toHaveProperty("price_band");
    expect(p.lots_shown).toBe(2);
  });

  it("no badges at all (ranking switched off): computed, and withheld on any incomplete flag", () => {
    expect(buildSearchEventParams(answered({ results: [lot("a", 150)] })).price_band).toBe("100_199");
    for (const flag of ["degraded", "reslabUnavailable", "directUnavailable", "listIncomplete"] as const) {
      expect(buildSearchEventParams(answered({ results: [lot("a", 150)], [flag]: true })), flag).not.toHaveProperty("price_band");
    }
  });

  it("reports the dates the results were priced for", () => {
    const p = buildSearchEventParams(answered({ results: [lot("a", 40)], checkin: "2026-11-25", checkout: "2026-12-01" }));
    expect(p.checkin_date).toBe("2026-11-25");
    expect(p.checkout_date).toBe("2026-12-01");
    expect(p.lead_days).toBe(13);
    expect(p.stay_days).toBe(6);
  });

  it("dates the visitor never picked: flagged, with no lead time or trip length", () => {
    const p = buildSearchEventParams(answered({ results: [lot("a", 40)] }, { datesPicked: false }));
    expect(p.dates_defaulted).toBe(1);
    expect(p).not.toHaveProperty("lead_days");
    expect(p).not.toHaveProperty("stay_days");
    expect(p.lots_shown).toBe(1);
  });

  it("picked dates with the return date cleared: defaulted too, whatever range the server priced", () => {
    const p = buildSearchEventParams({
      ...base,
      checkout: "",
      answer: { results: [lot("a", 40)], checkin: "2026-11-24", checkout: "2026-12-01" },
    });
    expect(p.dates_defaulted).toBe(1);
    expect(p).not.toHaveProperty("stay_days");
    expect(p).not.toHaveProperty("lead_days");
    expect(p.checkout_date).toBe("2026-12-01");
  });

  it("zero results: lots_shown is 0 (sent, not omitted) and there is no price band", () => {
    const p = buildSearchEventParams(answered({ results: [] }));
    expect(p.lots_shown).toBe(0);
    expect(p.search_outcome).toBe("empty");
    expect(p).not.toHaveProperty("price_band");
  });

  it("unpriced lots are counted but cannot be the cheapest", () => {
    const p = buildSearchEventParams(answered({ results: [lot("a", null), lot("b", 150)] }));
    expect(p.lots_shown).toBe(2);
    expect(p.price_band).toBe("100_199");
    expect(buildSearchEventParams(answered({ results: [lot("a", null)] }))).not.toHaveProperty("price_band");
  });

  it.each(["date_error", "load_error"] as const)("a %s search carries no result fields", (failure) => {
    const p = buildSearchEventParams({ ...base, trigger: "retry", failure });
    expect(p.search_outcome).toBe(failure);
    expect(p.search_trigger).toBe("retry");
    expect(p).not.toHaveProperty("lots_shown");
    expect(p).not.toHaveProperty("price_band");
  });

  it("a failure wins over an answer, if an untyped caller passes both", () => {
    // @ts-expect-error the type allows exactly one of answer / failure
    const p = buildSearchEventParams({ ...base, failure: "load_error", answer: { results: [lot("a", 40)] } });
    expect(p.search_outcome).toBe("load_error");
    expect(p).not.toHaveProperty("lots_shown");
  });

  it("unreadable dates give no lead time, not a wrong one", () => {
    const p = buildSearchEventParams(answered({ results: [], checkin: 42, checkout: null }, { checkin: "nope" }));
    expect(p.lead_days).toBeUndefined();
    expect(p.stay_days).toBeUndefined();
  });
});
