"use client";

import Link from "next/link";
import { Calendar, MapPin, Car, Clock, ChevronRight, CheckCircle2 } from "lucide-react";
import { format, parseISO, isPast, isToday } from "date-fns";
import { CancelReservationButton } from "./cancel-reservation-button";
import { formatUsd } from "@/lib/booking/cost-breakdown";
import { reservationCardAmounts } from "@/lib/bookings/reservation-card-amounts";

/** One row of `GET /api/user/bookings` as the card renders it. */
export interface ReservationCardBooking {
  id: string;
  reslab_reservation_number: string;
  /** NULL on a direct-lot booking (Triply-owned lot, no ResLab location). */
  reslab_location_id: number | null;
  /** "direct" = Triply-owned lot (migration 034); anything else is ResLab. */
  inventory_source?: string | null;
  /** The direct lot's CMS id; NULL on ResLab rows. */
  direct_lot_id?: string | null;
  /** Direct lots: the oversized-vehicle estimate PAID AT THE LOT, in cents. NULL on ResLab rows. */
  vehicle_surcharge_cents?: number | null;
  vehicle_surcharge_tax_cents?: number | null;
  location_name: string;
  location_address: string;
  airport_code: string | null;
  check_in: string;
  check_out: string;
  grand_total: number | string | null;
  triply_service_fee: number | string | null;
  /** Park Guard plan; its premium counts toward the booking total only when set. */
  protection_plan: string | null;
  protection_plan_price: number | string | null;
  /** Promo discount taken off the card charge (not written back into grand_total). */
  discount_amount: number | string | null;
  /** ResLab pay-at-location share — inside grand_total, never charged online. 0 on direct rows. */
  due_at_location: number | string | null;
  /** The parts grand_total must add up to before it may bound a due amount. */
  subtotal?: number | string | null;
  fees_total?: number | string | null;
  tax_total?: number | string | null;
  vehicle_info: {
    make: string;
    model: string;
    color: string;
    licensePlate: string;
  } | null;
  // 'refunded' = cancelled AND money returned (the common self-cancel outcome,
  // written by finalize.ts) — display it the same as 'cancelled'.
  status: "confirmed" | "cancelled" | "refunded" | "completed";
  created_at: string;
  /** Server-computed airport-local 24h self-cancel eligibility. */
  cancellable: boolean;
}

interface ReservationCardProps {
  booking: ReservationCardBooking;
  /**
   * Logged-in customer's email — passed in the confirmation URL as a
   * fallback auth token for the `/api/reservations/[id]` GET. The API
   * prefers the session, but if it expired between this page load and
   * the click, the email keeps the deep-link working instead of 403-ing.
   */
  customerEmail: string | null;
  /** Server flag: is self-service cancellation enabled? Gates the Cancel button. */
  selfCancelEnabled: boolean;
  /** Called after a successful cancel so the page flips this card to Cancelled. */
  onCancelled: (reservationNumber: string, refundAmount: number | null) => void;
  /**
   * Set only for a card cancelled in THIS session: the dollars refunded, or
   * null when it was cancelled without a refund (e.g. already cancelled, or an
   * uncaptured authorization released). `undefined` means "not just cancelled"
   * — the distinction matters, since null is a meaningful value here.
   */
  justCancelledRefund?: number | null;
}

