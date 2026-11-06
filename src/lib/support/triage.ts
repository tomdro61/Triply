import { checkInInstantMs, isCancellable } from "@/lib/cancellation/eligibility";
import type { ContactSubject } from "@/lib/validation/schemas";

/**
 * Rule-based triage for /contact submissions — no AI, no network. Decides the
 * ticket's priority, why, and which instant reply the customer gets. Pure, so
 * every rule is pinned by triage.test.ts.
 */

export type Priority = "urgent" | "high" | "normal";

export type BookingMatch = "matched" | "email_mismatch" | "not_found" | "lookup_failed" | "none";

/** Booking statuses where the money has gone back / the reservation no longer stands. */
export function isCancelledStatus(status: string | null): boolean {
  return status === "cancelled" || status === "refunded";
}

export type ReplyKind =
  | "self_cancel" // cancellable now, self-serve is on → send them to do it themselves
  | "already_cancelled"
  | "cancel_support" // inside 24h, or self-serve off → the team handles it
  | "change" // date/time/vehicle change → team, with the self-serve route if it applies
  | "at_lot" // on the trip right now / problem at the lot → lot facts + "team alerted"
  | "booking_details" // general booking help with a matched booking → the facts
  | "payment"
  | "partner"
  | "generic";

/** The booking facts triage and the reply need. Wall-clock strings, never Dates. */
export interface MatchedBooking {
  id: string;
  reservationNumber: string;
  /** As stored; NULL is passed through (never treated as "confirmed"). */
  status: string | null;
  /** tz-less airport-local wall clock, e.g. "2026-11-11 07:00:00". */
  checkIn: string;
  checkOut: string;
  timezone: string | null;
  locationName: string;
  locationAddress: string | null;
  airportCode: string | null;
}

export type TripPhase = "future" | "within_24h" | "active" | "past" | "unknown";

export interface TriageInput {
  subject: ContactSubject;
  message: string;
  booking: MatchedBooking | null;
  selfCancelEnabled: boolean;
  now?: number;
}

export interface TriageResult {
  priority: Priority;
  reasons: string[];
  replyKind: ReplyKind;
  tripPhase: TripPhase;
}

const HOUR = 60 * 60 * 1000;
/** A problem raised this soon after check-out still counts as "on the trip" (e.g. waiting for the return shuttle). */
const ACTIVE_GRACE_AFTER_CHECKOUT_MS = 6 * HOUR;

/**
 * Words that make a ticket urgent whatever the dates: money taken wrongly, a
 * car at risk, a customer stuck. Word-bounded and case-insensitive.
 */
const STRONG_URGENT: Array<[RegExp, string]> = [
  [/\bstranded\b/i, "stranded"],
  [/\btow(ed|ing)?\b/i, "towing"],
  [/\bstolen\b/i, "stolen"],
  [/\baccident\b/i, "accident"],
  [/\bpolice\b/i, "police"],
  [/\bdamag(e|ed|es|ing)\b/i, "damage"],
  [/\bcharged\s+(me\s+)?twice\b|\bdouble[\s-]?charged?\b/i, "double charge"],
  [/\bfraud(ulent)?\b|\bunauthori[sz]ed\b/i, "fraud"],
];

/**
 * Words that point at a problem happening at the lot. They raise a ticket to
 * "high" on their own; when the trip is on (or within 24h) it is urgent anyway.
 */
