/**
 * The digest's day is an `America/New_York` CALENDAR day (plan v2 §1): a UTC day
 * would put 4 h of the previous evening in and drop 20:00–24:00 ET, the peak
 * booking hours. Everything here is Intl + integer arithmetic — no library,
 * and no Date parsing of booking wall-clock strings (those never enter).
 */

export const DIGEST_TZ = "America/New_York";

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface DigestWindow {
  /** "YYYY-MM-DD" in ET. */
  dateEt: string;
  /** Inclusive start instant (ET midnight). */
  startUtc: Date;
  /** Exclusive end instant (next ET midnight). */
  endUtc: Date;
  /** "Sept 27, 2026 · 00:00–24:00 ET" for the footer. */
  label: string;
}

/** Calendar day of an instant in a zone, "YYYY-MM-DD". */
export function calendarDayIn(timeZone: string, instant: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(instant);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Pure calendar shift, no timezone (Date.UTC handles month/year/leap rollover). */
export function shiftIsoDate(iso: string, days: number): string {
  if (!ISO_DATE_RE.test(iso)) throw new Error(`expected YYYY-MM-DD, got ${JSON.stringify(iso)}`);
  const [y, m, d] = iso.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
}

/** The zone's UTC offset (minutes) at an instant, from Intl — DST-correct. */
function offsetMinutesAt(timeZone: string, instant: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(instant);
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  const wall = Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second"));
  return Math.round((wall - instant.getTime()) / 60_000);
}

/** The instant of local midnight for a calendar day in a zone (DST-safe). */
export function zonedMidnightUtc(dateIso: string, timeZone: string): Date {
  if (!ISO_DATE_RE.test(dateIso)) throw new Error(`expected YYYY-MM-DD, got ${JSON.stringify(dateIso)}`);
  const [y, m, d] = dateIso.split("-").map(Number);
  // Noon UTC is the same calendar day in every US zone; read the offset there,
  // compute midnight, then re-read the offset AT midnight in case a DST change
  // sits between noon and midnight (spring-forward / fall-back days).
  const noon = new Date(Date.UTC(y, m - 1, d, 12));
  let midnight = new Date(Date.UTC(y, m - 1, d) - offsetMinutesAt(timeZone, noon) * 60_000);
  const at = offsetMinutesAt(timeZone, midnight);
  midnight = new Date(Date.UTC(y, m - 1, d) - at * 60_000);
  return midnight;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sept", "Oct", "Nov", "Dec"];

export function windowForEtDay(dateEt: string): DigestWindow {
  const startUtc = zonedMidnightUtc(dateEt, DIGEST_TZ);
  const endUtc = zonedMidnightUtc(shiftIsoDate(dateEt, 1), DIGEST_TZ);
  const [y, m, d] = dateEt.split("-").map(Number);
  return { dateEt, startUtc, endUtc, label: `${MONTHS[m - 1]} ${d}, ${y} · 00:00–24:00 ET` };
}

/** "Yesterday" for a run at `now`: the ET calendar day before today's ET day. */
export function yesterdayEt(now: Date = new Date()): string {
  return shiftIsoDate(calendarDayIn(DIGEST_TZ, now), -1);
}

/** A trailing window of `days` ET days ending the day BEFORE `dateEt` (exclusive of it). */
export function trailingWindow(dateEt: string, days: number): { startUtc: Date; endUtc: Date; firstDay: string } {
  const firstDay = shiftIsoDate(dateEt, -days);
  return { startUtc: zonedMidnightUtc(firstDay, DIGEST_TZ), endUtc: zonedMidnightUtc(dateEt, DIGEST_TZ), firstDay };
}
