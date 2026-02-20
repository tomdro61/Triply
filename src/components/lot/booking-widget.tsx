"use client";

import { useState, useMemo, useEffect } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import {
  Shield,
  Share2,
  Clock,
  ChevronDown,
  Wallet,
  AlertCircle,
} from "lucide-react";
import { DatePicker } from "@/components/ui/date-picker";
import { UnifiedLot } from "@/types/lot";
import { trackLotView } from "@/lib/analytics/gtag";

interface BookingWidgetProps {
  lot: UnifiedLot;
  initialCheckIn: string;
  initialCheckOut: string;
  initialCheckInTime?: string;
  initialCheckOutTime?: string;
}

const timeOptions = [
  "12:00 AM",
  "12:30 AM",
  "1:00 AM",
  "1:30 AM",
  "2:00 AM",
  "2:30 AM",
  "3:00 AM",
  "3:30 AM",
  "4:00 AM",
  "4:30 AM",
  "5:00 AM",
  "5:30 AM",
  "6:00 AM",
  "6:30 AM",
  "7:00 AM",
  "7:30 AM",
  "8:00 AM",
  "8:30 AM",
  "9:00 AM",
  "9:30 AM",
  "10:00 AM",
  "10:30 AM",
  "11:00 AM",
  "11:30 AM",
  "12:00 PM",
  "12:30 PM",
  "1:00 PM",
  "1:30 PM",
  "2:00 PM",
  "2:30 PM",
  "3:00 PM",
  "3:30 PM",
  "4:00 PM",
  "4:30 PM",
  "5:00 PM",
  "5:30 PM",
  "6:00 PM",
  "6:30 PM",
  "7:00 PM",
  "7:30 PM",
  "8:00 PM",
  "8:30 PM",
  "9:00 PM",
  "9:30 PM",
  "10:00 PM",
  "10:30 PM",
  "11:00 PM",
  "11:30 PM",
];

