/**
 * What a `search` event tells Google Analytics about one search attempt: how
 * it ended and what the searcher was shown. Pure (no window, no gtag) so the
 * rules are pinned by unit tests (__tests__/search-event.test.ts).
 *
 * Why (2026-11-12): the event carried only the airport and dates, so "why do
 * searchers leave without opening a lot" could not be answered: nothing said
 * whether a search showed ten lots, one, none or an error panel.
 *
 * No personal data: an airport, the dates, counts, a price band.
 */
import type { SortOption, UnifiedLot } from "@/types/lot";
import { lotTotal, lowestTotalLot } from "@/lib/search/ranking";
import { leadDays } from "@/lib/analytics/checkout-funnel";

/** How the search ended, as the page showed it. */
export type SearchOutcome =
  | "ok" // lots shown, no warning
  | "partial" // the "Some lots are temporarily unavailable" banner was shown
  | "empty" // no lots for these dates
  | "closed_today" // no lot can take a booking for the rest of today
  | "date_error" // the "Check your dates" state (every refused request, HTTP 400 included)
  | "load_error"; // the "We couldn't load parking" panel

export type SearchFailure = Extract<SearchOutcome, "date_error" | "load_error">;

/**
 * What started the search. A `sort` re-fetch repeats the search with a new
 * order (usually the same lots), so count searches with it filtered out.
 */
export type SearchTrigger = "initial" | "submit" | "sort" | "retry";

export type PriceBand = "under_50" | "50_99" | "100_199" | "200_plus";

/**
 * The parts of the /api/search answer this module reads (SearchParkingResult
 * in src/lib/reslab/search.ts). Written out, not derived: this module is
 * imported by client code that must not reach the server's search module
 * (hotels/__tests__/import-guard.test.ts). The dates stay `unknown`: the page
 * hands over unparsed JSON, and isDate checks them.
 */
export type SearchAnswer = {
  results?: UnifiedLot[];
  closedForToday?: boolean;
  degraded?: boolean;
  reslabUnavailable?: boolean;
  directUnavailable?: boolean;
  listIncomplete?: boolean;
  checkin?: unknown;
  checkout?: unknown;
};

/** One search attempt ended in exactly one of these. */
export type SearchResult = { answer: SearchAnswer; failure?: never } | { failure: SearchFailure; answer?: never };

export type SearchEventInput = {
  airportCode: string;
  trigger: SearchTrigger;
  sortBy: SortOption;
  /**
   * Whether the visitor chose BOTH dates (in the link or the picker). The page
   * fills in today / +7 days when a link has none; those are not a choice.
   */
  datesPicked: boolean;
  /** The dates sent to the search ("" for a cleared return date). */
  checkin: string;
  checkout: string;
  /** The visitor's own calendar date, YYYY-MM-DD (the same basis as checkout_view's lead_days). */
  today: string;
} & SearchResult;

export type SearchEventParams = {
  search_term: string;
  airport_code: string;
  checkin_date?: string;
  checkout_date?: string;
  search_outcome: SearchOutcome;
  search_trigger: SearchTrigger;
  sort_by: SortOption;
  dates_defaulted: 0 | 1;
  lead_days?: number;
  stay_days?: number;
  lots_shown?: number;
  price_band?: PriceBand;
};

/**
 * How an answered request ended, from what the page does with the response
 * (src/app/(main)/search/page.tsx fetchResults): a 400 is the "Check your
 * dates" state, any other failure the "couldn't load" panel.
 */
export function searchResultFromResponse(ok: boolean, status: number, body: unknown): SearchResult {
  const data = typeof body === "object" && body !== null ? (body as SearchAnswer & { error?: unknown }) : null;
  if (!ok || !data || data.error) return { failure: status === 400 ? "date_error" : "load_error" };
  return { answer: data };
}

const lotsOf = (a: SearchAnswer): UnifiedLot[] => (Array.isArray(a.results) ? a.results : []);

/**
 * The outcome of an answered search, by what the page showed: the page's
 * partial banner is set by `reslabUnavailable` alone, and "closed today" only
 * replaces an empty list.
 */
export function answerOutcome(a: SearchAnswer): Exclude<SearchOutcome, SearchFailure> {
  const count = lotsOf(a).length;
  if (count === 0 && a.closedForToday === true) return "closed_today";
  if (a.reslabUnavailable === true) return "partial";
  return count === 0 ? "empty" : "ok";
}

/** A band, not the amount: a GA4 dimension has to be low-cardinality to split a funnel. */
export function priceBand(total: number): PriceBand {
  if (total < 50) return "under_50";
  if (total < 100) return "50_99";
  if (total < 200) return "100_199";
  return "200_plus";
}

/**
 * The cheapest total the searcher was shown (grand total + service fee, the
 * card's "$X total"), or null. The server marks that lot with the
 * "lowest_total" badge and withholds the badge when the list is not the full
 * picture, so the badge is the source. Without badges (recommended ranking
 * switched off) it is computed the same way, and withheld on any incomplete flag.
 */
function cheapestShown(a: SearchAnswer): number | null {
  const lots = lotsOf(a);
  const badged = lots.find((l) => l?.badges?.includes("lowest_total"));
  const anyBadge = lots.some((l) => (l?.badges?.length ?? 0) > 0);
  const lot =
    badged ??
    (anyBadge
      ? null
      : lowestTotalLot(lots, {
          resultComplete: !(a.degraded || a.reslabUnavailable || a.directUnavailable || a.listIncomplete),
        }));
  if (!lot) return null;
  const total = lotTotal(lot);
  return Number.isFinite(total) ? total : null;
}

const isDate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

export function buildSearchEventParams(input: SearchEventInput): SearchEventParams {
  // A failure wins even if an untyped caller passes both.
  const answer = input.failure ? undefined : input.answer;
  const checkin = isDate(answer?.checkin) ? answer.checkin : input.checkin;
  const checkout = isDate(answer?.checkout) ? answer.checkout : input.checkout;
  // A date the visitor did not pick, or one left empty (the server then prices
  // a default range): either way the stay searched was not their choice.
  const datesDefaulted = !input.datesPicked || !input.checkin || !input.checkout;

  const params: SearchEventParams = {
    search_term: input.airportCode,
    airport_code: input.airportCode,
    checkin_date: checkin || undefined,
    checkout_date: checkout || undefined,
    // Neither an answer nor a failure cannot be typed; report it as nothing shown.
    search_outcome: input.failure ?? (answer ? answerOutcome(answer) : "load_error"),
    search_trigger: input.trigger,
    sort_by: input.sortBy,
    dates_defaulted: datesDefaulted ? 1 : 0,
  };

  // Made-up dates have no lead time or trip length worth recording.
  if (!datesDefaulted) {
    params.lead_days = leadDays(checkin, input.today) ?? undefined;
    // Calendar days between the two dates (leadDays is plain date subtraction),
    // not the supplier's billed days.
    params.stay_days = leadDays(checkout, checkin) ?? undefined;
  }

  if (answer) {
    params.lots_shown = lotsOf(answer).length;
    const cheapest = cheapestShown(answer);
    if (cheapest !== null) params.price_band = priceBand(cheapest);
  }
  return params;
}
