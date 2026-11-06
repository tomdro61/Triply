/**
 * What a lot's shuttle actually does, read from ResLab's free-text
 * `shuttleInfo.summary`. Pure, so every pattern seen in live data is pinned by
 * __tests__/shuttle-status.test.ts.
 *
 * Why: cards and hubs used to say "Shuttle" / "Yes" for any lot that had a
 * shuttleInfo object, including lots whose summary reads "No shuttle", and the
 * search card's "No Shuttle" chip keyed on an amenity no lot carries. A lot
 * with no shuttle could win "Lowest total" with nothing on the card saying so
 * (customer-army audit, 2026-11-06, items 2 and 3).
 *
 * The parser is deliberately conservative: anything it can't read with
 * confidence is "unknown", and unknown shows no chip and raises no warning. A
 * wrong "24/7" is worse than saying nothing.
 */

import { parseTime12Strict } from "@/lib/utils/time";

/** Minutes after midnight, 0–1440. */
export interface ShuttleWindow {
  start: number;
  end: number;
}

export type ShuttleStatus =
  | { kind: "none" }
  | { kind: "suspended" }
  | { kind: "all_day" }
  /** windows = when the shuttle runs; null when the hours vary by weekday. */
  | { kind: "hours"; windows: ShuttleWindow[] | null }
  | { kind: "unknown" };

const TIME = String.raw`(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?`;
const TIME_OR_MIDNIGHT = String.raw`(?:${TIME}|(midnight|noon))`;

/** "4:30 AM" → 270; "12:00 AM" → 0; "midnight" → 0; "noon" → 720. */
function toMinutes(h: string | undefined, m: string | undefined, ap: string | undefined, word?: string): number | null {
  if (word) return word.toLowerCase() === "noon" ? 720 : 0;
  if (h === undefined || ap === undefined) return null;
  const hour = Number(h);
  const min = m === undefined ? 0 : Number(m);
  if (!Number.isInteger(hour) || hour < 1 || hour > 12 || min < 0 || min > 59) return null;
  const pm = ap.toLowerCase() === "p";
  return ((hour % 12) + (pm ? 12 : 0)) * 60 + min;
}

/** End-of-window "12:00 AM" means the end of the day, not its start. */
function asEnd(start: number, end: number): number {
  return end === 0 && start > 0 ? 1440 : end;
}

/** Every "A - B" / "A to B" / "A till B" range in the text, in order. */
function ranges(text: string): { start: number; end: number; tail: string }[] {
  const re = new RegExp(String.raw`${TIME_OR_MIDNIGHT}\s*(?:-|–|—|to|till|until)\s*${TIME_OR_MIDNIGHT}`, "gi");
  const out: { start: number; end: number; tail: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const start = toMinutes(m[1], m[2], m[3], m[4]);
    const end = toMinutes(m[5], m[6], m[7], m[8]);
    if (start === null || end === null) continue;
    // What the range describes: the text up to the next range.
    const rest = text.slice(re.lastIndex);
    const next = rest.search(new RegExp(TIME_OR_MIDNIGHT, "i"));
    out.push({ start, end: asEnd(start, end), tail: next === -1 ? rest : rest.slice(0, next) });
  }
  return out;
}

/**
 * "4:00 AM - 7:30 AM every 30 min · 7:30 AM - 11:00 PM on demand" is one
 * running window, 4 AM–11 PM. Windows arrive in the summary's order.
 */
function mergeTouching(windows: ShuttleWindow[]): ShuttleWindow[] {
  const out: ShuttleWindow[] = [];
  for (const w of windows) {
    const last = out[out.length - 1];
    if (last && last.end % 1440 === w.start % 1440) last.end = w.end;
    else out.push({ ...w });
  }
  // "12 AM - 2 AM … 5 AM - 12 AM" is one window, 5 AM–2 AM, across midnight.
  if (out.length > 1 && out[out.length - 1].end === 1440 && out[0].start === 0) {
    const last = out[out.length - 1];
    out[0] = { start: last.start, end: out[0].end };
    out.length -= 1;
  }
  return out;
}

const WEEKDAY =/\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*\s*[-–]\s*(mon|tue|wed|thu|fri|sat|sun)/i;
/** Direction- or cruise-specific schedules that one window can't describe. */
const SPLIT_SCHEDULE = /from the airport to|to the parking lot|check-?in starts|shuttles? to airport start|embark|disembark|cruise terminal/i;
/**
 * Continuous service. Not "24 hours notice / in advance / ahead": that is a
 * booking rule, not an operating schedule.
 */