const AT_LOT_SIGNALS: Array<[RegExp, string]> = [
  [/\bshuttle\b/i, "shuttle"],
  [/\bcan'?t\s+find\b|\bcannot\s+find\b|\bcan not\s+find\b/i, "can't find lot"],
  [/\b(lot|gate|office)\s+(is|was)\s+(closed|locked)\b/i, "lot closed"],
  [/\bno\s?one\s+(is\s+)?(here|there|answer(ing|s)?)\b/i, "nobody at lot"],
  [/\bturned\s+(me\s+|us\s+)?away\b|\brefused\b/i, "turned away"],
  [/\b(lot|they)\s+(is|are|was|were)\s+full\b/i, "lot full"],
];

/** Upper-case, no spaces or "#": "trp 12-34" → "TRP12-34". null when nothing usable remains. */
export function normalizeReservationNumber(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const n = raw.replace(/[\s#]/g, "").toUpperCase();
  return /^[A-Z0-9-]{3,40}$/.test(n) ? n : null;
}

/** Where the customer is in the trip, from the booking's airport-local times. Unknown fails safe (no false "past"). */
export function tripPhase(booking: MatchedBooking, now: number): TripPhase {
  const inMs = checkInInstantMs(booking.checkIn, booking.timezone);
  const outMs = checkInInstantMs(booking.checkOut, booking.timezone);
  if (inMs === null || outMs === null) return "unknown";
  if (now < inMs - 24 * HOUR) return "future";
  if (now < inMs) return "within_24h";
  if (now <= outMs + ACTIVE_GRACE_AFTER_CHECKOUT_MS) return "active";
  return "past";
}

function matches(list: Array<[RegExp, string]>, text: string): string[] {
  return list.filter(([re]) => re.test(text)).map(([, label]) => label);
}

export function triage(input: TriageInput): TriageResult {
  const now = input.now ?? Date.now();
  const { subject, booking } = input;
  const text = input.message;
  const reasons: string[] = [];
  let priority: Priority = "normal";
  const raise = (to: Priority, reason: string) => {
    reasons.push(reason);
    if (to === "urgent" || (to === "high" && priority === "normal")) priority = to;
  };

  const live = booking !== null && booking.status === "confirmed";
  const phase: TripPhase = booking ? tripPhase(booking, now) : "unknown";
  const onTrip = live && (phase === "active" || phase === "within_24h");

  // --- priority -------------------------------------------------------------
  if (subject !== "Partnership Inquiry") {
    if (onTrip) raise("urgent", phase === "active" ? "trip in progress" : "check-in within 24h");
    if (subject === "Problem at the Lot") raise("urgent", "problem at the lot");
    for (const label of matches(STRONG_URGENT, text)) raise("urgent", label);
    for (const label of matches(AT_LOT_SIGNALS, text)) raise("high", label);
    if (subject === "Payment Issue") raise("high", "payment issue");
  }

  // --- the instant reply ------------------------------------------------------
  let replyKind: ReplyKind;
  switch (subject) {
    case "Partnership Inquiry":
      replyKind = "partner";
      break;
    case "Problem at the Lot":
      replyKind = "at_lot";
      break;
    case "Cancellation Request":
      if (booking && isCancelledStatus(booking.status)) {
        replyKind = "already_cancelled";
        // `cancelled` (not `refunded`) means no refund went through — the
        // reply says we'll check the payment; someone has to.
        if (booking.status !== "refunded") raise("high", "cancelled with no recorded refund");
      } else if (canSelfCancel(booking, input.selfCancelEnabled, now)) replyKind = "self_cancel";
      else {
        replyKind = "cancel_support";
        if (live) raise("high", "cancellation the customer can't do themselves");
      }
      break;
    case "Change My Reservation":
      replyKind = "change";
      break;
    case "Payment Issue":
      replyKind = "payment";
      break;
    default:
      replyKind = onTrip ? "at_lot" : booking ? "booking_details" : "generic";
  }
  // A customer at the lot gets the lot facts first, whatever they picked —
  // except a cancellation, which has its own answer.
  if (onTrip && (replyKind === "booking_details" || replyKind === "generic")) replyKind = "at_lot";

  return { priority, reasons: [...new Set(reasons)], replyKind, tripPhase: phase };
}

/** Self-cancel is on AND this booking passes the 24h gate right now. Same rule /api/user/bookings uses. */
export function canSelfCancel(booking: MatchedBooking | null, selfCancelEnabled: boolean, now = Date.now()): boolean {
  return (
    selfCancelEnabled &&
    booking !== null &&
    booking.status === "confirmed" &&
    isCancellable(booking.checkIn, booking.timezone, now).cancellable
  );
}