export function ReservationCard({
  booking,
  customerEmail,
  selfCancelEnabled,
  onCancelled,
  justCancelledRefund,
}: ReservationCardProps) {
  const checkInDate = parseISO(booking.check_in);
  const checkOutDate = parseISO(booking.check_out);
  const isUpcoming = !isPast(checkInDate) || isToday(checkInDate);
  const isActive = isPast(checkInDate) && !isPast(checkOutDate);

  const getStatusBadge = () => {
    if (booking.status === "cancelled" || booking.status === "refunded") {
      return (
        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800">
          Cancelled
        </span>
      );
    }
    if (isActive) {
      return (
        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
          Active
        </span>
      );
    }
    if (isUpcoming) {
      return (
        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
          Upcoming
        </span>
      );
    }
    return (
      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-800">
        Completed
      </span>
    );
  };

  // Build confirmation URL with lot info + (when known) the customer email
  // as a fallback auth token for the API GET. See the prop comment above.
  const emailParam = customerEmail ? `&email=${encodeURIComponent(customerEmail)}` : "";
  // ?lot= is the confirmation page's sessionStorage key for the lot's photos;
  // a direct booking's lot id is "direct-<CMS id>" (never "reslab-null"). A
  // direct row missing its direct_lot_id gets NO lot param rather than a bogus
  // "direct-null" key — the param is only a photo-cache hint; the page builds
  // the lot from the API response either way.
  const lotParam =
    booking.inventory_source === "direct"
      ? booking.direct_lot_id
        ? `direct-${encodeURIComponent(booking.direct_lot_id)}`
        : null
      : `reslab-${booking.reslab_location_id}`;
  const lotQuery = lotParam ? `lot=${lotParam}&` : "";
  // "Booking total" = the whole booking, net of the promo discount. NOT what
  // the card was charged: this card reads only the row (no Stripe anchor), so
  // the confirmation page is the one place that states the charge. null (an
  // unreadable money column, or cancelled) renders no amount, never $0.00.
  const { bookingTotalCents, dueAtLocationCents, dueUnconfirmed, atLotCents } = reservationCardAmounts(booking);
  const confirmationUrl = `/confirmation/${booking.reslab_reservation_number}?${lotQuery}checkin=${format(checkInDate, "yyyy-MM-dd")}&checkout=${format(checkOutDate, "yyyy-MM-dd")}${emailParam}`;

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5 hover:shadow-lg hover:border-brand-orange/30 transition-all duration-200">
      <Link href={confirmationUrl} className="block cursor-pointer">
        <div className="flex items-start justify-between mb-4">
          <div>
            <div className="flex items-center gap-2 mb-1">
              {getStatusBadge()}
              {booking.airport_code && (
                <span className="text-xs text-gray-500 font-medium">
                  {booking.airport_code}
                </span>
              )}
            </div>
            <h3 className="font-semibold text-gray-900 text-lg">
              {booking.location_name}
            </h3>
            {booking.location_address && (
              <p className="text-sm text-gray-500 flex items-center gap-1 mt-1">
                <MapPin className="h-3.5 w-3.5" />
                {booking.location_address}
              </p>
            )}
          </div>
          <ChevronRight className="h-5 w-5 text-gray-400" />
        </div>

        <div className="grid grid-cols-2 gap-4 mb-4">
          <div className="bg-gray-50 rounded-lg p-3">
            <p className="text-xs text-gray-500 mb-1 flex items-center gap-1">
              <Calendar className="h-3.5 w-3.5" />
              Check-in
            </p>
            <p className="font-medium text-gray-900">
              {format(checkInDate, "MMM d, yyyy")}
            </p>
            <p className="text-sm text-gray-600">
              {format(checkInDate, "h:mm a")}
            </p>
          </div>
          <div className="bg-gray-50 rounded-lg p-3">
            <p className="text-xs text-gray-500 mb-1 flex items-center gap-1">
              <Clock className="h-3.5 w-3.5" />
              Check-out
            </p>
            <p className="font-medium text-gray-900">
              {format(checkOutDate, "MMM d, yyyy")}
            </p>
            <p className="text-sm text-gray-600">
              {format(checkOutDate, "h:mm a")}
            </p>
          </div>
        </div>

        <div className="flex items-center justify-between pt-4 border-t border-gray-100">
          <div className="flex items-center gap-4">
            {booking.vehicle_info && (
              <div className="flex items-center gap-1.5 text-sm text-gray-600">
                <Car className="h-4 w-4" />
                <span>
                  {booking.vehicle_info.make} {booking.vehicle_info.model}
                </span>
              </div>
            )}
            <p className="text-xs text-gray-500">
              #{booking.reslab_reservation_number}
            </p>
          </div>
          <div className="text-right">
            {bookingTotalCents !== null && (
              <>
                <p className="text-xs text-gray-500">Booking total</p>
                <p className="font-bold text-brand-orange text-lg">
                  {formatUsd(bookingTotalCents)}
                </p>
              </>
            )}
            {/* ResLab pay-at-lot share: inside the booking total above, paid at the location. */}
            {dueAtLocationCents > 0 && (
              <p className="text-xs text-amber-700">
                Due at location {formatUsd(dueAtLocationCents)}
              </p>
            )}
            {dueUnconfirmed && (
              <p className="text-xs text-amber-700">The lot confirms any amount due on arrival</p>
            )}
            {/* Direct lots: oversized-vehicle estimate paid at drop-off, outside the booking total above. */}
            {atLotCents > 0 && (
              <p className="text-xs text-amber-700">
                Due at the lot (est.) {formatUsd(atLotCents)}
              </p>
            )}
          </div>
        </div>
      </Link>

      {/* Post-cancel confirmation. Lives HERE, not in CancelReservationButton:
          the moment status flips to 'cancelled' the button below unmounts, so a
          success panel owned by it could never paint — the customer would watch
          the badge change and never learn what they got back. */}
      {justCancelledRefund !== undefined && (
        <div className="mt-4 rounded-lg bg-green-50 border border-green-200 p-4">
          <div className="flex items-start gap-2.5">
            <CheckCircle2 className="h-5 w-5 text-green-600 mt-0.5 shrink-0" />
            <div>
              <p className="text-sm font-semibold text-green-900">
                Reservation cancelled
              </p>
              <p className="mt-0.5 text-sm text-green-800">
                {justCancelledRefund !== null
                  ? `$${justCancelledRefund.toFixed(2)} has been refunded to your original payment method. It should appear within 5–10 business days.`
                  : "This reservation is cancelled. Check your email for the details."}
              </p>
            </div>
          </div>
        </div>
      )}

      {selfCancelEnabled && booking.status === "confirmed" && isUpcoming && (
        <CancelReservationButton
          reservationNumber={booking.reslab_reservation_number}
          cancellable={booking.cancellable}
          onCancelled={onCancelled}
        />
      )}
    </div>
  );
}
