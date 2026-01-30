"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  X,
  Star,
  MapPin,
  Check,
  ChevronRight,
  Clock,
  Shield,
  ExternalLink,
  AlertCircle,
  Wallet,
} from "lucide-react";
import { UnifiedLot } from "@/types/lot";
import { getAirportByCode } from "@/config/airports";

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

  const mainImage = lot.photos[0]?.url || "/placeholder-lot.jpg";
  const price = lot.pricing?.minPrice ?? 0;
  const originalPrice = lot.pricing?.parkingTypes[0]?.originalPrice;

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
        {/* Header / Image Area */}
        <div className="relative h-64 flex-shrink-0 group">
          <Image
            src={mainImage}
            alt={lot.name}
            fill
            className="object-cover"
            sizes="(max-width: 672px) 100vw, 672px"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-black/50 to-transparent opacity-60" />
          <button
            onClick={onClose}
            className="absolute top-4 left-4 p-2 bg-white/90 backdrop-blur rounded-full shadow-md hover:bg-white transition-colors z-10"
          >
            <X size={20} className="text-gray-900" />
          </button>
          <div className="absolute bottom-4 right-4 bg-black/50 backdrop-blur px-3 py-1 rounded-lg text-xs font-bold text-white shadow-sm border border-white/20">
            1/{lot.photos.length || 1} Photos
          </div>
        </div>

        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto p-6 md:p-8 space-y-8 bg-white">
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
                {lot.address}, {lot.city}, {lot.state}
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

          {/* Option Selection */}
          <div>
            <h3 className="font-bold text-gray-900 mb-4 text-lg">
              Parking Type
            </h3>

            <div className="border border-brand-orange rounded-xl p-5 bg-orange-50/20 relative">
              <div className="flex justify-between items-start mb-4">
                <div>
                  <h4 className="font-bold text-gray-900 text-lg">
                    {lot.pricing?.parkingTypes[0]?.name || "Standard Parking"}
                  </h4>
                  <p className="text-sm text-gray-500 mt-1">
                    Free cancellation up to 24h before
                  </p>
                </div>
                <div className="text-right">
                  {originalPrice && (
                    <div className="text-sm text-gray-400 line-through font-medium">
                      ${originalPrice}
                    </div>
                  )}
                  <div className="text-2xl font-bold text-gray-900">
                    ${price.toFixed(2)}
                    <span className="text-sm text-gray-500 font-normal">
                      /day
                    </span>
                  </div>
                </div>
              </div>

              {/* Pay at Location Indicator */}
              {lot.dueAtLocation && (
                <div className="flex items-center gap-2 mb-4 p-3 bg-amber-50 border border-amber-200 rounded-lg">
                  <Wallet size={18} className="text-amber-600 flex-shrink-0" />
                  <div className="text-sm">
                    <span className="font-semibold text-amber-800">Pay at Location</span>
                    <span className="text-amber-700"> - Payment collected on-site at check-in</span>
                  </div>
                </div>
              )}

              {/* Dates Input */}
              <div className="bg-white rounded-lg p-4 border border-gray-200 text-sm mb-5 space-y-3 shadow-sm">
                <div className="flex items-center border-b border-gray-50 pb-2">
                  <span className="text-gray-500 font-medium w-24">
                    Check In
                  </span>
                  <div className="flex-1 relative">
                    <input
                      type="date"
                      value={localCheckIn}
                      onChange={(e) => setLocalCheckIn(e.target.value)}
                      className="w-full font-bold text-brand-blue bg-transparent outline-none focus:ring-1 focus:ring-brand-orange rounded px-1 cursor-pointer"
                    />
                  </div>
                </div>
                <div className="flex items-center pt-1">
                  <span className="text-gray-500 font-medium w-24">
                    Check Out
                  </span>
                  <div className="flex-1 relative">
                    <input
                      type="date"
                      value={localCheckOut}
                      onChange={(e) => setLocalCheckOut(e.target.value)}
                      className="w-full font-bold text-brand-blue bg-transparent outline-none focus:ring-1 focus:ring-brand-orange rounded px-1 cursor-pointer"
                    />
                  </div>
                </div>
              </div>

              <button
                onClick={handleReserve}
                className="w-full bg-brand-orange text-white font-bold py-3.5 rounded-lg hover:bg-orange-600 transition-all shadow-md active:scale-[0.98]"
              >
                Reserve Now
              </button>
            </div>
          </div>

          {/* Amenities Section */}
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
              <div className="flex items-center text-gray-700">
                <div className="w-8 h-8 rounded-full bg-gray-50 border border-gray-100 flex items-center justify-center mr-3 shrink-0">
                  <Clock size={14} className="text-brand-orange stroke-[3]" />
                </div>
                <span className="font-medium text-sm">24 Hour Access</span>
              </div>
              <div className="flex items-center text-gray-700">
                <div className="w-8 h-8 rounded-full bg-gray-50 border border-gray-100 flex items-center justify-center mr-3 shrink-0">
                  <Shield size={14} className="text-brand-orange stroke-[3]" />
                </div>
                <span className="font-medium text-sm">Secure Facility</span>
              </div>
            </div>
            <Link
              href={lotDetailUrl}
              className="text-brand-orange font-bold text-sm mt-6 flex items-center hover:underline"
            >
              View full details <ExternalLink size={14} className="ml-1.5" />
            </Link>
          </div>

          {/* Description / Info */}
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
        </div>

        {/* Sticky Mobile Footer */}
        <div className="border-t border-gray-200 p-4 bg-white md:hidden shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.05)]">
          <div className="flex justify-between items-center mb-3">
            <div>
              <span className="text-2xl font-bold text-gray-900">${price}</span>
              <span className="text-sm text-gray-500">/day</span>
            </div>
            <span className="text-green-600 text-xs font-bold bg-green-50 px-2 py-1 rounded">
              Best Price
            </span>
          </div>
          <button
            onClick={handleReserve}
            className="w-full bg-brand-orange text-white font-bold py-3 rounded-lg shadow-md"
          >
            Book Now
          </button>
        </div>
      </div>
    </div>
  );
}
