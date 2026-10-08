import type Stripe from "stripe";
import { z } from "zod";
import { format } from "date-fns";
import { TZDate } from "@date-fns/tz";
import { airports } from "@/config/airports";
import { convertTo24Hour } from "@/lib/utils/time";

/**
 * Picks the abandoned checkouts the recovery cron may email — PURE (no I/O),
 * so every rule here is unit-testable without Stripe or Supabase.
 *
 * "Abandoned" = a PaymentIntent created by POST /api/checkout/lot that is still
 * in `requires_payment_method`: the customer reached the payment step and never
 * got a card through. The PaymentIntent is the ONLY durable record of that
 * moment — pending_bookings is staged only when Pay Now is clicked (see
 * /api/reservations/pending), so a customer who never clicked it has no row.
 *
 * THE TRIP, NOT THE EMAIL, decides "already handled" (review of PR #44,
 * 2026-10-07). checkout-form.tsx mints a NEW PaymentIntent every time the
 * customer re-enters the payment step (Back button, reopening the URL to check
 * it went through, fixing a typo in the email), so an abandoned PaymentIntent
 * routinely sits next to a paid one for the SAME trip — created earlier or
 * later, under the same or a different email. An email keyed on "same address,
 * paid afterwards" told paying customers "nothing is reserved" and sent trip
 * details to mistyped addresses. So: any other PaymentIntent for the same trip
 * fingerprint (lot + dates + times) that is NOT itself sitting at
 * requires_payment_method — paid, authorised, mid-3DS, or cancelled by our
 * own fulfilment — means this trip was attempted and must not be chased, and
 * only the NEWEST PaymentIntent of a chain (same trip or same address, any
 * status, any age) is ever eligible. The cron adds the same fingerprint check
 * against bookings and pending_bookings.
 */

/** Old enough that the customer has plainly stopped (not mid-typing a card). */
export const RECOVERY_MIN_AGE_MS = 45 * 60_000;
/** Past a day the trip may already be booked elsewhere; one email, early. */
export const RECOVERY_MAX_AGE_MS = 24 * 60 * 60_000;
/** Never email about a check-in that starts within this long. A floor: the
 *  cron also applies the lot's own `hours_before_reservation` when it can
 *  resolve the lot. */
export const RECOVERY_MIN_LEAD_MS = 60 * 60_000;

/** The only status that means "reached payment, never got a card through". */
export const ABANDONED_STATUS: Stripe.PaymentIntent.Status = "requires_payment_method";

/** A PaymentIntent in any of these has money behind it (authorized, captured
 *  or settling) — i.e. the customer DID pay. Manual capture puts cards in
 *  `requires_capture`, so `succeeded` alone would miss most bookings. */
export const PAID_STATUSES: ReadonlySet<Stripe.PaymentIntent.Status> = new Set([
  "succeeded",
  "requires_capture",
  "processing",
]);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{1,2}:\d{2}\s[AP]M$/;

/** The fields that identify a TRIP. Any PaymentIntent carrying them can be
 *  fingerprinted, whatever its status or email. */
export const tripSchema = z.object({
  lotId: z.string().min(1),
  checkin: z.string().regex(DATE_RE),
  checkout: z.string().regex(DATE_RE),
  checkinTime: z.string().regex(TIME_RE),
  checkoutTime: z.string().regex(TIME_RE),
});

/** What /api/checkout/lot stamps on every PaymentIntent. Validated, never
 *  defaulted: a PaymentIntent missing any of these is skipped, not guessed. */
export const recoveryMetadataSchema = tripSchema.extend({
  customerEmail: z.string().trim().toLowerCase().pipe(z.string().email()),
  locationId: z.string().regex(/^\d+$/).transform(Number),
});

export function tripFingerprint(t: z.infer<typeof tripSchema>): string {
  return `${t.lotId}|${t.checkin} ${t.checkinTime}|${t.checkout} ${t.checkoutTime}`;
}

/** Fingerprint from raw PaymentIntent metadata, or null when it cannot be read. */
export function tripFingerprintOf(metadata: Stripe.Metadata | null | undefined): string | null {
  const parsed = tripSchema.safeParse(metadata ?? {});
  return parsed.success ? tripFingerprint(parsed.data) : null;
}

/** The literal "YYYY-MM-DD HH:mm:ss" string bookings / pending_bookings store
 *  for a date + "h:mm AM" pair — built by string formatting, never Date math. */
export function literalWallClock(date: string, time12h: string): string {
  return `${date} ${convertTo24Hour(time12h)}:00`;
}

export type PaymentIntentLike = Pick<
  Stripe.PaymentIntent,
  "id" | "status" | "created" | "amount" | "livemode" | "metadata"
>;

