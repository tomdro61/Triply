/**
 * The `search` event's sender. In its own module, imported by the search page
 * only: building the event needs the ranking and price helpers, and gtag.ts is
 * loaded on every page (AnalyticsProvider), which should not carry them.
 */
import { safeEvent } from "@/lib/analytics/gtag";
import { buildSearchEventParams, type SearchEventInput } from "@/lib/analytics/search-event";

/**
 * A search attempt and what the searcher saw. Builds its own params, so a
 * search event cannot be sent with hand-made ones, and never throws: it is
 * called from inside the search page's fetch, where a throw would replace good
 * results with the error panel.
 */
export function trackSearch(input: SearchEventInput) {
  try {
    safeEvent("search", buildSearchEventParams(input));
  } catch {
    // Analytics only.
  }
}
