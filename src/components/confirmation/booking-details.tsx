"use client";

import Image from "next/image";
import {
  Calendar,
  Clock,
  MapPin,
  Car,
  User,
  Phone,
  Mail,
  Navigation,
} from "lucide-react";
import { UnifiedLot } from "@/types/lot";

interface BookingDetailsProps {
  lot: UnifiedLot;
  checkIn: string;
  checkOut: string;
  days: number;
  total: number;
  customerName?: string;
  customerEmail?: string;
  customerPhone?: string;
  vehicleInfo?: string;
}

export function BookingDetails({
  lot,
  checkIn,
  checkOut,
  days,
  total,
  customerName,
  customerEmail,
  customerPhone,
  vehicleInfo,
}: BookingDetailsProps) {
  const mainImage = lot.photos[0]?.url || "/placeholder-lot.jpg";

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr + "T00:00:00");
    return date.toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    });
  };

  const formatShortDate = (dateStr: string) => {
    const date = new Date(dateStr + "T00:00:00");
    return date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
  };

  const handleGetDirections = () => {
    const address = encodeURIComponent(
      `${lot.address}, ${lot.city}, ${lot.state} ${lot.zipCode || ""}`
    );
    window.open(`https://www.google.com/maps/dir/?api=1&destination=${address}`, "_blank");
  };

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
      {/* Lot Header */}
      <div className="relative h-48">
        <Image
          src={mainImage}
          alt={lot.name}
          fill
          className="object-cover"
          sizes="(max-width: 768px) 100vw, 600px"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-black/70 to-transparent" />
        <div className="absolute bottom-4 left-4 right-4">
          <h2 className="text-xl font-bold text-white mb-1">{lot.name}</h2>
          <div className="flex items-center text-white/90 text-sm">
            <MapPin size={14} className="mr-1" />
            {lot.address}, {lot.city}, {lot.state}
          </div>
        </div>
      </div>

      {/* Details Grid */}
      <div className="p-6">
        {/* Dates */}
        <div className="grid grid-cols-2 gap-4 mb-6">
          <div className="bg-gray-50 rounded-lg p-4">
            <div className="flex items-center text-gray-500 text-sm mb-1">
              <Calendar size={14} className="mr-2" />
              Check-in
            </div>
            <p className="font-bold text-gray-900">{formatShortDate(checkIn)}</p>
            <p className="text-sm text-gray-600">{formatDate(checkIn)}</p>
          </div>
          <div className="bg-gray-50 rounded-lg p-4">
            <div className="flex items-center text-gray-500 text-sm mb-1">
              <Calendar size={14} className="mr-2" />
              Check-out
            </div>
            <p className="font-bold text-gray-900">{formatShortDate(checkOut)}</p>
            <p className="text-sm text-gray-600">{formatDate(checkOut)}</p>
          </div>
        </div>

        {/* Duration & Total */}
        <div className="flex items-center justify-between p-4 bg-brand-orange/10 rounded-lg mb-6">
          <div className="flex items-center">
            <Clock size={20} className="text-brand-orange mr-3" />
            <div>
              <p className="text-sm text-gray-600">Duration</p>
              <p className="font-bold text-gray-900">
                {days} {days === 1 ? "day" : "days"}
              </p>
            </div>
          </div>
          <div className="text-right">
            <p className="text-sm text-gray-600">Total Paid</p>
            <p className="text-2xl font-bold text-brand-orange">
              ${total.toFixed(2)}
            </p>
          </div>
        </div>

        {/* Customer & Vehicle Info */}
        {(customerName || vehicleInfo) && (
          <div className="border-t border-gray-200 pt-6 space-y-4">
            <h3 className="font-semibold text-gray-900">Booking Information</h3>

            {customerName && (
              <div className="flex items-center text-gray-700">
                <User size={18} className="mr-3 text-gray-400" />
                <span>{customerName}</span>
              </div>
            )}

            {customerEmail && (
              <div className="flex items-center text-gray-700">
                <Mail size={18} className="mr-3 text-gray-400" />
                <span>{customerEmail}</span>
              </div>
            )}

            {customerPhone && (
              <div className="flex items-center text-gray-700">
                <Phone size={18} className="mr-3 text-gray-400" />
                <span>{customerPhone}</span>
              </div>
            )}

            {vehicleInfo && (
              <div className="flex items-center text-gray-700">
                <Car size={18} className="mr-3 text-gray-400" />
                <span>{vehicleInfo}</span>
              </div>
            )}
          </div>
        )}

        {/* Get Directions Button */}
        <button
          onClick={handleGetDirections}
          className="w-full mt-6 flex items-center justify-center gap-2 py-3 bg-gray-900 text-white font-medium rounded-lg hover:bg-gray-800 transition-colors"
        >
          <Navigation size={18} />
          Get Directions
        </button>
      </div>
    </div>
  );
}
