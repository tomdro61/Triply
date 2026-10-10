import { format } from "date-fns";
import { TZDate } from "@date-fns/tz";
import { airports, getAirportByCode } from "@/config/airports";
import { isValidTimeZone } from "@/lib/utils/time";

/**
 * Picks the bookings the post-trip review cron may email — PURE (no I/O), so
 * every rule is unit-testable without Supabase or Resend.
 *
 * TIME RULE (CLAUDE.md): bookings.check_out is a literal airport-local wall
 * clock. It is never converted; only "now" is projected into the lot's zone
 * (bookings.location_timezone, else the airport's zone), and the two are
 * compared as "YYYY-MM-DD HH:mm" strings — the same technique as
 * checkinStillBookable in the checkout-recovery cron. When neither zone is
 * known, "now" is taken in the zone where it is EARLIEST of every zone we
 * serve, so an unknown lot is emailed late, never before the customer has
 * actually checked out. Day counts are calendar arithmetic on the two
 * "YYYY-MM-DD" strings.
 *
 * Sends:
 *   initial  — the check-out wall clock has passed at the lot, and the
 *              check-out date is at most INITIAL_MAX_DAYS_AFTER days ago
 *              (today / yesterday / the day before — one missed daily run is
 *              tolerated; older trips are never emailed, which also keeps the
 *              launch from emailing the whole back catalogue).
 *   reminder — exactly one, when the initial was SENT at least
 *              REMINDER_MIN_HOURS_AFTER_INITIAL ago, no review exists, the
 *              check-out date is REMINDER_DAYS_AFTER..REMINDER_MAX_DAYS_AFTER
 *              days ago. Then never again.
 * Skipped: anything but a confirmed/completed booking, a booking mid-
 * cancellation (cancel_state set), test-mode (livemode = false) rows, test
 * lots, and rows with no usable email.
 */

export const INITIAL_MAX_DAYS_AFTER = 2;
export const REMINDER_DAYS_AFTER = 3;
/** A reminder that missed its day by more than this is dropped, not sent late. */
export const REMINDER_MAX_DAYS_AFTER = 5;
export const REMINDER_MIN_HOURS_AFTER_INITIAL = 48;

/** bookings.status values for a stay that happened (migration 003). Cancelled,
 *  refunded, payment_failed and disputed are never asked for a review. */
export const REVIEWABLE_STATUSES: readonly string[] = ["confirmed", "completed"];

export type ReviewEmailKind = "initial" | "reminder";

export interface ReviewBookingRow {
  id: string;
  status: string;
  cancelState: string | null;
  /** Raw bookings.check_out as PostgREST returns it ("2026-10-08T10:00:00"). */
  checkOut: string;
  locationName: string;
  airportCode: string | null;
  reslabLocationId: number | null;
  directLotId: string | null;
  locationTimezone: string | null;
  /** NULL on pre-034 rows, which every reader treats as live. */
  livemode: boolean | null;
  email: string | null;
  firstName: string | null;
}

export interface ReviewLedgerRow {
  bookingId: string;
  kind: ReviewEmailKind;
  status: "claimed" | "retry" | "sent" | "failed";
  sentAt: string | null;
}

export interface ReviewCandidate {
  bookingId: string;
  kind: ReviewEmailKind;
  /** Lowercased + trimmed. */
  email: string;
  firstName: string | null;
  lotName: string;
  /** An airport we sell (in config/airports), else null — the legacy "RESLAB"
   *  placeholder and unknown codes never reach a link. */
  airportCode: string | null;
  /** Literal "YYYY-MM-DD" check-out date. */
  checkoutDate: string;
}

export interface ReviewSelection {
  initial: ReviewCandidate[];
  reminder: ReviewCandidate[];
  skipped: {
    notReviewable: number;
    cancelling: number;
    testMode: number;
    testLot: number;
    noEmail: number;
    invalidCheckout: number;
    notCheckedOut: number;
    tooOldForInitial: number;
    inFlight: number;
    failed: number;
    reviewed: number;
    alreadyReminded: number;
    reminderNotDue: number;
    tooOldForReminder: number;
    sameAddress: number;
  };
}