export interface RecoveryCandidate {
  paymentIntentId: string;
  /** Lowercased + trimmed. */
  email: string;
  createdMs: number;
  amountCents: number;
  livemode: boolean;
  lotId: string;
  locationId: number;
  /** Literal airport-local strings exactly as the customer picked them. */
  checkin: string;
  checkout: string;
  checkinTime: string;
  checkoutTime: string;
  /** lot + dates + times — what "the same trip" means everywhere in this feature. */
  trip: string;
  /** The literal wall-clock strings bookings.check_in/check_out and
   *  pending_bookings.from_date/to_date hold for this trip. */
  fromDate: string;
  toDate: string;
  /** The same trip as the database stores it — see storedTripKey. */
  storedTrip: string;
}

/**
 * The trip as bookings / pending_bookings identify it: ResLab location +
 * the two literal wall-clock strings. PostgREST returns a TIMESTAMP column as
 * "2026-10-17T10:00:00" and the TEXT columns hold "2026-10-17 10:00:00";
 * normalising the separator (and dropping any fractional part) makes the two
 * comparable — still string work, never a Date.
 */
export function storedTripKey(locationId: number | string, checkIn: unknown, checkOut: unknown): string | null {
  const norm = (v: unknown): string | null => {
    if (typeof v !== "string" || v.length < 19) return null;
    return v.slice(0, 19).replace("T", " ");
  };
  const from = norm(checkIn);
  const to = norm(checkOut);
  if (from === null || to === null) return null;
  return `${Number(locationId)}|${from}|${to}`;
}

export interface SelectionResult {
  candidates: RecoveryCandidate[];
  skipped: {
    tooYoung: number;
    tooOld: number;
    invalidMetadata: number;
    blockedLot: number;
    /** `direct-*` lots cannot be booked yet (DIRECT_BOOKING_OPEN); never
     *  invite anyone back to a checkout that refuses them. */
    directLot: number;
    checkinPassed: number;
    paidSince: number;
    /** Another PaymentIntent for the same trip was paid, authorised, mid-3DS
     *  or cancelled by fulfilment — by anyone, before or after this one. */
    tripAttempted: number;
    /** A NEWER PaymentIntent exists for the same trip or the same address,
     *  in any status and at any age: the customer moved on from this one
     *  (fixed the email, changed the dates, is back on the checkout right
     *  now). Only the newest attempt in a chain can ever be emailed, and
     *  only once it is itself old enough. */
    superseded: number;
  };
}

/**
 * The latest airport-local wall clock across every timezone we serve, as
 * "YYYY-MM-DD HH:mm". The lot's own airport is not known until a ResLab
 * lookup, so the check-in gate uses the timezone where it is LATEST — for a
 * west-coast lot that errs toward not emailing a few hours early, never toward
 * emailing after check-in. Only "now" is projected into a timezone; the
 * booking's check-in string is compared as the literal it is.
 */
export function latestLocalWallClock(nowMs: number): string {
  const zones = new Set(airports.map((a) => a.timezone).filter(Boolean));
  let latest = "";
  for (const tz of zones) {
    const local = format(new TZDate(nowMs, tz), "yyyy-MM-dd HH:mm");
    if (local > latest) latest = local;
  }
  return latest;
}

export interface SelectionOptions {
  /** ResLab locations hidden from the site (BLOCKED_RESLAB_LOCATION_IDS):
   *  never invite anyone back to a lot we have deliberately pulled. */
  blockedLocationIds?: ReadonlySet<number>;
}

