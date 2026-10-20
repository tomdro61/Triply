import { describe, expect, it } from "vitest";
import {
  EMPTY_COPY,
  PREVIEW_UNAVAILABLE,
  PREVIEW_UNAVAILABLE_MESSAGE,
  UNAVAILABLE,
  classifySearchAnswer,
  deriveResultsState,
  isSearchResponse,
  listContent,
  type Settled,
} from "../results-state";

const offer = { hotelKey: "doubletree-jfk", room: { price: { headlineTotalCents: 27_595 } }, lot: { latitude: 40.66, longitude: -73.79 } };

function body(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: "ok",
    airport: { code: "JFK", name: "JFK", timezone: "America/New_York" },
    search: { night: "2026-11-10", departureDate: "2026-11-11", arrivalTime: "7:00 PM", returnDate: "2026-11-14", returnTime: "6:00 PM", adults: 2 },
    offers: [offer],
    partial: false,
    emptyReason: null,
    sandbox: true,
    diagnostics: { hidden: {}, cached: false },
    ...over,
  };
}

describe("the search answer check (review round 1, item 4)", () => {
  it("accepts a well-formed ok and empty answer", () => {
    expect(isSearchResponse(body())).toBe(true);
    expect(isSearchResponse(body({ status: "empty", offers: [], emptyReason: "sold_out" }))).toBe(true);
    expect(isSearchResponse(body({ status: "empty", offers: [], partial: true, emptyReason: null }))).toBe(true);
  });

  it("rejects every missing or mistyped field the page reads → UNAVAILABLE (retry)", () => {
    const bad: Array<Record<string, unknown>> = [
      body({ partial: undefined }),
      body({ partial: "no" }),
      body({ airport: { name: "JFK" } }),
      body({ airport: null }),
      body({ search: { night: "2026-11-10" } }),
      body({ search: { ...(body().search as object), returnTime: 18 } }),
      body({ emptyReason: "made_up" }),
      body({ emptyReason: undefined }),
      body({ offers: [{ ...offer, hotelKey: 7 }] }),
      body({ offers: [{ ...offer, room: { price: { headlineTotalCents: "275.95" } } }] }),
      body({ offers: [{ ...offer, lot: { latitude: 40.6 } }] }),
      body({ offers: [{ ...offer, lot: { latitude: Number.NaN, longitude: -73 } }] }),
      body({ offers: "none" }),
      body({ status: "ok", offers: [] }), // ok with nothing in it
      body({ status: "empty", offers: [offer] }),
      body({ status: "maybe" }),
    ];
    for (const b of bad) {
      expect(isSearchResponse(b), JSON.stringify(b).slice(0, 120)).toBe(false);
      expect(classifySearchAnswer(200, b)).toBe(UNAVAILABLE);
    }
    expect(classifySearchAnswer(200, null)).toBe(UNAVAILABLE);
  });
});

describe("HTTP answers (review round 1, item 5)", () => {
  it("a 404 is the preview gate failing this time: its own message, with Try again", () => {
    expect(classifySearchAnswer(404, { error: "Not found" })).toBe(PREVIEW_UNAVAILABLE);
    expect(PREVIEW_UNAVAILABLE).toEqual({ kind: "error", message: PREVIEW_UNAVAILABLE_MESSAGE, retry: true });
    expect(PREVIEW_UNAVAILABLE_MESSAGE).toBe("The Park & Stay preview is unavailable right now.");
  });

  it("400 names the problem without a retry; 429 and 5xx retry", () => {
    expect(classifySearchAnswer(400, { error: "The hotel night can't be in the past." })).toEqual({ kind: "error", message: "The hotel night can't be in the past.", retry: false });
    expect(classifySearchAnswer(400, null)).toEqual({ kind: "error", message: "Check your search.", retry: false });
    expect(classifySearchAnswer(429, null)).toMatchObject({ retry: true });
    expect(classifySearchAnswer(503, { error: "x", retry: true })).toBe(UNAVAILABLE);
  });
});

describe("state derivation (review round 1, item 11)", () => {
  const b = body();
  if (!isSearchResponse(b)) throw new Error("fixture must be a valid answer");
  const done: Settled = { kind: "done", body: b };

  it("incomplete → idle; no answer yet → loading; the matching answer → it", () => {
    expect(deriveResultsState({ complete: false, query: "q1", attempt: 0, result: { query: "q1", attempt: 0, state: done } })).toEqual({ kind: "idle" });
    expect(deriveResultsState({ complete: true, query: "q1", attempt: 0, result: null })).toEqual({ kind: "loading" });
    expect(deriveResultsState({ complete: true, query: "q1", attempt: 0, result: { query: "q1", attempt: 0, state: done } })).toBe(done);
  });

  it("an answer for an earlier search or an earlier try that lands late is never shown", () => {
    // The customer searched q1, then q2; q1's answer arrives last.
    expect(deriveResultsState({ complete: true, query: "q2", attempt: 0, result: { query: "q1", attempt: 0, state: done } })).toEqual({ kind: "loading" });
    // A retry (attempt 1) is in flight; attempt 0's answer must not stand in for it.
    expect(deriveResultsState({ complete: true, query: "q1", attempt: 1, result: { query: "q1", attempt: 0, state: done } })).toEqual({ kind: "loading" });
  });
});

describe("what the list renders", () => {
  it("offers → the cards; partial AND empty → retry, never the empty copy (M2); complete empty → its reason", () => {
    expect(listContent({ offers: [offer], partial: true, emptyReason: null })).toEqual({ kind: "offers" });
    expect(listContent({ offers: [], partial: true, emptyReason: null })).toEqual({ kind: "retry" });
    expect(listContent({ offers: [], partial: true, emptyReason: "sold_out" })).toEqual({ kind: "retry" });
    expect(listContent({ offers: [], partial: false, emptyReason: "min_stay" })).toEqual({ kind: "empty", copy: EMPTY_COPY.min_stay });
    expect(listContent({ offers: [], partial: false, emptyReason: null })).toEqual({ kind: "empty", copy: EMPTY_COPY.none_available });
  });
});
