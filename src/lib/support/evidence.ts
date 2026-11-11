/**
 * The support-ticket evidence record (/admin/support/[id]/evidence): a
 * printable page that shows when a customer contacted us and what they wrote,
 * next to the booking it is about. The team saves it as a PDF and attaches it
 * to a late-cancellation refund request (ResLab asks for proof once the
 * reservation start time has passed).
 *
 * Every line must be true for every ticket (docs/review-lessons.md #1): it
 * states only what the ticket and booking rows hold, and says "not recorded"
 * rather than guessing.
 */

/** The booking columns the evidence page reads (bookings table). */
export const EVIDENCE_BOOKING_COLUMNS =
  "id, reslab_reservation_number, status, check_in, check_out, location_timezone, location_name, location_address, airport_code, created_at, cancellation_reason, cancelled_by, cancel_state, cancel_claimed_at, inventory_source";

export interface EvidenceBooking {
  id: string;
  reslab_reservation_number: string | null;
  status: string | null;
  /** tz-less airport-local wall clock, e.g. "2026-11-11 07:00:00". */
  check_in: string | null;
  check_out: string | null;
  location_timezone: string | null;
  location_name: string | null;
  location_address: string | null;
  airport_code: string | null;
  created_at: string | null;
  cancellation_reason: string | null;
  cancelled_by: string | null;
  /** Non-null = a cancellation was started (migration 017). */
  cancel_state: string | null;
  /** When the cancellation was started. Kept after it completes. */
  cancel_claimed_at: string | null;
  inventory_source: string | null;
}

/** Shown when a ticket has no stored zone to read times in. */
export const FALLBACK_TIMEZONE = "America/New_York";

function validZone(tz: string | null | undefined): string | null {
  if (!tz) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
}

/**
 * A real instant (a timestamptz like ticket.created_at) shown as the wall
 * clock in `tz`, with the zone named: "Nov 11, 2026, 3:42 PM EST". This
 * converts an instant INTO a zone; it never reinterprets an airport-local
 * booking time (those go through formatLiteralDateTime untouched).
 */
export function formatInstant(iso: string | null | undefined, tz: string | null | undefined): string {
  if (!iso) return "not recorded";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "not recorded";
  return d.toLocaleString("en-US", {
    timeZone: validZone(tz) ?? FALLBACK_TIMEZONE,
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

/** The same instant in UTC, ISO 8601 — unambiguous for whoever reads the file. */
export function formatInstantUtc(iso: string | null | undefined): string {
  if (!iso) return "not recorded";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "not recorded" : `${d.toISOString().replace(/\.\d{3}Z$/, "Z")} (UTC)`;
}

export type EvidenceBookingMatch = "matched" | "email_mismatch" | "not_found" | "lookup_failed" | "none";

/** What the ticket's booking_match proves, and nothing more. */
export const MATCH_STATEMENT: Record<EvidenceBookingMatch, string> = {
  matched: "Reservation found, and the email on the reservation is the same email that sent this request.",
  email_mismatch: "Reservation found, but it is under a different email than the one that sent this request.",
  not_found: "No reservation with this number was found.",
  lookup_failed: "The reservation number was given but could not be checked when the request arrived.",
  none: "No reservation number was given.",
};

export const BOOKING_STATUS_LABEL: Record<string, string> = {
  confirmed: "Confirmed",
  pending: "Pending",
  cancelled: "Cancelled",
  canceled: "Cancelled",
  refunded: "Cancelled and refunded",
  completed: "Completed",
};

export function bookingStatusLabel(b: Pick<EvidenceBooking, "status" | "cancel_state">): string {
  const base = b.status ? (BOOKING_STATUS_LABEL[b.status] ?? b.status) : "not recorded";
  // A cancellation can be in progress while the status still reads confirmed.
  if (b.cancel_state && (b.status === "confirmed" || b.status === "pending")) return `${base} (cancellation in progress)`;
  return base;
}

/** The zone the booking's times are in, for the page to name. */
export function evidenceZone(b: Pick<EvidenceBooking, "location_timezone"> | null): string {
  return validZone(b?.location_timezone) ?? FALLBACK_TIMEZONE;
}