export function BookingWidget({
  lot,
  initialCheckIn,
  initialCheckOut,
  initialCheckInTime = "10:00 AM",
  initialCheckOutTime = "2:00 PM",
}: BookingWidgetProps) {
  const router = useRouter();

  useEffect(() => {
    trackLotView({ id: lot.id, name: lot.name, price: lot.pricing?.minPrice });
  }, [lot.id, lot.name, lot.pricing?.minPrice]);

  const [checkIn, setCheckIn] = useState(initialCheckIn);
  const [checkOut, setCheckOut] = useState(initialCheckOut);
  const [checkInTime, setCheckInTime] = useState(initialCheckInTime);
  const [checkOutTime, setCheckOutTime] = useState(initialCheckOutTime);

  // Use API pricing if available
  const hasApiPricing = lot.pricing?.grandTotal !== undefined;
  const price = lot.pricing?.minPrice ?? 0;

  // Calculate number of days and total
  const { days, subtotal, fees, taxes, total } = useMemo(() => {
    const start = new Date(checkIn);
    const end = new Date(checkOut);
    const diffTime = Math.abs(end.getTime() - start.getTime());
    const diffDays = Math.max(1, Math.ceil(diffTime / (1000 * 60 * 60 * 24)));

    // Use API values if available
    if (hasApiPricing) {
      return {
        days: lot.pricing?.numberOfDays || diffDays,
        subtotal: lot.pricing?.subtotal || price * diffDays,
        fees: lot.pricing?.feesTotal || 0,
        taxes: lot.pricing?.taxTotal || 0,
        total: lot.pricing?.grandTotal || price * diffDays,
      };
    }

    // Fallback calculation
    const sub = price * diffDays;
    const tax = Math.round(sub * (lot.pricing?.taxValue || 8) / 100 * 100) / 100;
    return {
      days: diffDays,
      subtotal: sub,
      fees: 0,
      taxes: tax,
      total: sub + tax,
    };
  }, [checkIn, checkOut, price, hasApiPricing, lot.pricing]);

  // Get cancellation policy text
  const cancellationText = lot.cancellationPolicies?.[0]
    ? lot.cancellationPolicies[0].percentage === 100
      ? "Full refund if cancelled"
      : `${lot.cancellationPolicies[0].percentage}% refund if cancelled`
    : "Free cancellation up to 24h before";

  const handleReserve = () => {
    const params = new URLSearchParams({
      lot: lot.id,
      checkin: checkIn,
      checkout: checkOut,
      checkinTime: checkInTime,
      checkoutTime: checkOutTime,
    });
    router.push(`/checkout?${params.toString()}`);
  };

  const [copied, setCopied] = useState(false);

  const handleShare = async () => {
    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
    if (isMobile && navigator.share) {
      try {
        await navigator.share({
          title: lot.name,
          text: `Check out ${lot.name} for airport parking!`,
          url: window.location.href,
        });
      } catch {
        // User cancelled or error
      }
    } else {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  return (
    <>
    {/* Mobile-only Sticky Footer — rendered via portal to escape parent stacking context */}
    {mounted && createPortal(
      <div
        className="lg:hidden"
        style={{
          position: "fixed",
          bottom: 0,
          left: 0,
          right: 0,
          zIndex: 9998,
          borderTop: "1px solid #e5e7eb",
          padding: "12px 16px",
          backgroundColor: "white",
          boxShadow: "0 -4px 6px -1px rgba(0,0,0,0.05)",
        }}
      >
      <div style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 16,
        }}>
        <div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
            <span style={{ fontSize: 20, fontWeight: 700, color: "#111827" }}>${price.toFixed(2)}</span>
            <span style={{ fontSize: 14, color: "#6b7280" }}>/day</span>
          </div>
          <span style={{ fontSize: 12, color: "#6b7280" }}>${total.toFixed(2)} total</span>
        </div>
        <button
          onClick={handleReserve}
          disabled={lot.minimumBookingDays ? days < lot.minimumBookingDays : false}
          className="bg-brand-orange text-white font-bold py-2.5 px-6 rounded-lg shadow-md hover:bg-orange-600 transition-all active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Reserve Now
        </button>
      </div>
      </div>,
      document.body
    )}

    <div className="bg-white rounded-xl shadow-lg border border-gray-200 p-6 sticky top-24">
      {/* Price Header */}
      <div className="mb-6">
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

      {/* Minimum Booking Days Warning */}
      {lot.minimumBookingDays && lot.minimumBookingDays > 1 && days < lot.minimumBookingDays && (
        <div className="flex items-start gap-2 mb-4 p-3 bg-red-50 border border-red-200 rounded-lg">
          <AlertCircle size={18} className="text-red-600 flex-shrink-0 mt-0.5" />
          <div className="text-sm">
            <span className="font-semibold text-red-800">Minimum {lot.minimumBookingDays} days required</span>
            <p className="text-red-700 text-xs mt-0.5">
              Please select at least {lot.minimumBookingDays} days for this location
            </p>
          </div>
        </div>
      )}

      {/* Date Selection */}
      <div className="space-y-3 mb-6">
        {/* Check-in Date & Time */}
        <div className="border border-gray-200 rounded-lg p-3 hover:border-brand-orange transition-colors">
          <label className="block text-xs font-bold text-gray-500 uppercase mb-1">
            Check-in
          </label>
          <div className="flex items-center gap-2">
            <div className="flex-1">
              <DatePicker
                value={checkIn}
                onChange={setCheckIn}
                placeholder="Check-in date"
                minDate={new Date()}
                className="text-sm font-bold"
              />
            </div>
            <div className="relative w-28">
              <Clock size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400" />
              <select
                value={checkInTime}
                onChange={(e) => setCheckInTime(e.target.value)}
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
        <div className="border border-gray-200 rounded-lg p-3 hover:border-brand-orange transition-colors">
          <label className="block text-xs font-bold text-gray-500 uppercase mb-1">
            Check-out
          </label>
          <div className="flex items-center gap-2">
            <div className="flex-1">
              <DatePicker
                value={checkOut}
                onChange={setCheckOut}
                placeholder="Check-out date"
                minDate={new Date()}
                className="text-sm font-bold"
              />
            </div>
            <div className="relative w-28">
              <Clock size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400" />
              <select
                value={checkOutTime}
                onChange={(e) => setCheckOutTime(e.target.value)}
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
      <div className="bg-gray-50 rounded-lg p-4 mb-6 border border-gray-100">
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

      {/* Reserve Button — hidden on mobile, sticky footer handles it */}
      <div className="hidden lg:block space-y-3">
        <button
          onClick={handleReserve}
          disabled={lot.minimumBookingDays ? days < lot.minimumBookingDays : false}
          className="w-full bg-brand-orange text-white font-bold py-3.5 rounded-lg hover:bg-orange-600 transition-all shadow-md active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-brand-orange"
        >
          Reserve Now
        </button>
        <div className="flex items-center justify-center text-sm text-gray-500 font-medium">
          <Shield size={14} className="mr-1.5 text-green-500" />
          {cancellationText}
        </div>
      </div>

      {/* Share */}
      <div className="mt-6 pt-6 border-t border-gray-100">
        <button
          onClick={handleShare}
          className="flex items-center text-gray-500 hover:text-gray-900 text-sm font-medium transition-colors"
        >
          <Share2 size={16} className="mr-2" /> {copied ? "Copied!" : "Share"}
        </button>
      </div>
    </div>
    </>
  );
}