export interface SelectOptions {
  /** ResLab location ids of our own test lots (config/admin.ts). */
  testLocationIds?: ReadonlySet<number>;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** "2026-10-08T10:00:00" / "2026-10-08 10:00:00" → "2026-10-08 10:00", or null.
 *  String work only. */
export function checkoutWallClock(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/.exec(raw);
  return m ? `${m[1]} ${m[2]}` : null;
}

/** Whole calendar days from `from` to `to` (both "YYYY-MM-DD"). */
export function daysBetween(from: string, to: string): number {
  const a = DATE_RE.exec(from);
  const b = DATE_RE.exec(to);
  if (!a || !b) throw new Error(`daysBetween: not YYYY-MM-DD: ${from} / ${to}`);
  const ms =
    Date.UTC(Number(b[1]), Number(b[2]) - 1, Number(b[3])) -
    Date.UTC(Number(a[1]), Number(a[2]) - 1, Number(a[3]));
  return Math.round(ms / 86_400_000);
}

/** "Now" as a "YYYY-MM-DD HH:mm" wall clock in the zone where it is EARLIEST
 *  among every zone we serve — the conservative clock for an unknown lot. */
export function earliestLocalWallClock(nowMs: number): string {
  const zones = new Set(airports.map((a) => a.timezone).filter(isValidTimeZone));
  let earliest: string | null = null;
  for (const tz of zones) {
    const local = format(new TZDate(nowMs, tz), "yyyy-MM-dd HH:mm");
    if (earliest === null || local < earliest) earliest = local;
  }
  if (earliest === null) throw new Error("earliestLocalWallClock: no valid airport time zones configured");
  return earliest;
}

/** "Now" at the lot as "YYYY-MM-DD HH:mm". Only `nowMs` is projected. */
export function localWallClockAt(
  nowMs: number,
  locationTimezone: string | null,
  airportCode: string | null
): string {
  if (isValidTimeZone(locationTimezone)) return format(new TZDate(nowMs, locationTimezone), "yyyy-MM-dd HH:mm");
  const airportZone = airportCode ? getAirportByCode(airportCode)?.timezone : undefined;
  if (isValidTimeZone(airportZone)) return format(new TZDate(nowMs, airportZone), "yyyy-MM-dd HH:mm");
  return earliestLocalWallClock(nowMs);
}

/** An airport code we can link to, or null ("RESLAB", unknown, hidden). */
export function linkableAirportCode(code: string | null): string | null {
  if (!code) return null;
  const airport = getAirportByCode(code);
  return airport && airport.enabled && !airport.isTest ? airport.code : null;
}

export function selectReviewSends(
  bookings: readonly ReviewBookingRow[],
  ledger: readonly ReviewLedgerRow[],
  reviewedBookingIds: ReadonlySet<string>,
  nowMs: number,
  options: SelectOptions = {}
): ReviewSelection {
  const skipped: ReviewSelection["skipped"] = {
    notReviewable: 0,
    cancelling: 0,
    testMode: 0,
    testLot: 0,
    noEmail: 0,
    invalidCheckout: 0,
    notCheckedOut: 0,
    tooOldForInitial: 0,
    inFlight: 0,
    failed: 0,
    reviewed: 0,
    alreadyReminded: 0,
    reminderNotDue: 0,
    tooOldForReminder: 0,
    sameAddress: 0,
  };
  const testLots = options.testLocationIds ?? new Set<number>();
  const ledgerByKey = new Map<string, ReviewLedgerRow>();
  for (const r of ledger) ledgerByKey.set(`${r.bookingId}|${r.kind}`, r);

  const initial: ReviewCandidate[] = [];
  const reminder: ReviewCandidate[] = [];
  // One email per address per run: a customer with two trips ending together
  // gets the second on a later run (still inside the window), not two at once.
  const addressesThisRun = new Set<string>();

  // Oldest check-out first, so a batch cap defers the newest trips — they
  // have the most window left.
  const ordered = [...bookings].sort((a, b) => (a.checkOut < b.checkOut ? -1 : a.checkOut > b.checkOut ? 1 : 0));

  for (const b of ordered) {
    if (!REVIEWABLE_STATUSES.includes(b.status)) {
      skipped.notReviewable++;
      continue;
    }
    if (b.cancelState !== null) {
      skipped.cancelling++;
      continue;
    }
    if (b.livemode === false) {
      skipped.testMode++;
      continue;
    }
    if (b.reslabLocationId !== null && testLots.has(b.reslabLocationId)) {
      skipped.testLot++;
      continue;
    }
    const email = typeof b.email === "string" ? b.email.trim().toLowerCase() : "";
    if (!EMAIL_RE.test(email)) {
      skipped.noEmail++;
      continue;
    }
    const checkout = checkoutWallClock(b.checkOut);
    if (!checkout) {
      skipped.invalidCheckout++;
      continue;
    }
    const localNow = localWallClockAt(nowMs, b.locationTimezone, b.airportCode);
    if (checkout > localNow) {
      skipped.notCheckedOut++;
      continue;
    }
    if (reviewedBookingIds.has(b.id)) {
      skipped.reviewed++;
      continue;
    }

    const checkoutDate = checkout.slice(0, 10);
    const daysSince = daysBetween(checkoutDate, localNow.slice(0, 10));
    const candidate = (kind: ReviewEmailKind): ReviewCandidate => ({
      bookingId: b.id,
      kind,
      email,
      firstName: b.firstName?.trim() || null,
      lotName: b.locationName,
      airportCode: linkableAirportCode(b.airportCode),
      checkoutDate,
    });

    const first = ledgerByKey.get(`${b.id}|initial`);
    if (!first || first.status === "retry") {
      if (daysSince > INITIAL_MAX_DAYS_AFTER) {
        skipped.tooOldForInitial++;
        continue;
      }
      if (addressesThisRun.has(email)) {
        skipped.sameAddress++;
        continue;
      }
      addressesThisRun.add(email);
      initial.push(candidate("initial"));
      continue;
    }
    if (first.status === "claimed") {
      skipped.inFlight++;
      continue;
    }
    if (first.status === "failed") {
      // A permanently rejected address: never chase it with a reminder.
      skipped.failed++;
      continue;
    }

    // Initial is `sent` — consider the one reminder.
    const second = ledgerByKey.get(`${b.id}|reminder`);
    if (second && second.status !== "retry") {
      if (second.status === "claimed") skipped.inFlight++;
      else skipped.alreadyReminded++;
      continue;
    }
    if (daysSince > REMINDER_MAX_DAYS_AFTER) {
      skipped.tooOldForReminder++;
      continue;
    }
    const sentMs = first.sentAt ? Date.parse(first.sentAt) : Number.NaN;
    if (
      daysSince < REMINDER_DAYS_AFTER ||
      !Number.isFinite(sentMs) ||
      nowMs - sentMs < REMINDER_MIN_HOURS_AFTER_INITIAL * 3_600_000
    ) {
      skipped.reminderNotDue++;
      continue;
    }
    if (addressesThisRun.has(email)) {
      skipped.sameAddress++;
      continue;
    }
    addressesThisRun.add(email);
    reminder.push(candidate("reminder"));
  }

  return { initial, reminder, skipped };
}