const ALL_DAY = /\b24\/7\b|\b24 hours\b(?!['’]?\s*(?:advance|notice|ahead|in advance|before|prior))/i;

/** True when the windows together cover every minute of the day. */
function coversWholeDay(windows: readonly ShuttleWindow[]): boolean {
  const covered = new Array<boolean>(1440).fill(false);
  for (const w of windows) {
    const end = w.end <= w.start ? w.end + 1440 : w.end;
    for (let m = w.start; m < end; m++) covered[m % 1440] = true;
  }
  return covered.every(Boolean);
}

/** Every standalone clock time in the text ("3PM", "5:00 PM"), in minutes. */
function clockTimes(text: string): number[] {
  const re = new RegExp(TIME, "gi");
  const out: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const t = toMinutes(m[1], m[2], m[3]);
    if (t !== null) out.push(t);
  }
  return out;
}

export function shuttleStatus(summary: string | null | undefined): ShuttleStatus {
  const text = (summary ?? "").replace(/\s+/g, " ").trim();
  if (!text) return { kind: "unknown" };

  const found = ranges(text);
  // "No shuttle" with no hours attached. "No shuttle between 11 PM and 5 AM.
  // Shuttle runs 5 AM to 11 PM." is a schedule, not an absence.
  // Only a bare "No shuttle", ending the text or followed by punctuation (the
  // live forms: "No shuttle.", "No Shuttle, guests must…", "NO SHUTTLE"). "No
  // shuttle after 11 PM / on Sundays / between 11 PM and 5 AM" is a schedule.
  if (/^no shuttle\s*($|[.,;:!])/i.test(text) && clockTimes(text).length === 0) return { kind: "none" };
  // The shuttle itself suspended, in one sentence ("Shuttle temporarily
  // suspended"), not "valet service suspended" or a suspension window.
  if (clockTimes(text).length === 0 && /shuttle[^.]*\bsuspended\b|\bsuspended\b[^.]*shuttle/i.test(text)) {
    return { kind: "suspended" };
  }
  if (SPLIT_SCHEDULE.test(text)) return { kind: "unknown" };

  // ResLab's structured form: "4:00 AM - 11:00 PM: Shuttle runs …  11:00 PM - 4:00 AM: No shuttle."
  const structured = found.length > 0 && found.every((r) => /^\s*:/.test(r.tail));
  if (structured) {
    if (WEEKDAY.test(text)) return { kind: "hours", windows: null };
    // Every row must say either that the shuttle runs or that there is none;
    // anything else ("Shuttle suspended", "Closed") is not ours to interpret.
    const runs = (tail: string) =>
      /shuttle runs|every|on demand|on call/i.test(tail) && !/suspend|closed|no shuttle/i.test(tail);
    if (found.some((r) => !runs(r.tail) && !/no shuttle/i.test(r.tail))) return { kind: "unknown" };
    const running = found.filter((r) => runs(r.tail)).map(({ start, end }) => ({ start, end }));
    if (running.length === 0) return { kind: "none" };
    // 24/7 only when the running windows really cover the day; a lone
    // "6:00 AM - 11:00 PM: Shuttle runs every 30 minutes." is 6 AM–11 PM.
    if (coversWholeDay(running)) return { kind: "all_day" };
    return { kind: "hours", windows: mergeTouching(running) };
  }

  if (ALL_DAY.test(text)) {
    // A stated range next to "24/7" contradicts it: say nothing.
    if (found.length > 0) return { kind: "unknown" };
    // The "24/7" must describe the shuttle, in its own sentence, and not be
    // negated: "Lot open 24 hours. Shuttle every 30 minutes from 6 AM." and
    // "Shuttle does not run 24/7." are not 24/7 service; nor are "24/7
    // complimentary Lyft" or "24/7 Valet Service". ("hour" is not evidence:
    // "24 hours" itself contains it.)
    const continuous = text
      .split(/[.;]/)
      .some((s) => ALL_DAY.test(s) && /shuttle|every|on demand|on call|runs|pick ?-?ups?/i.test(s) && !/\bnot\b|n['’]t\b/i.test(s));
    return continuous ? { kind: "all_day" } : { kind: "unknown" };
  }

  if (WEEKDAY.test(text)) return { kind: "hours", windows: null };

  // Free-form "5 AM - 10 PM, every 30 minutes" / "Shuttle runs 4 AM to 11 PM".
  // Only a single range is trusted; two ranges usually mean a split schedule.
  if (found.length === 1) {
    const [{ start, end }] = found;
    if (start === end || (start === 0 && end === 1440)) return { kind: "all_day" };
    const window = { start, end };
    // The range may describe the GAP, not the service ("suspended 1 AM - 4 AM",
    // "closed 12 PM - 4 PM", "no shuttle 11 PM - 5 AM"). Only "no shuttle
    // outside of these hours" is known to mean the range is the service.
    const gapWords = /suspend|except|closed|no shuttle(?! outside)/i;
    if (gapWords.test(text)) return { kind: "unknown" };
    // Any other clock time outside the range contradicts it ("4AM - 12PM ...
    // except at 3PM and 11PM", "4 AM - 12 PM. Office closes at 5 PM"): never
    // guess which one the lot meant.
    if (clockTimes(text).some((t) => !inWindow(t, window))) return { kind: "unknown" };
    return { kind: "hours", windows: [window] };
  }

  return { kind: "unknown" };
}

/** "4:30 AM", "11 PM", "midnight". */
export function formatMinutes(min: number): string {
  const m = ((min % 1440) + 1440) % 1440;
  if (m === 0) return "midnight";
  if (m === 720) return "noon";
  const h24 = Math.floor(m / 60);
  const mm = m % 60;
  const ap = h24 < 12 ? "AM" : "PM";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return mm === 0 ? `${h12} ${ap}` : `${h12}:${String(mm).padStart(2, "0")} ${ap}`;
}

/** Short chip text, or null when the card should say nothing. */
export function shuttleLabel(status: ShuttleStatus): string | null {
  switch (status.kind) {
    case "none":
      return "No shuttle";
    case "suspended":
      return "Shuttle suspended";
    case "all_day":
      return "24/7 shuttle";
    case "hours":
      if (status.windows && status.windows.length === 1) {
        const [w] = status.windows;
        return `Shuttle ${formatMinutes(w.start)}–${formatMinutes(w.end)}`;
      }
      return "Shuttle: limited hours";
    case "unknown":
      return null;
  }
}

/**
 * The amenities to list beside the shuttle chip: a "shuttle" amenity is
 * dropped whenever the chip already states the shuttle from shuttleInfo, so the
 * card can never say "Free Shuttle" next to "No shuttle". With no chip (an
 * unreadable summary) the amenity stays, as before.
 */
export function amenitiesBesideShuttle<T extends { displayName: string }>(
  amenities: readonly T[],
  summary: string | null | undefined
): T[] {
  if (shuttleLabel(shuttleStatus(summary)) === null) return [...amenities];
  return amenities.filter((a) => !/shuttle/i.test(a.displayName));
}

/**
 * True when more than half the lots read as running a shuttle (24/7 or set
 * hours). Backs the hub copy "Most lots run a shuttle…": a lot whose summary
 * says "No shuttle" or can't be read never counts.
 */
export function mostLotsRunShuttle(lots: readonly { shuttleInfo?: { summary?: string } }[]): boolean {
  const running = lots.filter((l) => {
    const kind = shuttleStatus(l.shuttleInfo?.summary).kind;
    return kind === "all_day" || kind === "hours";
  }).length;
  return lots.length > 0 && running * 2 > lots.length;
}

/** True for the statuses a customer must notice before paying. */
export function shuttleIsWarning(status: ShuttleStatus): boolean {
  return status.kind === "none" || status.kind === "suspended";
}

/** Inclusive on both ends; windows may wrap past midnight. */
function inWindow(t: number, w: ShuttleWindow): boolean {
  // A window ending at midnight (end 1440) includes a picked "12:00 AM" (0).
  if (t === 0 && w.end === 1440) return true;
  if (w.start <= w.end) return t >= w.start && t <= w.end;
  return t >= w.start || t <= w.end;
}

/**
 * True when a time ("4:00 AM", the format the time selects use) falls outside
 * every known shuttle window. False whenever the hours are unknown, 24/7, vary
 * by weekday, or the time can't be read: only a definite miss warns.
 */
export function outsideShuttleHours(status: ShuttleStatus, time: string | null | undefined): boolean {
  if (status.kind !== "hours" || !status.windows || !time) return false;
  // The time selects' own format ("4:00 AM"), read with the shared strict parser.
  const t = parseTime12Strict(time);
  if (t === null) return false;
  return !status.windows.some((w) => inWindow(t, w));
}

/**
 * The one-line warning under the time pickers when a chosen drop-off or return
 * time is outside the shuttle's hours, or null. Same text on the search slider
 * and the lot page.
 */
export function shuttleTimeWarning(
  status: ShuttleStatus,
  checkInTime: string | null | undefined,
  checkOutTime: string | null | undefined
): string | null {
  const hours = shuttleHoursText(status);
  if (!hours) return null;
  const dropOff = outsideShuttleHours(status, checkInTime);
  const pickUp = outsideShuttleHours(status, checkOutTime);
  if (!dropOff && !pickUp) return null;
  const which =
    dropOff && pickUp
      ? `Your ${checkInTime} drop-off and ${checkOutTime} return are`
      : dropOff
        ? `Your ${checkInTime} drop-off is`
        : `Your ${checkOutTime} return is`;
  return `${which} outside shuttle hours (${hours.replace(/^Shuttle runs /, "")}). Check with the lot before booking.`;
}

/** "Shuttle runs 6 AM–11:30 PM" for the warning line, or null. */
export function shuttleHoursText(status: ShuttleStatus): string | null {
  if (status.kind !== "hours" || !status.windows) return null;
  return `Shuttle runs ${status.windows.map((w) => `${formatMinutes(w.start)}–${formatMinutes(w.end)}`).join(" and ")}`;
}
