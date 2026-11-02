import {
  REVIEWABLE_STATUSES,
  REMINDER_MAX_DAYS_AFTER,
  checkoutWallClock,
  daysBetween,
  linkableAirportCode,
  localWallClockAt,
  type ReviewBookingRow,
  type ReviewCandidate,
  type ReviewLedgerRow,
  type SelectOptions,
} from "./select";

/**
 * Picks the past customers for the ONE-TIME review ask ("backfill") — PURE
 * (no I/O), like selectReviewSends. Run by hand through
 * /api/cron/post-trip-review?backfill=preview|send, never on the schedule.
 *
 * Who is asked: one email per ADDRESS, about that address's most recent
 * reviewable trip, when that trip's check-out (airport-local, same time rule
 * as select.ts) is BACKFILL_MIN_DAYS_AFTER..BACKFILL_MAX_DAYS_AFTER days ago.
 * The floor sits past the regular reminder window, so the daily cron and the
 * backfill never compete for the same trip.
 *
 * Asked at most once, ever: an address is skipped outright when ANY of its
 * bookings already has a review_emails row (initial, reminder or backfill, in
 * any status — an 'unconfirmed' send may be out) or a review. So a customer who
 * got the regular post-trip email last week is not asked about an older trip,
 * and a second backfill run never re-asks anyone.
 *
 * The same skips as the daily email apply to the chosen trip: anything but a
 * confirmed/completed booking, a booking mid-cancellation, the other mode's
 * rows (shared staging/production database), test lots, no usable email, and
 * opted-out addresses.
 *
 * `bookings` must hold every booking the address could have — the route reads
 * the whole lookback window (plus recent trips) so "most recent trip" and
 * "already asked" are judged on the full picture, not a page of it.
 */

/** First day after the regular reminder window closes. */
export const BACKFILL_MIN_DAYS_AFTER = REMINDER_MAX_DAYS_AFTER + 1;
/** Older trips are not asked: memory of the lot fades, and so does consent to hear from us. */
export const BACKFILL_MAX_DAYS_AFTER = 365;

export type BackfillSkipped = {
  notReviewable: number;
  cancelling: number;
  otherMode: number;
  testLot: number;
  noEmail: number;
  invalidCheckout: number;
  notCheckedOut: number;
  optedOut: number;
  /** The address already had a review email of any kind, or left a review. */
  alreadyAsked: number;
  /** The address's most recent trip is still inside the daily email's windows. */
  tooRecent: number;
  tooOld: number;
  /** Older trips of an address whose most recent trip was the one considered. */
  olderTripSameAddress: number;
  /** The address has a trip that has not checked out yet: the daily email will
   *  ask about THAT one, so the backfill stays silent ("We'll only ask once"). */
  upcomingTrip: number;
  /** A backfill row parked in `retry` that can no longer be re-sent: its trip
   *  is now older than a year, or its booking is outside the read. The row
   *  stays parked; the route alarms with the ids (`expiredRetries`). */
  retryExpired: number;
};

export interface BackfillSelection {
  /** Most recent check-out first — the freshest memories go out first under a
   *  cap. A backfill email parked in `retry` (a Resend 429, a stopped run) is
   *  re-emitted for ITS booking ahead of everyone, so a transient failure never
   *  drops a customer for good (the claim re-uses the row). */
  candidates: ReviewCandidate[];
  /** How many of `candidates` are those re-emitted `retry` rows. */
  retrying: number;
  /** Booking ids of parked `retry` rows that will never be re-sent (see skipped.retryExpired). */
  expiredRetries: string[];
  skipped: BackfillSkipped;
}

export interface BackfillOptions extends SelectOptions {
  /** "YYYY-MM-DD" the campaign starts; review links expire relative to it, not to the trip. */
  campaignDate: string;
}

