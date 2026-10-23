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

export interface BackfillSelection {
  /** Most recent check-out first — the freshest memories go out first under a cap. */
  candidates: ReviewCandidate[];
  skipped: {
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
  };
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
  const skipped: BackfillSelection["skipped"] = {
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
  };
  const testLots = options.testLocationIds ?? new Set<number>();
  const suppressed = options.suppressed ?? new Set<string>();
  const askedBookings = new Set(ledger.map((r) => r.bookingId));

  // Addresses already asked or already reviewed, from ANY of their bookings —
  // including ones that are not themselves reviewable today.
  const askedAddresses = new Set<string>();
  for (const b of bookings) {
    const email = normalizedEmail(b.email);
    if (email && (askedBookings.has(b.id) || reviewedBookingIds.has(b.id))) askedAddresses.add(email);
  }

  // Each address's most recent trip that actually happened.
  const latestByAddress = new Map<string, { b: ReviewBookingRow; checkout: string; localNow: string }>();
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
      continue;
    }
    const prev = latestByAddress.get(email);
    if (!prev) {
      latestByAddress.set(email, { b, checkout, localNow });
    } else {
      skipped.olderTripSameAddress++;
      if (checkout > prev.checkout) latestByAddress.set(email, { b, checkout, localNow });
    }
  }

  const candidates: ReviewCandidate[] = [];
  for (const [email, { b, checkout, localNow }] of latestByAddress) {
    if (suppressed.has(email)) {
      skipped.optedOut++;
      continue;
    }
    if (askedAddresses.has(email)) {
      skipped.alreadyAsked++;
      continue;
    }
    const checkoutDate = checkout.slice(0, 10);
    const daysSince = daysBetween(checkoutDate, localNow.slice(0, 10));
    if (daysSince < BACKFILL_MIN_DAYS_AFTER) {
      skipped.tooRecent++;
      continue;
    }
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
  return { candidates, skipped };
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
