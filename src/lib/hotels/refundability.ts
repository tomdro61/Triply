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
export const ROOM_NON_REFUNDABLE_DETAIL =
  "This room rate cannot be cancelled or refunded once booked. Your parking keeps its own cancellation terms.";

export function roomRefundabilitySummary(r: RoomRefundability): string {
  if (r.kind === "non_refundable") return ROOM_NON_REFUNDABLE_SUMMARY;
  return `Free cancellation until ${formatLocalDeadline(r.deadlineLocal)}`;
}

export function roomRefundabilityDetail(r: RoomRefundability): string {
  if (r.kind === "non_refundable") return ROOM_NON_REFUNDABLE_DETAIL;
  return `Cancel the room for free until ${formatLocalDeadline(r.deadlineLocal)} (local time at the hotel). After that the room is non-refundable. Your parking keeps its own cancellation terms.`;
}

/** Terms-checkbox copy is CONDITIONAL on refundability, never additive (plan §1). */
export function roomTermsAcknowledgement(r: RoomRefundability): string {
  if (r.kind === "non_refundable") {
    return "I understand the hotel room is non-refundable.";
  }
  return `I understand the hotel room is free to cancel until ${formatLocalDeadline(r.deadlineLocal)} and non-refundable after that.`;
}
