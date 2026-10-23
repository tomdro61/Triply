/**
 * Calendar-string arithmetic for Park & Stay — no timezone, no Date parsing
 * of an input date.
 *
 * Booking dates are literal airport-local strings ("YYYY-MM-DD"). Deriving a
 * date with `new Date(iso)` / `toISOString()` / ±86 400 000 ms is banned in
 * this codebase (the May 2026 timezone bugs): `new Date("2026-05-10")` is UTC
 * midnight, the previous evening in every US timezone, and a DST day is not
 * 86 400 000 ms long. `Date.UTC(y, m−1, d ± n)` + `getUTC*` is exact for
 * calendar math and cannot be shifted by the server's TZ.
 *
 * Plan v3 §4: the hotel night is the night BEFORE departure only (decision
 * 4A); the "after" night and the old parking-derived night are gone. The
 * customer gives the night directly.
 */

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A syntactically valid AND real calendar date ("2026-02-30" is not). */
export function isIsoDate(value: string): boolean {
  if (!ISO_DATE_RE.test(value)) return false;
  const y = Number(value.slice(0, 4));
  const m = Number(value.slice(5, 7));
  const d = Number(value.slice(8, 10));
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/** A real calendar date, not just the shape: "2026-02-30" would otherwise roll over to 2 March. */
function assertIsoDate(label: string, value: string): void {
  if (!isIsoDate(value)) {
    throw new Error(`${label} must be a real YYYY-MM-DD date, got ${JSON.stringify(value)}`);
  }
}

function utcDayNumber(iso: string): number {
  return Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / 86_400_000;
}

/** Calendar-day shift with no timezone involvement. */
export function shiftIsoDate(iso: string, days: number): string {
  assertIsoDate("date", iso);
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  const d = Number(iso.slice(8, 10));
  const t = new Date(Date.UTC(y, m - 1, d + days));
  const yy = t.getUTCFullYear();
  const mm = String(t.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(t.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/** Whole calendar days from `from` to `to` (negative when `to` is earlier). */
export function isoDayDiff(from: string, to: string): number {
  assertIsoDate("from", from);
  assertIsoDate("to", to);
  return Math.round(utcDayNumber(to) - utcDayNumber(from));
}

/**
 * Today's calendar date in an IANA timezone, as "YYYY-MM-DD". `Intl` is exact
 * and needs no library.
 */
export function todayInZone(timeZone: string, now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}
