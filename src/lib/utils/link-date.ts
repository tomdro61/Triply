/** A search param as Next hands it to a page: a repeated param is an array. */
export type LinkParam = string | string[] | undefined;

/**
 * The date a link's `checkin` / `checkout` parameter names, as "YYYY-MM-DD",
 * or undefined when it names no real date.
 *
 * Links from outside (shared links, other sites, AI assistants) sometimes carry
 * a date and time ("2026-12-05T18:00"). The lot page passed those straight to
 * the booking widget, whose date formatting threw, and the customer got an
 * error page instead of the lot (Sentry TRIPLY-2D). The date part of a local
 * date-time is kept as written. The time part is dropped and never becomes a
 * booking time; times come only from the link's own checkinTime / checkoutTime.
 *
 * Accepted: YYYY-MM-DD, optionally followed by "T" or a space and HH:mm, with
 * optional seconds and fraction. NOT accepted: a "Z" or ±HH:mm offset — that is
 * a UTC instant whose written date can be a day off the airport's
 * ("2026-12-14T02:00Z" is Dec 13 in New York), so it reads as no date rather
 * than a wrong one. Anything else, including a repeated param, also reads as no
 * date, the same as a link without one.
 */
export function linkDate(value: LinkParam): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = value.match(/^(\d{4}-\d{2}-\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?$/);
  if (!match) return undefined;
  const date = match[1];
  // "2026-02-30" has the right shape but isn't a day: Date rolls it to March 2.
  const t = Date.parse(`${date}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === date ? date : undefined;
}

/**
 * The lot page's link params, safe to use: dates through linkDate, times only
 * when they're a single string (the widget and pricing check the value itself).
 */
export function lotLinkQuery(query: Partial<Record<"checkin" | "checkout" | "checkinTime" | "checkoutTime", LinkParam>>) {
  const single = (v: LinkParam) => (typeof v === "string" ? v : undefined);
  return {
    checkin: linkDate(query.checkin),
    checkout: linkDate(query.checkout),
    checkinTime: single(query.checkinTime),
    checkoutTime: single(query.checkoutTime),
  };
}
