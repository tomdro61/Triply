"use client";

import Link from "next/link";
import { Calendar, MapPin, Car, Clock, ChevronRight } from "lucide-react";
import { format, parseISO, isPast, isToday } from "date-fns";

interface Booking {
  id: string;
  reslab_reservation_number: string;
  reslab_location_id: number;
  location_name: string;
  location_address: string;
  airport_code: string;
  check_in: string;
  check_out: string;
  grand_total: number;
  vehicle_info: {
    make: string;
    model: string;
    color: string;
    licensePlate: string;
  } | null;
  status: "confirmed" | "cancelled" | "completed";
  created_at: string;
}

interface ReservationCardProps {
  booking: Booking;
}

export function ReservationCard({ booking }: ReservationCardProps) {
  const checkInDate = parseISO(booking.check_in);
  const checkOutDate = parseISO(booking.check_out);
  const isUpcoming = !isPast(checkInDate) || isToday(checkInDate);
  const isActive = isPast(checkInDate) && !isPast(checkOutDate);

  const getStatusBadge = () => {
    if (booking.status === "cancelled") {
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

  // Build confirmation URL with lot info
  const confirmationUrl = `/confirmation/${booking.reslab_reservation_number}?lot=reslab-${booking.reslab_location_id}&checkin=${format(checkInDate, "yyyy-MM-dd")}&checkout=${format(checkOutDate, "yyyy-MM-dd")}`;

  return (
    <Link href={confirmationUrl}>
      <div className="bg-white rounded-xl border border-gray-200 p-5 hover:shadow-lg hover:border-brand-orange/30 transition-all duration-200 cursor-pointer">
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
          <p className="font-bold text-brand-orange text-lg">
            ${booking.grand_total.toFixed(2)}
          </p>
        </div>
      </div>
    </Link>
  );
}