export function selectBackfillSends(
  bookings: readonly ReviewBookingRow[],
  ledger: readonly ReviewLedgerRow[],
  reviewedBookingIds: ReadonlySet<string>,
  nowMs: number,
  options: BackfillOptions
): BackfillSelection {
  const skipped: BackfillSkipped = {
    notReviewable: 0,
    cancelling: 0,
    otherMode: 0,
    testLot: 0,
    noEmail: 0,
    invalidCheckout: 0,
    notCheckedOut: 0,
    optedOut: 0,
    alreadyAsked: 0,
    tooRecent: 0,
    tooOld: 0,
    olderTripSameAddress: 0,
    upcomingTrip: 0,
    retryExpired: 0,
  };
  const expiredRetries: string[] = [];
  const testLots = options.testLocationIds ?? new Set<number>();
  const suppressed = options.suppressed ?? new Set<string>();

  // A backfill row parked in `retry` was claimed but never delivered: not an
  // ask. Its booking is re-emitted below (the route's claim re-uses the row).
  // The ledger is the whole SHARED table: a parked row of the other mode
  // (a staging test, seen from production or the reverse) is nobody's to
  // re-send or alarm here — ignored. Delivered rows of either mode still
  // count as asked (conservative).
  const otherModeRetry = (r: ReviewLedgerRow) =>
    r.status === "retry" && r.livemode !== undefined && r.livemode !== null && r.livemode !== options.live;
  const ledgerInMode = ledger.filter((r) => !otherModeRetry(r));
  const retryBookingIds = new Set(ledgerInMode.filter((r) => r.kind === "backfill" && r.status === "retry").map((r) => r.bookingId));
  const askedBookings = new Set(ledgerInMode.filter((r) => !retryBookingIds.has(r.bookingId)).map((r) => r.bookingId));

  // Addresses already asked or already reviewed. The ledger carries the
  // recipient, so an ask on a booking the candidate read never saw (older than
  // the window, since refunded or disputed) still counts; booking ids cover
  // rows without one (older fixtures) and the reviews, which only ever follow
  // an ask.
  const askedAddresses = new Set<string>();
  for (const r of ledgerInMode) {
    const email = normalizedEmail(r.email ?? null);
    if (email && !retryBookingIds.has(r.bookingId)) askedAddresses.add(email);
  }
  for (const b of bookings) {
    const email = normalizedEmail(b.email);
    if (email && (askedBookings.has(b.id) || reviewedBookingIds.has(b.id))) askedAddresses.add(email);
  }

  // Each address's most recent trip that actually happened; addresses with a
  // trip still ahead (the daily email's job) are held back entirely.
  const upcomingAddresses = new Set<string>();
  const latestByAddress = new Map<string, { b: ReviewBookingRow; checkout: string; localNow: string }>();
  const retryByAddress = new Map<string, { b: ReviewBookingRow; checkout: string; localNow: string }>();
  for (const b of bookings) {
    if (!REVIEWABLE_STATUSES.includes(b.status)) {
      skipped.notReviewable++;
      continue;
    }
    if (b.cancelState !== null) {
      skipped.cancelling++;
      continue;
    }
    if ((b.livemode !== false) !== options.live) {
      skipped.otherMode++;
      continue;
    }
    if (b.reslabLocationId !== null && testLots.has(b.reslabLocationId)) {
      skipped.testLot++;
      continue;
    }
    const email = normalizedEmail(b.email);
    if (!email) {
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
      upcomingAddresses.add(email);
      continue;
    }
    if (retryBookingIds.has(b.id)) retryByAddress.set(email, { b, checkout, localNow });
    const prev = latestByAddress.get(email);
    if (!prev) {
      latestByAddress.set(email, { b, checkout, localNow });
    } else {
      skipped.olderTripSameAddress++;
      if (checkout > prev.checkout) latestByAddress.set(email, { b, checkout, localNow });
    }
  }

  // A parked retry whose booking the read no longer holds (older than the
  // window): nothing can re-send it; say so rather than lose it quietly.
  const loadedIds = new Set(bookings.map((b) => b.id));
  for (const id of retryBookingIds) {
    if (!loadedIds.has(id)) {
      skipped.retryExpired++;
      expiredRetries.push(id);
    }
  }

  const candidates: ReviewCandidate[] = [];
  const retries: ReviewCandidate[] = [];
  for (const [email, latest] of latestByAddress) {
    if (suppressed.has(email)) {
      skipped.optedOut++;
      continue;
    }
    if (askedAddresses.has(email)) {
      skipped.alreadyAsked++;
      continue;
    }
    if (upcomingAddresses.has(email)) {
      // Also holds a parked retry: the daily email will ask about the trip
      // ahead, and that ask then counts as this address's one ask.
      skipped.upcomingTrip++;
      continue;
    }
    const latestDaysSince = daysBetween(latest.checkout.slice(0, 10), latest.localNow.slice(0, 10));
    if (latestDaysSince < BACKFILL_MIN_DAYS_AFTER) {
      // Still inside the daily email's windows — also holds a parked retry,
      // which would otherwise land days before the daily email for this trip.
      skipped.tooRecent++;
      continue;
    }
    const retry = retryByAddress.get(email);
    if (retry) {
      if (daysBetween(retry.checkout.slice(0, 10), retry.localNow.slice(0, 10)) > BACKFILL_MAX_DAYS_AFTER) {
        skipped.retryExpired++; // parked too long; the row stays parked, never re-sent
        expiredRetries.push(retry.b.id);
        continue;
      }
      // The row already names this booking; the ask must be about the same trip.
      retries.push({
        bookingId: retry.b.id,
        kind: "backfill",
        email,
        firstName: retry.b.firstName?.trim() || null,
        lotName: retry.b.locationName,
        airportCode: linkableAirportCode(retry.b.airportCode),
        checkoutDate: retry.checkout.slice(0, 10),
        linkFromDate: options.campaignDate,
      });
      continue;
    }
    const { b, checkout } = latest;
    const checkoutDate = checkout.slice(0, 10);
    const daysSince = latestDaysSince;
    if (daysSince > BACKFILL_MAX_DAYS_AFTER) {
      skipped.tooOld++;
      continue;
    }
    candidates.push({
      bookingId: b.id,
      kind: "backfill",
      email,
      firstName: b.firstName?.trim() || null,
      lotName: b.locationName,
      airportCode: linkableAirportCode(b.airportCode),
      checkoutDate,
      linkFromDate: options.campaignDate,
    });
  }
  candidates.sort((x, y) => (x.checkoutDate > y.checkoutDate ? -1 : x.checkoutDate < y.checkoutDate ? 1 : 0));
  return { candidates: [...retries, ...candidates], retrying: retries.length, expiredRetries, skipped };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizedEmail(raw: string | null): string | null {
  const email = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return EMAIL_RE.test(email) ? email : null;
}

/** Preview counts for planning: how many would be asked, by airport and by check-out month. */
export function summarizeBackfill(candidates: readonly ReviewCandidate[]): {
  total: number;
  byAirport: Record<string, number>;
  byCheckoutMonth: Record<string, number>;
  byLot: Array<{ lot: string; count: number }>;
} {
  const byAirport: Record<string, number> = {};
  const byCheckoutMonth: Record<string, number> = {};
  const lots = new Map<string, number>();
  for (const c of candidates) {
    const airport = c.airportCode ?? "unknown";
    byAirport[airport] = (byAirport[airport] ?? 0) + 1;
    const month = c.checkoutDate.slice(0, 7);
    byCheckoutMonth[month] = (byCheckoutMonth[month] ?? 0) + 1;
    lots.set(c.lotName, (lots.get(c.lotName) ?? 0) + 1);
  }
  const byLot = [...lots.entries()]
    .map(([lot, count]) => ({ lot, count }))
    .sort((a, b) => b.count - a.count || a.lot.localeCompare(b.lot));
  return { total: candidates.length, byAirport, byCheckoutMonth, byLot };
}
