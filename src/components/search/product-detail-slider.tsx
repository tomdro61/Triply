"use client";

import { useState, useMemo } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  X,
  Star,
  MapPin,
  Check,
  ExternalLink,
  Wallet,
  ChevronLeft,
  ChevronRight,
  Calendar,
  Clock,
  ChevronDown,
  Shield,
} from "lucide-react";
import { UnifiedLot } from "@/types/lot";
import { getAirportByCode } from "@/config/airports";

const timeOptions = [
  "12:00 AM", "12:30 AM", "1:00 AM", "1:30 AM", "2:00 AM", "2:30 AM",
  "3:00 AM", "3:30 AM", "4:00 AM", "4:30 AM", "5:00 AM", "5:30 AM",
  "6:00 AM", "6:30 AM", "7:00 AM", "7:30 AM", "8:00 AM", "8:30 AM",
  "9:00 AM", "9:30 AM", "10:00 AM", "10:30 AM", "11:00 AM", "11:30 AM",
  "12:00 PM", "12:30 PM", "1:00 PM", "1:30 PM", "2:00 PM", "2:30 PM",
  "3:00 PM", "3:30 PM", "4:00 PM", "4:30 PM", "5:00 PM", "5:30 PM",
  "6:00 PM", "6:30 PM", "7:00 PM", "7:30 PM", "8:00 PM", "8:30 PM",
  "9:00 PM", "9:30 PM", "10:00 PM", "10:30 PM", "11:00 PM", "11:30 PM",
];

interface ProductDetailSliderProps {
  lot: UnifiedLot;
  checkIn: string;
  checkOut: string;
  checkInTime?: string;
  checkOutTime?: string;
  airportCode: string;
  onClose: () => void;
}

