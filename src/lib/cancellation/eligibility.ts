import { TZDate } from "@date-fns/tz";

/**
 * Self-service cancellation eligibility — the airport-local 24h gate.
 *
 * A customer may self-cancel a reservation ONLY when "now" is more than 24 hours
 * before check-in, evaluated in the LOT'S local timezone. This is the single
 * highest-risk piece of the self-cancel feature: this codebase has a documented
 * history of TIMESTAMPTZ / UTC-parse bugs (see migration 007), and `check_in` is
 * a tz-less airport-local wall-clock TIMESTAMP. Getting the parse wrong lets a
 * customer inside the 24h window slip through (or blocks one who shouldn't be).
 *
 * The gate is computed SERVER-SIDE only; the client never runs this (its clock
 * and timezone are both untrustworthy).
 */

export type CancelReason = "ok" | "within_24h" | "unknown_timezone" | "bad_timestamp";

/**
 * Discriminated union so the boolean and the reason can never drift: a
 * `cancellable: true` result ALWAYS carries `reason: "ok"`, and every failure
 * reason implies `cancellable: false`. Callers narrow on `.cancellable`.
 */
export type CancellabilityResult =
  | { cancellable: true; reason: "ok" }
  | { cancellable: false; reason: Exclude<CancelReason, "ok"> };

/** Hours before check-in after which self-cancellation is cut off. */
export const CANCEL_CUTOFF_HOURS = 24;
const CUTOFF_MS = CANCEL_CUTOFF_HOURS * 60 * 60 * 1000;

// Accepts BOTH the stored space form ("YYYY-MM-DD HH:mm:ss") and the
// PostgREST/supabase-js read-back "T" form ("YYYY-MM-DDTHH:mm:ss"), with
// optional seconds. Anchored end-to-end and it deliberately allows NO trailing
// offset or "Z": check_in is a tz-less wall-clock value, so an offset would mean
// the value is not what we expect — we must fail closed rather than guess.
const WALL_CLOCK_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;

interface WallClockParts {
  y: number;
  mo: number; // 1-12
  d: number;
  h: number;
  mi: number;
  s: number;
}

/**
 * Parse + RANGE-validate a wall-clock string. Returns null on a format miss or
 * an out-of-range component. Range-checking matters because the regex only
 * validates SHAPE (`\d{2}`): without this, "2026-02-29 10:00" (non-leap Feb 29),
 * "2026-13-15", or "...25:00" pass the regex, and `TZDate.tz`/`Date` then
 * NORMALIZE the overflow into a valid-but-shifted instant (Mar 1, next year,
 * +1 day) — silently producing a WRONG cancel decision instead of failing
 * closed. Component-level validation catches these without touching DST
 * resolution (a spring-forward gap time has in-range components and is left to
 * the library, which resolves it deterministically).
 */
function parseWallClock(checkIn: string): WallClockParts | null {
  const m = checkIn.match(WALL_CLOCK_RE);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const h = Number(m[4]);
  const mi = Number(m[5]);
  const s = m[6] ? Number(m[6]) : 0;

  if (mo < 1 || mo > 12) return null;
  if (h > 23 || mi > 59 || s > 59) return null;
  // Last day of month `mo` (leap-year-correct): day 0 of the next month.
  const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  if (d < 1 || d > daysInMonth) return null;

  return { y, mo, d, h, mi, s };
}

/**
 * The absolute epoch-ms of an airport-local wall-clock string interpreted in
 * `tz`. Returns `number | null` (NOT a NaN sentinel: under strictNullChecks a
 * `null` forces every caller to guard, whereas a NaN would silently propagate
 * through arithmetic and read as a legitimate "in window" answer). `null` on an
 * unparseable/out-of-range timestamp or an invalid IANA zone.
 *
 * Exported so tests can assert the exact instant (EDT vs EST vs non-Eastern) —
 * the only way to prove DST/offset handling.
 *
 * Builds the instant from PARSED COMPONENTS via `TZDate.tz` (never
 * `new TZDate(checkIn, tz)` / `new Date(checkIn)` / `parseISO`: a tz-less string
 * parses in the runtime zone = UTC on Vercel, off by the airport offset).
 */
export function checkInInstantMs(
  checkIn: string | null | undefined,
  tz: string | null | undefined,
): number | null {
  if (!tz || typeof checkIn !== "string") return null;
  const c = parseWallClock(checkIn);
  if (!c) return null;
  try {
    const ms = TZDate.tz(tz, c.y, c.mo - 1, c.d, c.h, c.mi, c.s).getTime();
    return Number.isNaN(ms) ? null : ms;
  } catch {
    // Invalid IANA zone → Intl throws. Fail closed.
    return null;
  }
}

/**
 * Is a booking self-cancellable right now?
 *
 * @param checkIn - the booking's `check_in`: a tz-less airport-local wall-clock
 *   string. NEVER a UTC instant / ISO-with-offset.
 * @param locationTimezone - the lot's IANA zone (e.g. "America/New_York"),
 *   persisted on the booking from ResLab's `location.timezone.code`.
 * @param now - epoch-ms "now" (injectable for tests); defaults to `Date.now()`.
 *
 * Fails CLOSED (`cancellable: false`) on a missing timezone or an unparseable /
 * out-of-range / invalid input — it NEVER defaults to "allowed". A missing
 * timezone routes the customer to support rather than risking a wrong decision.
 */
export function isCancellable(
  checkIn: string | null | undefined,
  locationTimezone: string | null | undefined,
  now: number = Date.now(),
): CancellabilityResult {
  if (!locationTimezone) {
    return { cancellable: false, reason: "unknown_timezone" };
  }
  const c = typeof checkIn === "string" ? parseWallClock(checkIn) : null;
  if (!c) {
    return { cancellable: false, reason: "bad_timestamp" };
  }
  let instantMs: number;
  try {
    instantMs = TZDate.tz(
      locationTimezone,
      c.y,
      c.mo - 1,
      c.d,
      c.h,
      c.mi,
      c.s,
    ).getTime();
  } catch {
    // Invalid IANA zone.
    return { cancellable: false, reason: "unknown_timezone" };
  }
  if (Number.isNaN(instantMs)) {
    return { cancellable: false, reason: "unknown_timezone" };
  }
  if (now < instantMs - CUTOFF_MS) {
    return { cancellable: true, reason: "ok" };
  }
  return { cancellable: false, reason: "within_24h" };
}
