import { isValidTimeZone, parseTime12Strict, zonedWallClock } from "@/lib/utils/time";
import { CANCEL_CUTOFF_HOURS, checkInInstantMs } from "./eligibility";

/**
 * What to promise about cancellation before purchase, for a chosen check-in.
 *
 * Same rule as the server gate (eligibility.ts `isCancellable`): free online
 * cancellation while now is more than CANCEL_CUTOFF_HOURS before check-in, the
 * check-in read in the lot's time zone. The cutoff instant is built with the
 * gate's own `checkInInstantMs`, so on a daylight-saving weekend the shown time
 * moves with the real rule instead of assuming "same time the day before".
 * Display only: the server still decides every cancellation.
 *
 * Why: the slider said "Free Cancellation" for a check-in tomorrow, and the
 * checkout then dropped the line without saying cancellation was gone
 * (customer-army audit 2026-11-06, item 4).
 *
 * - "open": cancellable online; `until` is the cutoff ("Thu, Nov 19, 10:00 AM",
 *   airport-local) when the check-in time and zone are known, else null.
 * - "closed": the cutoff has already passed.
 * - "unknown": no usable date or time zone (checkout loads some lots without
 *   their airport), so only the rule itself can be stated.
 */
export type FreeCancelWindow = { kind: "open"; until: string | null } | { kind: "closed" } | { kind: "unknown" };

const CUTOFF_MS = CANCEL_CUTOFF_HOURS * 60 * 60 * 1000;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-11-19" + 36000 s → "Thu, Nov 19, 10:00 AM". */
function label(isoDate: string, secondsOfDay: number): string {
  const [y, mo, d] = isoDate.split("-").map(Number);
  const weekday = WEEKDAYS[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()];
  const min = Math.floor(secondsOfDay / 60);
  const h24 = Math.floor(min / 60);
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const time = `${h12}:${String(min % 60).padStart(2, "0")} ${h24 < 12 ? "AM" : "PM"}`;
  return `${weekday}, ${MONTHS[mo - 1]} ${d}, ${time}`;
}

export function freeCancelWindow(
  checkInDate: string | null | undefined,
  checkInTime: string | null | undefined,
  timeZone: string | null | undefined,
  now: Date | null = new Date()
): FreeCancelWindow {
  if (!checkInDate || !/^\d{4}-\d{2}-\d{2}$/.test(checkInDate) || !isValidTimeZone(timeZone)) {
    return { kind: "unknown" };
  }
  const minutes = checkInTime ? parseTime12Strict(checkInTime) : null;

  if (minutes === null) {
    // No time yet: only a check-in day whose every slot is already inside the
    // cutoff counts as closed — that is, check-in today (any time today is
    // under 24 h away).
    if (now && zonedWallClock(timeZone, now).date >= checkInDate) return { kind: "closed" };
    return { kind: "open", until: null };
  }

  const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
  const mm = String(minutes % 60).padStart(2, "0");
  const instant = checkInInstantMs(`${checkInDate} ${hh}:${mm}:00`, timeZone);
  if (instant === null) return { kind: "unknown" };
  const cutoff = instant - CUTOFF_MS;
  if (now && now.getTime() >= cutoff) return { kind: "closed" };
  const wall = zonedWallClock(timeZone, new Date(cutoff));
  return { kind: "open", until: label(wall.date, wall.secondsOfDay) };
}

/** The one line shown next to the price: same words on slider, lot page and checkout. */
export function freeCancelText(w: FreeCancelWindow): string {
  if (w.kind === "closed") return "Not cancellable online (check-in is under 24 hours away)";
  // True whatever the clock says, so it is safe when the zone is unknown.
  if (w.kind === "unknown") return "Online cancellation closes 24 hours before check-in";
  return w.until ? `Free cancellation until ${w.until}` : "Free cancellation up to 24h before check-in";
}
