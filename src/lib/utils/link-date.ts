/**
 * The date a link's `checkin` / `checkout` parameter names, as "YYYY-MM-DD",
 * or undefined when it names no real date.
 *
 * Links from outside (shared links, other sites, AI assistants) sometimes carry
 * a date and time ("2026-12-05T18:00"). The lot page passed those straight to
 * the booking widget, whose date formatting threw, and the customer got an
 * error page instead of the lot (Sentry TRIPLY-2D). The date part is kept; the
 * time part is ignored, so the customer still picks their times. Anything else
 * reads as no date, the same as a link without one.
 */
export function linkDate(value: string | undefined): string | undefined {
  const match = value?.match(/^(\d{4}-\d{2}-\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/);
  if (!match) return undefined;
  const date = match[1];
  // "2026-02-30" has the right shape but isn't a day: Date rolls it to March 2.
  const t = Date.parse(`${date}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === date ? date : undefined;
}
