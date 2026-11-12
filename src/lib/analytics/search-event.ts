/**
 * What a `search` event tells Google Analytics about one search: how it ended
 * and what the searcher was shown. Pure (no window, no gtag) so the rules are
 * pinned by unit tests (__tests__/search-event.test.ts).
 *
 * Why (2026-11-12): the event carried only the airport and dates, so "why do
 * searchers leave without opening a lot" could not be answered: nothing said
 * whether a search showed ten lots, one, none or an error panel.
 *
 * Counts, days and a price band only: no personal data.
 */
import type { UnifiedLot } from "@/types/lot";
import { lotTotal, lowestTotalLot } from "@/lib/search/ranking";
import { leadDays } from "@/lib/analytics/checkout-funnel";

/** How the search ended, as the page showed it. */
export type SearchOutcome =
  | "ok" // a complete list of lots
  | "partial" // lots shown, but the answer was incomplete (a supplier was unreachable)
  | "empty" // no lots for these dates
  | "closed_today" // no lot can take a booking for the rest of today
  | "date_error" // the dates were refused (past, reversed, too late today)
  | "load_error"; // the "We couldn't load parking" panel

/** What started the search. A `sort` re-fetch shows the same lots again. */
export type SearchTrigger = "initial" | "submit" | "sort" | "retry";

/** The parts of the /api/search answer this module reads. */
export interface SearchAnswer {
  results?: UnifiedLot[];
  /** The dates the results were priced for. */
  checkin?: unknown;
  checkout?: unknown;
  closedForToday?: boolean;
  degraded?: boolean;
  reslabUnavailable?: boolean;
  directUnavailable?: boolean;
  listIncomplete?: boolean;
}

/** True when the list is everything we sell for these dates (the server's own rule for a "cheapest"). */
export function isCompleteAnswer(a: SearchAnswer): boolean {
  return !(a.degraded || a.reslabUnavailable || a.directUnavailable || a.listIncomplete);
}

export function answerOutcome(a: SearchAnswer): SearchOutcome {
  const count = a.results?.length ?? 0;
  if (count === 0) return a.closedForToday === true ? "closed_today" : "empty";
  return isCompleteAnswer(a) ? "ok" : "partial";
}

/** A band, not the amount: a GA4 dimension has to be low-cardinality to split a funnel. */
export function priceBand(total: number): string {
  if (total < 50) return "under_50";
  if (total < 100) return "50_99";
  if (total < 200) return "100_199";
  return "200_plus";
}

const isDate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

export interface SearchEventInput {
  airportCode: string;
  trigger: SearchTrigger;
  sortBy: string;
  /** True when the visitor never picked these dates (the page filled them in). */
  datesDefaulted: boolean;
  /** The dates sent to the search; used when there is no answer to read them from. */
  checkin: string;
  checkout: string;
  /** The visitor's own calendar date, YYYY-MM-DD. */
  today: string;
  /** Set for a search that could not be answered. */
  failure?: "date_error" | "load_error";
  /** The successful answer. */
  answer?: SearchAnswer;
}

export type SearchEventParams = Record<string, string | number | undefined>;

export function buildSearchEventParams(input: SearchEventInput): SearchEventParams {
  const answer = input.failure ? undefined : input.answer;
  const checkin = isDate(answer?.checkin) ? answer.checkin : input.checkin;
  const checkout = isDate(answer?.checkout) ? answer.checkout : input.checkout;

  const params: SearchEventParams = {
    search_term: input.airportCode,
    airport_code: input.airportCode,
    checkin_date: checkin || undefined,
    checkout_date: checkout || undefined,
    search_outcome: input.failure ?? (answer ? answerOutcome(answer) : "load_error"),
    search_trigger: input.trigger,
    sort_by: input.sortBy,
    dates_defaulted: input.datesDefaulted ? 1 : 0,
  };

  // Made-up dates have no lead time or trip length worth recording.
  if (!input.datesDefaulted) {
    params.lead_days = leadDays(checkin, input.today) ?? undefined;
    params.stay_days = leadDays(checkout, checkin) ?? undefined;
  }

  if (answer) {
    const results = answer.results ?? [];
    params.lots_shown = results.length;
    // The cheapest total a card shows (grand total + service fee). Withheld on
    // an incomplete answer: the cheapest of a partial list is not the cheapest.
    const cheapest = lowestTotalLot(results, { resultComplete: isCompleteAnswer(answer) });
    if (cheapest) params.price_band = priceBand(lotTotal(cheapest));
  }
  return params;
}
