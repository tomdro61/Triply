/**
 * Convert 12-hour time format to 24-hour format
 * "10:00 AM" -> "10:00"
 * "2:30 PM" -> "14:30"
 */
export function convertTo24Hour(time12h: string): string {
  const [time, modifier] = time12h.split(" ");
  let [hours, minutes] = time.split(":");

  if (hours === "12") {
    hours = modifier === "AM" ? "00" : "12";
  } else if (modifier === "PM") {
    hours = String(parseInt(hours, 10) + 12);
  }

  return `${hours.padStart(2, "0")}:${minutes}`;
}

/** Minutes since midnight → "10:00 AM" / "2:30 PM". Expects 0–1439. */
export function minutesTo12Hour(totalMinutes: number): string {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return convertTo12Hour(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
}

/** "2:30 PM" → 870. NaN for anything that isn't "h:mm AM|PM" (chat-supplied
 *  times are free text, so callers must handle NaN). */
export function time12ToMinutes(time12h: string): number {
  const match = /^(\d{1,2}):(\d{2})\s([AP]M)$/.exec(time12h.trim());
  if (!match) return NaN;
  const [h, m] = convertTo24Hour(`${match[1]}:${match[2]} ${match[3]}`).split(":").map(Number);
  return h * 60 + m;
}

export function isValidTimeZone(timeZone: string | null | undefined): timeZone is string {
  if (!timeZone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The wall-clock calendar date (YYYY-MM-DD) and seconds since midnight in an
 * IANA zone at an instant. `hourCycle: "h23"` — `hour12: false` can render
 * midnight as "24" in V8.
 */
export function zonedWallClock(
  timeZone: string,
  now: Date = new Date()
): { date: string; secondsOfDay: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    secondsOfDay: Number(get("hour")) * 3600 + Number(get("minute")) * 60 + Number(get("second")),
  };
}

/** Minimum gap between "now" and a same-day check-in we ask ResLab to price.
 *  Verified live 2026-10-06: a check-in ~30 min out prices, a past one 422s
 *  ("Please choose a date in the future"). */
export const SAME_DAY_LEAD_MINUTES = 30;
/** The time pickers offer :00/:30 slots from 12:00 AM to 11:30 PM. */
const SLOT_MINUTES = 30;
const LAST_SLOT_MINUTES = 23 * 60 + 30;
const LAST_MINUTE_OF_DAY = 23 * 60 + 59;
const DEFAULT_CHECKIN_MINUTES = 10 * 60; // 10:00 AM
const DEFAULT_CHECKOUT_MINUTES = 14 * 60; // 2:00 PM

/**
 * The earliest check-in slot a customer can still pick today: now + lead,
 * rounded UP to the next :00/:30 slot, counting seconds (13:30:59 + 30 min
 * must not round down to a 29-minute lead). Null once no slot is left today.
 * Done in absolute minutes — never mod 24 — so a late-night search can't wrap
 * to an early-morning time on the same date.
 */
export function earliestSameDaySlot(
  secondsOfDay: number,
  leadMinutes: number = SAME_DAY_LEAD_MINUTES
): number | null {
  const slotSeconds = SLOT_MINUTES * 60;
  const slot = (Math.ceil((secondsOfDay + leadMinutes * 60) / slotSeconds) * slotSeconds) / 60;
  return slot > LAST_SLOT_MINUTES ? null : slot;
}

/**
 * The check-in time options a customer can still choose. All of `options`,
 * unless `checkinDate` is today at the airport — then only slots at least the
 * lot's notice period (never under SAME_DAY_LEAD_MINUTES) from now, since
 * ResLab refuses a past or too-soon check-in at checkout. Empty when nothing
 * is left today. Without a timezone, nothing is filtered (unchanged behaviour);
 * `now: null` (a client component before mount, so the server render and
 * hydration agree) also leaves the list unfiltered.
 */
export function bookableCheckinTimes(
  options: readonly string[],
  checkinDate: string,
  timeZone: string | undefined,
  hoursBeforeReservation?: number,
  now: Date | null = new Date()
): readonly string[] {
  if (!timeZone || !checkinDate || now === null) return options;
  const { date: today, secondsOfDay } = zonedWallClock(timeZone, now);
  if (checkinDate !== today) return options;
  const lead = Math.max(SAME_DAY_LEAD_MINUTES, (hoursBeforeReservation || 0) * 60);
  const earliest = earliestSameDaySlot(secondsOfDay, lead);
  if (earliest === null) return [];
  return options.filter((t) => time12ToMinutes(t) >= earliest);
}

/**
 * The customer's picked check-in time if it can still be booked, else "" —
 * so a time that has passed (an old link, or a tab left open past the slot)
 * reads as unselected and the "select times" gate keeps Reserve off. Never
 * substitutes a different time: the customer must choose.
 */
export function stillBookableCheckinTime(
  picked: string,
  options: readonly string[],
  checkinDate: string,
  timeZone: string | undefined,
  hoursBeforeReservation?: number,
  now: Date = new Date()
): string {
  if (!picked) return "";
  return bookableCheckinTimes(options, checkinDate, timeZone, hoursBeforeReservation, now).includes(picked)
    ? picked
    : "";
}

export type PricingTimes =
  | { ok: true; checkinTime: string; checkoutTime: string; sameDay: boolean }
  | { ok: false; reason: "checkin_in_past" | "same_day_too_late" };

/**
 * Times to PRICE a search / lot page with when the customer hasn't picked
 * them yet. Pricing-only: results show "from $X" estimates and the customer
 * must choose real times before checkout, so a computed default is safe here
 * (CLAUDE.md allows pricing-only fallbacks) — it must never be used as a
 * booking time. Times the caller DID supply are returned untouched.
 *
 * The old fixed "10:00 AM" was in the past for every same-day search after
 * 10 AM, ResLab refused every lot, and the customer got the "try again" panel
 * (73% of same-day searches, Sep 24–Oct 6 2026). A same-day check-in now
 * prices at the earliest slot still open; any other date keeps 10:00 AM.
 *
 * `checkinDate`/`checkoutDate` are literal YYYY-MM-DD strings and are only
 * ever compared as strings — no Date math is applied to them. "Today" is
 * today in `timeZone` (the airport's or lot's), never the server's.
 */
export function resolvePricingTimes(input: {
  checkinDate: string;
  checkoutDate: string;
  timeZone: string;
  checkinTime?: string;
  checkoutTime?: string;
  leadMinutes?: number;
  now?: Date;
}): PricingTimes {
  const { checkinDate, checkoutDate, timeZone, leadMinutes = SAME_DAY_LEAD_MINUTES } = input;
  const { date: today, secondsOfDay } = zonedWallClock(timeZone, input.now);

  if (checkinDate < today) return { ok: false, reason: "checkin_in_past" };
  const sameDay = checkinDate === today;

  let checkinMinutes: number;
  let checkinTime: string;
  if (input.checkinTime !== undefined) {
    checkinTime = input.checkinTime;
    checkinMinutes = time12ToMinutes(input.checkinTime);
  } else if (sameDay) {
    const slot = earliestSameDaySlot(secondsOfDay, leadMinutes);
    if (slot === null) return { ok: false, reason: "same_day_too_late" };
    checkinMinutes = slot;
    checkinTime = minutesTo12Hour(slot);
  } else {
    checkinMinutes = DEFAULT_CHECKIN_MINUTES;
    checkinTime = minutesTo12Hour(DEFAULT_CHECKIN_MINUTES);
  }

  let checkoutTime: string;
  if (input.checkoutTime !== undefined) {
    checkoutTime = input.checkoutTime;
  } else if (
    checkoutDate === checkinDate &&
    !Number.isNaN(checkinMinutes) &&
    DEFAULT_CHECKOUT_MINUTES <= checkinMinutes
  ) {
    // Same-date return: 2:00 PM would sit at or before the check-in.
    const checkoutMinutes = checkinMinutes + 60;
    if (checkoutMinutes > LAST_MINUTE_OF_DAY) {
      if (sameDay) return { ok: false, reason: "same_day_too_late" };
      checkoutTime = minutesTo12Hour(LAST_MINUTE_OF_DAY);
    } else {
      checkoutTime = minutesTo12Hour(checkoutMinutes);
    }
  } else {
    checkoutTime = minutesTo12Hour(DEFAULT_CHECKOUT_MINUTES);
  }

  return { ok: true, checkinTime, checkoutTime, sameDay };
}

/**
 * Convert 24-hour time format to 12-hour format.
 * Accepts "HH:mm" or "HH:mm:ss"; returns e.g. "10:00 AM" or "2:30 PM".
 * Returns empty string if input is empty/malformed (caller decides how to render).
 */
export function convertTo12Hour(time24h: string): string {
  if (!time24h) return "";
  const [hStr, mStr] = time24h.split(":");
  const hours = parseInt(hStr, 10);
  const minutes = parseInt(mStr, 10);
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return "";
  const modifier = hours >= 12 ? "PM" : "AM";
  let displayHours = hours % 12;
  if (displayHours === 0) displayHours = 12;
  return `${displayHours}:${String(minutes).padStart(2, "0")} ${modifier}`;
}
