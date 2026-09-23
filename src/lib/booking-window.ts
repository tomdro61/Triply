import { addDays, startOfDay } from "date-fns";

/**
 * ResLab only accepts reservations whose CHECK-IN date is within this many days
 * of today — beyond it their pricing/reservation API returns HTTP 422
 * "Bookings only accepted within 60 days" (verified 2026-07-16). We cap the
 * date pickers to this window so a customer can't select a far-future date that
 * would silently come back as an empty "no parking found" result.
 */
export const MAX_ADVANCE_BOOKING_DAYS = 60;

/**
 * Latest selectable check-in date: start of today + the ResLab booking window.
 * (react-day-picker's `{ after: maxDate }` leaves this day itself selectable and
 * disables everything after it, matching ResLab's inclusive 60-day boundary.)
 */
export function maxAdvanceBookingDate(): Date {
  return addDays(startOfDay(new Date()), MAX_ADVANCE_BOOKING_DAYS);
}

/**
 * yyyy-MM-dd in the browser's LOCAL calendar (never `toISOString()`, which is
 * UTC and turns a US evening into "tomorrow"). Cheap on purpose: date-fns
 * `format` drags the formatter/locale chain into any initial bundle that
 * imports it, and the blog article chunk was just trimmed by 86 KB.
 */
export function toLocalISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-12-09" → "Dec 9, 2026" for customer-facing copy (matches the widget's MMM d, yyyy). */
function friendlyDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${MONTHS[(m ?? 1) - 1]} ${d}, ${y}`;
}

/**
 * The one place a search's dates are validated before they leave the widget.
 * Native `<input type="date">` `min`/`max` are constraint-validation HINTS —
 * a typed out-of-range value is still committed — and /api/search validates
 * shape only, so without this a reader can send a check-in ResLab will 422
 * on every lot and be told "search is broken". Returns a customer-facing
 * message, or null when the range is usable. Lexicographic comparison is
 * exact for yyyy-MM-dd.
 */
export function validateSearchDates(
  departDate: string,
  returnDate: string,
  now: Date = new Date()
): string | null {
  if (!ISO_DATE_RE.test(departDate) || !ISO_DATE_RE.test(returnDate)) {
    return "Please enter both dates.";
  }
  const min = toLocalISODate(now);
  const max = toLocalISODate(addDays(startOfDay(now), MAX_ADVANCE_BOOKING_DAYS));
  if (departDate < min) {
    return "Check-in can't be in the past.";
  }
  if (departDate > max) {
    return `Reservations open ${MAX_ADVANCE_BOOKING_DAYS} days in advance — the latest check-in is ${friendlyDate(max)}.`;
  }
  if (returnDate < departDate) {
    return "Return date must be on or after your check-in date.";
  }
  // The calendar disables `{ after: maxDate }` for the return leg too; the
  // fallback input only hints it. Keep the gate as strict as the picker.
  if (returnDate > max) {
    return `Return dates are available up to ${friendlyDate(max)} for now.`;
  }
  return null;
}
