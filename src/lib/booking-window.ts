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
