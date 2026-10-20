/**
 * The /park-stay results decisions, pure (review round 1, items 4, 5, 11):
 * what an API answer means, which answer the page may show, and what the
 * list renders. No React, no fetch — search-results.tsx wires these up.
 */

import type { ParkStaySearchResponse } from "@/app/api/park-stay/search/route";

export type Settled = { kind: "error"; message: string; retry: boolean } | { kind: "done"; body: ParkStaySearchResponse };
export type ResultsState = { kind: "idle" } | { kind: "loading" } | Settled;

export const UNAVAILABLE: Settled = { kind: "error", message: "Hotel search is temporarily unavailable.", retry: true };

/**
 * A 404 from a Park & Stay API after the page itself rendered means the
 * server's admin check failed THIS time (Lock 1 answers 404 to everyone it
 * can't confirm) — not that the search was wrong. Shared with the hotel page.
 */
export const PREVIEW_UNAVAILABLE_MESSAGE = "The Park & Stay preview is unavailable right now.";
export const PREVIEW_UNAVAILABLE: Settled = { kind: "error", message: PREVIEW_UNAVAILABLE_MESSAGE, retry: true };

export const EMPTY_COPY: Record<NonNullable<ParkStaySearchResponse["emptyReason"]>, string> = {
  min_stay: "No Park & Stay available for these dates — the hotels here need a longer parking stay.",
  booking_window: "No Park & Stay available for these dates — they are outside the booking window.",
  sold_out: "No Park & Stay available for these dates — the hotels or their parking are sold out.",
  notice_period: "No Park & Stay available for that arrival time — choose a later arrival time.",
  none_available: "No Park & Stay available for these dates.",
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function isEmptyReason(v: unknown): v is keyof typeof EMPTY_COPY {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(EMPTY_COPY, v);
}

function isOffer(v: unknown): boolean {
  if (!isObj(v) || typeof v.hotelKey !== "string") return false;
  const room = v.room;
  const lot = v.lot;
  if (!isObj(room) || !isObj(room.price) || !isNum(room.price.headlineTotalCents)) return false;
  return isObj(lot) && isNum(lot.latitude) && isNum(lot.longitude);
}

const SEARCH_FIELDS = ["night", "departureDate", "arrivalTime", "returnDate", "returnTime"] as const;

/**
 * Every field the page reads must be there, with its type; anything else is
 * treated as "unavailable" (retry), never rendered half-blank. `ok` must
 * carry offers and `empty` none — a mismatch is a broken answer.
 */
export function isSearchResponse(body: unknown): body is ParkStaySearchResponse {
  if (!isObj(body)) return false;
  if (body.status !== "ok" && body.status !== "empty") return false;
  if (typeof body.partial !== "boolean") return false;
  if (!isObj(body.airport) || typeof body.airport.code !== "string") return false;
  const search = body.search;
  if (!isObj(search) || !SEARCH_FIELDS.every((k) => typeof search[k] === "string")) return false;
  if (body.emptyReason !== null && !isEmptyReason(body.emptyReason)) return false;
  if (!Array.isArray(body.offers) || !body.offers.every(isOffer)) return false;
  if (body.status === "ok" && body.offers.length === 0) return false;
  if (body.status === "empty" && body.offers.length > 0) return false;
  return true;
}

function errorMessage(body: unknown, fallback: string): string {
  return isObj(body) && typeof body.error === "string" ? body.error : fallback;
}

/** What an HTTP answer from /api/park-stay/search means for the page. */
export function classifySearchAnswer(status: number, body: unknown): Settled {
  if (status >= 200 && status < 300) return isSearchResponse(body) ? { kind: "done", body } : UNAVAILABLE;
  if (status === 404) return PREVIEW_UNAVAILABLE;
  if (status === 400) return { kind: "error", message: errorMessage(body, "Check your search."), retry: false };
  if (status === 429) return { kind: "error", message: "Too many searches — please wait a moment.", retry: true };
  return UNAVAILABLE;
}

/**
 * The state the page shows. The stored result counts only when it answers
 * THIS query and attempt — an answer for an earlier search (or an earlier
 * try) that lands late is never shown as this one's.
 */
export function deriveResultsState(input: {
  complete: boolean;
  query: string;
  attempt: number;
  result: { query: string; attempt: number; state: Settled } | null;
}): ResultsState {
  if (!input.complete) return { kind: "idle" };
  const r = input.result;
  return r && r.query === input.query && r.attempt === input.attempt ? r.state : { kind: "loading" };
}

export type ListContent = { kind: "offers" } | { kind: "retry" } | { kind: "empty"; copy: string };

/** Partial AND empty is "we don't know" → retry, never "none available" (M2). */
export function listContent(body: { offers: readonly unknown[]; partial: boolean; emptyReason: ParkStaySearchResponse["emptyReason"] }): ListContent {
  if (body.offers.length > 0) return { kind: "offers" };
  if (body.partial) return { kind: "retry" };
  return { kind: "empty", copy: EMPTY_COPY[body.emptyReason ?? "none_available"] };
}
