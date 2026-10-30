/**
 * Every customer-facing refundability string for the room leg, in one place
 * (the PG_*_SUMMARY pattern). Results card, hotel page, order summary, Pay Now
 * copy, confirmation and emails all render from here so the wording can never
 * disagree across surfaces (plan §1, §9 gate 6: refundability accuracy on
 * every surface is an FTC 16 CFR 464 / CA AB 537 item).
 *
 * Direction of every ambiguity: NON-refundable. A tag we do not recognise is
 * rendered as non-refundable and reported, never as free cancellation.
 */

export type RoomRefundability =
  | { kind: "free_until"; /** airport-local, "YYYY-MM-DD HH:mm" */ deadlineLocal: string; timeZone: string }
  | { kind: "non_refundable" };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-10-14 18:00" → "Oct 14, 2026 at 6:00 PM". Pure string formatting; no Date. */
export function formatLocalDeadline(deadlineLocal: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(deadlineLocal);
  if (!m) return deadlineLocal;
  const [, y, mo, d, hh, mm] = m;
  const h24 = Number(hh);
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const ampm = h24 < 12 ? "AM" : "PM";
  return `${MONTHS[Number(mo) - 1]} ${Number(d)}, ${y} at ${h12}:${mm} ${ampm}`;
}

export const ROOM_NON_REFUNDABLE_SUMMARY = "Non-refundable room";
export const ROOM_NON_REFUNDABLE_DETAIL = "This room rate cannot be cancelled or refunded once booked.";

/**
 * The only thing Phase A says about cancelling the BUNDLE (plan v3 §8.2, B10):
 * the package cancellation rules are decided in Phase B (M12), so no surface
 * may commit to them yet — not "your parking keeps its own terms", not a
 * refund promise. (B1 note: Stripe fees are not returned on refunds, so the
 * Phase B rules must account for them.)
 */
export const BUNDLE_CANCELLATION_NOTE = "Cancellation terms are confirmed before you book.";

/**
 * The ROOM's terms only — prefixed "Room:" so on a package card it can't read
 * as a promise about the whole booking (the bundle terms are B1's, M12).
 */
export function roomRefundabilitySummary(r: RoomRefundability): string {
  if (r.kind === "non_refundable") return ROOM_NON_REFUNDABLE_SUMMARY;
  return `Room: free cancellation until ${formatLocalDeadline(r.deadlineLocal)} (hotel time)`;
}

/**
 * The short tag form for cards and the price box (Park & Stay CX, mockup
 * screens 7–8). It IS the summary wording — "Room:" prefix, the year and
 * "(hotel time)" included — so the tag can never say less than the summary.
 * A deadline that isn't a well-formed "YYYY-MM-DD HH:mm" is NON-refundable
 * (the direction of every ambiguity in this file), never a free-cancellation
 * tag with a garbled date.
 */
export function roomRefundabilityTag(r: RoomRefundability): { refundable: boolean; text: string } {
  if (r.kind === "free_until" && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(r.deadlineLocal)) {
    return { refundable: true, text: roomRefundabilitySummary(r) };
  }
  return { refundable: false, text: ROOM_NON_REFUNDABLE_SUMMARY };
}

export function roomRefundabilityDetail(r: RoomRefundability): string {
  if (r.kind === "non_refundable") return ROOM_NON_REFUNDABLE_DETAIL;
  return `Cancel the room for free until ${formatLocalDeadline(r.deadlineLocal)} (local time at the hotel). After that the room is non-refundable.`;
}

/** Terms-checkbox copy is CONDITIONAL on refundability, never additive (plan §1). */
export function roomTermsAcknowledgement(r: RoomRefundability): string {
  if (r.kind === "non_refundable") {
    return "I understand the hotel room is non-refundable.";
  }
  return `I understand the hotel room is free to cancel until ${formatLocalDeadline(r.deadlineLocal)} and non-refundable after that.`;
}
