/**
 * Admin date ranges run on Eastern calendar days, wherever the code runs.
 * `setHours(0, 0, 0, 0)` used the machine's clock: UTC on Vercel, so the
 * dashboard's "Today" ran 8 PM–8 PM ET (7 PM in winter), and the browser's
 * zone on the pages. A date input's "YYYY-MM-DD" parsed with `new Date()` is
 * UTC midnight, so a custom range started the evening before.
 *
 * Pure Intl arithmetic (the digest's helpers) — safe in the browser too.
 */
import { DIGEST_TZ, calendarDayIn, shiftIsoDate, zonedMidnightUtc } from "@/lib/digest/window";

export const ADMIN_TZ = DIGEST_TZ;

/** Midnight Eastern at the start of a calendar day, as an ISO instant. */
export function etDayStart(dateIso: string): string {
  return zonedMidnightUtc(dateIso, ADMIN_TZ).toISOString();
}

export interface EtDayBounds {
  /** Today's Eastern calendar day, "YYYY-MM-DD". */
  day: string;
  todayStart: string;
  tomorrowStart: string;
  /** Sunday of this week, Eastern. */
  weekStart: string;
  monthStart: string;
}

export function etDayBounds(now: Date = new Date()): EtDayBounds {
  const day = calendarDayIn(ADMIN_TZ, now);
  const [y, m, d] = day.split("-").map(Number);
  const dayOfWeek = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return {
    day,
    todayStart: etDayStart(day),
    tomorrowStart: etDayStart(shiftIsoDate(day, 1)),
    weekStart: etDayStart(shiftIsoDate(day, -dayOfWeek)),
    monthStart: etDayStart(`${day.slice(0, 7)}-01`),
  };
}

/**
 * `startDate` / `endDate` (end exclusive) for an admin list or stats request.
 * `preset` is the pages' select value ("all" | "today" | "week" | "month" |
 * "last7" | "last30" | "custom"); "all" and anything else mean no date filter,
 * as before. Custom dates come from `<input type="date">` ("YYYY-MM-DD"); the
 * end day is included, so the range ends at the next Eastern midnight.
 */
export function adminDateRange(
  preset: string,
  custom: { start?: string; end?: string } = {},
  now: Date = new Date()
): { startDate?: string; endDate?: string } {
  const b = etDayBounds(now);
  switch (preset) {
    case "today":
      return { startDate: b.todayStart, endDate: b.tomorrowStart };
    case "week":
      return { startDate: b.weekStart };
    case "month":
      return { startDate: b.monthStart };
    case "last7":
    case "last30":
      // Today plus the 6 (or 29) days before.
      return { startDate: etDayStart(shiftIsoDate(b.day, preset === "last7" ? -6 : -29)) };
    case "custom":
      if (!custom.start) return {};
      return {
        startDate: etDayStart(custom.start),
        ...(custom.end ? { endDate: etDayStart(shiftIsoDate(custom.end, 1)) } : {}),
      };
    default:
      return {};
  }
}