export function selectRecoveryCandidates(
  paymentIntents: readonly PaymentIntentLike[],
  nowMs: number,
  options: SelectionOptions = {}
): SelectionResult {
  const skipped: SelectionResult["skipped"] = {
    tooYoung: 0,
    tooOld: 0,
    invalidMetadata: 0,
    blockedLot: 0,
    directLot: 0,
    checkinPassed: 0,
    paidSince: 0,
    tripAttempted: 0,
    superseded: 0,
  };
  const blocked = options.blockedLocationIds ?? new Set<number>();

  // Latest creation time of a PAID PaymentIntent per (lowercased) email.
  const paidAt = new Map<string, number>();
  // Every trip some PaymentIntent got PAST the payment form on — whatever the
  // email, whenever it was created. An abandoned attempt at one of these is
  // a re-entry (Back, reload, email fix, 3DS retry), not an abandonment.
  const attemptedTrips = new Set<string>();
  // The newest PaymentIntent per trip and per address, ANY status, ANY age
  // (a too-young one counts: the customer is on the checkout right now).
  // Ties on the same second go to the later list position, which Stripe
  // returns newest-first — so the earlier element wins.
  const newestByTrip = new Map<string, { createdMs: number; id: string }>();
  const newestByEmail = new Map<string, { createdMs: number; id: string }>();
  const noteNewest = (map: Map<string, { createdMs: number; id: string }>, key: string, pi: PaymentIntentLike) => {
    const createdMs = pi.created * 1000;
    const cur = map.get(key);
    if (!cur || cur.createdMs < createdMs) map.set(key, { createdMs, id: pi.id });
  };
  for (const pi of paymentIntents) {
    const trip = tripFingerprintOf(pi.metadata);
    if (trip) noteNewest(newestByTrip, trip, pi);
    const raw = pi.metadata?.customerEmail;
    const email = raw ? raw.trim().toLowerCase() : null;
    if (email) noteNewest(newestByEmail, email, pi);

    if (pi.status === ABANDONED_STATUS) continue;
    if (trip) attemptedTrips.add(trip);
    if (!PAID_STATUSES.has(pi.status) || !email) continue;
    const createdMs = pi.created * 1000;
    if ((paidAt.get(email) ?? 0) < createdMs) paidAt.set(email, createdMs);
  }

  const cutoffWallClock = latestLocalWallClock(nowMs + RECOVERY_MIN_LEAD_MS);
  const byEmail = new Map<string, RecoveryCandidate>();

  for (const pi of paymentIntents) {
    if (pi.status !== ABANDONED_STATUS) continue;
    const createdMs = pi.created * 1000;
    const age = nowMs - createdMs;
    if (age < RECOVERY_MIN_AGE_MS) {
      skipped.tooYoung++;
      continue;
    }
    if (age > RECOVERY_MAX_AGE_MS) {
      skipped.tooOld++;
      continue;
    }

    const parsed = recoveryMetadataSchema.safeParse(pi.metadata ?? {});
    if (!parsed.success) {
      skipped.invalidMetadata++;
      continue;
    }
    const m = parsed.data;

    if (blocked.has(m.locationId)) {
      skipped.blockedLot++;
      continue;
    }
    // DIRECT_LOT_ID_PREFIX (src/lib/direct/store.ts) — spelled out so this
    // pure module does not import the store and its Supabase client.
    if (m.lotId.startsWith("direct-")) {
      skipped.directLot++;
      continue;
    }

    // String comparison of two "YYYY-MM-DD HH:mm" wall clocks — no Date math
    // on the booking time.
    const checkinWallClock = `${m.checkin} ${convertTo24Hour(m.checkinTime)}`;
    if (checkinWallClock <= cutoffWallClock) {
      skipped.checkinPassed++;
      continue;
    }

    // Paid on a PaymentIntent created at/after this one — the usual "declined,
    // tried again" or "came back and finished" shape, same address.
    const paid = paidAt.get(m.customerEmail);
    if (paid !== undefined && paid >= createdMs) {
      skipped.paidSince++;
      continue;
    }

    // The same trip got past the payment form on another PaymentIntent — any
    // address, any order. This is what catches "paid, then pressed Back",
    // "fixed the email, then paid", and "mid-3DS on the retry".
    const trip = tripFingerprint(m);
    if (attemptedTrips.has(trip)) {
      skipped.tripAttempted++;
      continue;
    }

    // Not the newest attempt for this trip or this address → the customer
    // moved on (typo'd address fixed and abandoned again; same trip re-entered
    // ten minutes ago and still open). The newest one is judged on its own
    // — and emailed, if at all, only once IT is 45 min old. This is also what
    // keeps a mistyped address from ever receiving the trip details.
    if (newestByTrip.get(trip)?.id !== pi.id || newestByEmail.get(m.customerEmail)?.id !== pi.id) {
      skipped.superseded++;
      continue;
    }

    const candidate: RecoveryCandidate = {
      paymentIntentId: pi.id,
      email: m.customerEmail,
      createdMs,
      amountCents: pi.amount,
      livemode: pi.livemode,
      lotId: m.lotId,
      locationId: m.locationId,
      checkin: m.checkin,
      checkout: m.checkout,
      checkinTime: m.checkinTime,
      checkoutTime: m.checkoutTime,
      trip,
      fromDate: literalWallClock(m.checkin, m.checkinTime),
      toDate: literalWallClock(m.checkout, m.checkoutTime),
      storedTrip: `${m.locationId}|${literalWallClock(m.checkin, m.checkinTime)}|${literalWallClock(m.checkout, m.checkoutTime)}`,
    };

    // The newest-per-address rule above already leaves at most one candidate
    // per address; the map is the invariant's guard, not a second dedupe.
    const existing = byEmail.get(m.customerEmail);
    if (existing && existing.createdMs >= createdMs) continue;
    byEmail.set(m.customerEmail, candidate);
  }

  const candidates = [...byEmail.values()].sort((a, b) => a.createdMs - b.createdMs);
  return { candidates, skipped };
}
