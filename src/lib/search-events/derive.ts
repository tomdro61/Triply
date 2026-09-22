/**
 * Pure date math for search_events: stay length and lead time.
 *
 * Deliberately takes and returns plain YYYY-MM-DD strings — checkin/checkout
 * here are the same literal date strings the search route already validates
 * (zod `\d{4}-\d{2}-\d{2}`), never Date objects. Mirrors the UTC-day-diff
 * approach in src/lib/availability/log.ts (dayDiff): for a length-of-stay /
 * lead-time demand signal the calendar-day difference is what matters, not
 * any airport's local clock (unlike booking times, which are literal
 * airport-local strings — see the CLAUDE.md rule — these are plain dates with
 * no time-of-day component to get wrong).
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Whole calendar days between two YYYY-MM-DD dates (UTC). Null, not NaN, on
 *  an unparseable input — the caller decides how to treat that. */
function daysBetween(fromDate: string, toDate: string): number | null {
  if (!DATE_RE.test(fromDate) || !DATE_RE.test(toDate)) return null;
  const from = Date.parse(`${fromDate}T00:00:00Z`);
  const to = Date.parse(`${toDate}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  return Math.round((to - from) / DAY_MS);
}

/** Today (UTC) as YYYY-MM-DD — the default baseline lead_days is measured
 *  from when the caller doesn't pass one explicitly (tests do, for
 *  determinism). */
export function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

export interface SearchEventDates {
  /** check_out − check_in, in whole days. */
  stayDays: number;
  /** check_in − searchedOn, in whole days. Can be negative (a search for a
   *  check-in date already in the past) — that's still a real signal, not an
   *  error, so it is not rejected here. */
  leadDays: number;
}

/**
 * Derives stay_days and lead_days from a search's dates.
 *
 * Returns null for a range the table's CHECK (stay_days >= 0) would reject
 * (checkout on/before... actually before checkin) or for unparseable input —
 * the caller skips logging rather than writing a row a NOT NULL/CHECK
 * constraint would bounce anyway. Same-day (checkin === checkout) is a valid
 * 0-night stay, not an error.
 */
export function deriveSearchEventDates(
  checkin: string,
  checkout: string,
  searchedOn: string = utcToday()
): SearchEventDates | null {
  const stayDays = daysBetween(checkin, checkout);
  const leadDays = daysBetween(searchedOn, checkin);
  if (stayDays === null || leadDays === null) return null;
  if (stayDays < 0) return null; // checkout before checkin — invalid range
  return { stayDays, leadDays };
}