export function ProductDetailSlider({
  lot,
  checkIn,
  checkOut,
  checkInTime = "10:00 AM",
  checkOutTime = "2:00 PM",
  airportCode,
  onClose,
}: ProductDetailSliderProps) {
  const router = useRouter();
  const [localCheckIn, setLocalCheckIn] = useState(checkIn);
  const [localCheckOut, setLocalCheckOut] = useState(checkOut);
  const [localCheckInTime, setLocalCheckInTime] = useState(checkInTime);
  const [localCheckOutTime, setLocalCheckOutTime] = useState(checkOutTime);
  const [currentPhoto, setCurrentPhoto] = useState(0);

  const price = lot.pricing?.minPrice ?? 0;
  const photoCount = lot.photos.length || 1;

  // Calculate number of days and total (matches BookingWidget logic)
  const hasApiPricing = lot.pricing?.grandTotal !== undefined;
  const { days, subtotal, fees, taxes, total } = useMemo(() => {
    const start = new Date(localCheckIn);
    const end = new Date(localCheckOut);
    const diffTime = Math.abs(end.getTime() - start.getTime());
    const diffDays = Math.max(1, Math.ceil(diffTime / (1000 * 60 * 60 * 24)));

    if (hasApiPricing) {
      return {
        days: lot.pricing?.numberOfDays || diffDays,
        subtotal: lot.pricing?.subtotal || price * diffDays,
        fees: lot.pricing?.feesTotal || 0,
        taxes: lot.pricing?.taxTotal || 0,
        total: lot.pricing?.grandTotal || price * diffDays,
      };
    }

    const sub = price * diffDays;
    const tax = Math.round(sub * (lot.pricing?.taxValue || 8) / 100 * 100) / 100;
    return {
      days: diffDays,
      subtotal: sub,
      fees: 0,
      taxes: tax,
      total: sub + tax,
    };
  }, [localCheckIn, localCheckOut, price, hasApiPricing, lot.pricing]);

  const airport = getAirportByCode(airportCode);
  const lotDetailUrl = airport
    ? `/${airport.slug}/airport-parking/${lot.slug}?checkin=${localCheckIn}&checkout=${localCheckOut}&checkinTime=${encodeURIComponent(localCheckInTime)}&checkoutTime=${encodeURIComponent(localCheckOutTime)}`
    : "#";

  const handleReserve = () => {
    const params = new URLSearchParams({
      lot: lot.id,
      checkin: localCheckIn,
      checkout: localCheckOut,
      checkinTime: localCheckInTime,
      checkoutTime: localCheckOutTime,
    });
    router.push(`/checkout?${params.toString()}`);
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm transition-opacity"
        onClick={onClose}
      />

      {/* Slider Panel */}
      <div className="relative w-full max-w-2xl bg-white h-full shadow-2xl flex flex-col transform transition-transform animate-slide-in-right overflow-hidden">
        {/* Close button (fixed position) */}
        <button
          onClick={onClose}
          className="absolute top-4 left-4 p-2 bg-white/90 backdrop-blur rounded-full shadow-md hover:bg-white transition-colors z-10"
        >
          <X size={20} className="text-gray-900" />
        </button>

        {/* Scrollable Content (image scrolls with content) */}
        <div className="flex-1 overflow-y-auto bg-white">
          {/* Image Area */}
          <div className="relative h-72 sm:h-80 group">
            <Image
              src={lot.photos[currentPhoto]?.url || "/placeholder-lot.jpg"}
              alt={lot.name}
              fill
              className="object-cover"
              sizes="(max-width: 672px) 100vw, 672px"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-black/50 to-transparent opacity-60" />

            {/* Photo navigation arrows */}
            {photoCount > 1 && (
              <>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setCurrentPhoto((prev) => (prev - 1 + photoCount) % photoCount);
                  }}
                  className="absolute left-3 top-1/2 -translate-y-1/2 p-1.5 bg-white/80 backdrop-blur rounded-full shadow hover:bg-white transition-colors"
                >
                  <ChevronLeft size={18} className="text-gray-800" />
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setCurrentPhoto((prev) => (prev + 1) % photoCount);
                  }}
                  className="absolute right-3 top-1/2 -translate-y-1/2 p-1.5 bg-white/80 backdrop-blur rounded-full shadow hover:bg-white transition-colors"
                >
                  <ChevronRight size={18} className="text-gray-800" />
                </button>
              </>
            )}

            <div className="absolute bottom-4 right-4 bg-black/50 backdrop-blur px-3 py-1 rounded-lg text-xs font-bold text-white shadow-sm border border-white/20">
              {currentPhoto + 1}/{photoCount} Photos
            </div>
          </div>

          <div className="p-6 md:p-8 space-y-8">
          {/* Header Info */}
          <div>
            <h2 className="text-2xl font-bold text-gray-900 mb-2 leading-tight">
              {lot.name}
            </h2>
            <div className="flex items-center text-gray-500 text-sm mb-3">
              <MapPin
                size={16}
                className="mr-1 flex-shrink-0 text-brand-orange"
              />
              <span>
                {lot.distanceFromAirport !== undefined
                  ? `${lot.distanceFromAirport.toFixed(1)} mi from airport`
                  : `${lot.address}, ${lot.city}, ${lot.state}`}
              </span>
            </div>
            <div className="flex items-center space-x-4 text-sm">
              {lot.rating && (
                <div className="flex items-center">
                  <Star
                    size={16}
                    className="text-yellow-400 fill-yellow-400 mr-1"
                  />
                  <span className="font-bold text-gray-900">
                    {lot.rating.toFixed(1)}
                  </span>
                  <span className="text-gray-500 ml-1">
                    ({lot.reviewCount || 0} ratings)
                  </span>
                </div>
              )}
              <div className="text-green-600 font-medium flex items-center">
                <Check size={14} className="mr-1" /> Free Cancellation
              </div>
            </div>
          </div>

          <hr className="border-gray-100" />

          {/* Overview / Description */}
          {lot.description && (
            <div className="bg-gray-50 rounded-xl p-6 border border-gray-100">
              <h3 className="font-bold text-gray-900 mb-2 text-lg">
                Overview
              </h3>
              <p className="text-gray-600 text-sm leading-relaxed">
                {lot.description}
              </p>
            </div>
          )}

          {/* Amenities Section */}
          {lot.amenities.length > 0 && (
            <div>
              <h3 className="font-bold text-gray-900 mb-4 text-lg">Amenities</h3>
              <div className="grid grid-cols-2 gap-y-4 gap-x-6">
                {lot.amenities.map((amenity) => (
                  <div key={amenity.id} className="flex items-center text-gray-700">
                    <div className="w-8 h-8 rounded-full bg-gray-50 border border-gray-100 flex items-center justify-center mr-3 shrink-0">
                      <Check size={14} className="text-brand-orange stroke-[3]" />
                    </div>
                    <span className="capitalize font-medium text-sm">
                      {amenity.displayName}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Shuttle Information */}
          {lot.shuttleInfo && (
            <div className="bg-blue-50/50 rounded-xl p-6 border border-blue-100">
              <h3 className="font-bold text-gray-900 mb-2 text-lg">
                Shuttle Information
              </h3>
              <p className="text-gray-600 text-sm leading-relaxed">
                {lot.shuttleInfo.summary}
                {lot.shuttleInfo.details && ` ${lot.shuttleInfo.details}`}
              </p>
            </div>
          )}

          {lot.directions && (
            <div className="bg-gray-50 rounded-xl p-6 border border-gray-100">
              <h3 className="font-bold text-gray-900 mb-2 text-lg">
                Directions
              </h3>
              <p className="text-gray-600 text-sm leading-relaxed">
                {lot.directions}
              </p>
            </div>
          )}

          {/* View Full Details Link */}
          <Link
            href={lotDetailUrl}
            className="text-brand-orange font-bold text-sm flex items-center hover:underline"
          >
            View full details <ExternalLink size={14} className="ml-1.5" />
          </Link>

          {/* Booking Section — dates & price breakdown */}
          <div>
            {/* Price Header */}
            <div className="mb-4">
              <span className="text-3xl font-bold text-gray-900">
                ${price.toFixed(2)}
              </span>
              <span className="text-gray-500 font-medium"> / day</span>
            </div>

            {/* Pay at Location Indicator */}
            {lot.dueAtLocation && (
              <div className="flex items-start gap-2 mb-4 p-3 bg-amber-50 border border-amber-200 rounded-lg">
                <Wallet size={18} className="text-amber-600 flex-shrink-0 mt-0.5" />
                <div className="text-sm">
                  <span className="font-semibold text-amber-800">Pay at Location</span>
                  <p className="text-amber-700 text-xs mt-0.5">
                    Payment will be collected on-site at check-in
                  </p>
                </div>
              </div>
            )}

            {/* Date Selection */}
            <div className="space-y-3 mb-4">
              {/* Check-in Date & Time */}
              <div className="border border-gray-200 rounded-lg p-3 hover:border-brand-orange transition-colors focus-within:ring-1 focus-within:ring-brand-orange">
                <label className="block text-xs font-bold text-gray-500 uppercase mb-1">
                  Check-in
                </label>
                <div className="flex items-center gap-2">
                  <div className="flex items-center flex-1">
                    <Calendar
                      size={16}
                      className="mr-2 text-brand-blue pointer-events-none"
                    />
                    <input
                      type="date"
                      value={localCheckIn}
                      onChange={(e) => setLocalCheckIn(e.target.value)}
                      className="w-full bg-transparent outline-none cursor-pointer font-bold text-sm"
                    />
                  </div>
                  <div className="relative w-28">
                    <Clock size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400" />
                    <select
                      value={localCheckInTime}
                      onChange={(e) => setLocalCheckInTime(e.target.value)}
                      className="w-full pl-7 pr-6 py-1 bg-gray-50 border border-gray-200 rounded text-xs font-medium appearance-none cursor-pointer"
                    >
                      {timeOptions.map((time) => (
                        <option key={time} value={time}>
                          {time}
                        </option>
                      ))}
                    </select>
                    <ChevronDown size={12} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
                  </div>
                </div>
              </div>

              {/* Check-out Date & Time */}
              <div className="border border-gray-200 rounded-lg p-3 hover:border-brand-orange transition-colors focus-within:ring-1 focus-within:ring-brand-orange">
                <label className="block text-xs font-bold text-gray-500 uppercase mb-1">
                  Check-out
                </label>
                <div className="flex items-center gap-2">
                  <div className="flex items-center flex-1">
                    <Calendar
                      size={16}
                      className="mr-2 text-brand-blue pointer-events-none"
                    />
                    <input
                      type="date"
                      value={localCheckOut}
                      onChange={(e) => setLocalCheckOut(e.target.value)}
                      className="w-full bg-transparent outline-none cursor-pointer font-bold text-sm"
                    />
                  </div>
                  <div className="relative w-28">
                    <Clock size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400" />
                    <select
                      value={localCheckOutTime}
                      onChange={(e) => setLocalCheckOutTime(e.target.value)}
                      className="w-full pl-7 pr-6 py-1 bg-gray-50 border border-gray-200 rounded text-xs font-medium appearance-none cursor-pointer"
                    >
                      {timeOptions.map((time) => (
                        <option key={time} value={time}>
                          {time}
                        </option>
                      ))}
                    </select>
                    <ChevronDown size={12} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
                  </div>
                </div>
              </div>
            </div>

            {/* Price Breakdown */}
            <div className="bg-gray-50 rounded-lg p-4 border border-gray-100">
              <div className="flex justify-between text-sm text-gray-600 mb-2">
                <span>
                  ${price.toFixed(2)} x {days} {days === 1 ? "day" : "days"}
                </span>
                <span>${subtotal.toFixed(2)}</span>
              </div>
              {fees > 0 && (
                <div className="flex justify-between text-sm text-gray-600 mb-2">
                  <span>Fees</span>
                  <span>${fees.toFixed(2)}</span>
                </div>
              )}
              <div className="flex justify-between text-sm text-gray-600 mb-2">
                <span>Taxes</span>
                <span>${taxes.toFixed(2)}</span>
              </div>
              <div className="border-t border-gray-200 pt-2 flex justify-between font-bold text-gray-900 text-lg">
                <span>Total</span>
                <span>${total.toFixed(2)}</span>
              </div>
              {lot.dueAtLocation && lot.dueAtLocationAmount && (
                <div className="mt-2 pt-2 border-t border-gray-200">
                  <div className="flex justify-between text-sm text-amber-700">
                    <span>Due at location</span>
                    <span>${lot.dueAtLocationAmount.toFixed(2)}</span>
                  </div>
                </div>
              )}
            </div>
          </div>
          </div>
        </div>

        {/* Sticky Footer — both mobile and desktop */}
        <div className="border-t border-gray-200 px-4 py-3 bg-white shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.05)] flex items-center justify-between gap-4">
          <div>
            <div className="flex items-baseline gap-1">
              <span className="text-xl font-bold text-gray-900">${price.toFixed(2)}</span>
              <span className="text-sm text-gray-500">/day</span>
            </div>
            <span className="text-xs text-gray-500">${total.toFixed(2)} total</span>
          </div>
          <button
            onClick={handleReserve}
            className="bg-brand-orange text-white font-bold py-2.5 px-6 rounded-lg shadow-md hover:bg-orange-600 transition-all active:scale-[0.98]"
          >
            Reserve Now
          </button>
        </div>
      </div>
    </div>
  );
}
