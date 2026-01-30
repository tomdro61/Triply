"use client";

import { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { Calendar, Shield, Share2, Heart } from "lucide-react";
import { UnifiedLot } from "@/types/lot";

interface BookingWidgetProps {
  lot: UnifiedLot;
  initialCheckIn: string;
  initialCheckOut: string;
}

export function BookingWidget({
  lot,
  initialCheckIn,
  initialCheckOut,
}: BookingWidgetProps) {
  const router = useRouter();
  const [checkIn, setCheckIn] = useState(initialCheckIn);
  const [checkOut, setCheckOut] = useState(initialCheckOut);
  const [isSaved, setIsSaved] = useState(false);

  const price = lot.pricing?.minPrice ?? 0;
  const originalPrice = lot.pricing?.parkingTypes[0]?.originalPrice;

  // Calculate number of days and total
  const { days, subtotal, taxes, total } = useMemo(() => {
    const start = new Date(checkIn);
    const end = new Date(checkOut);
    const diffTime = Math.abs(end.getTime() - start.getTime());
    const diffDays = Math.max(1, Math.ceil(diffTime / (1000 * 60 * 60 * 24)));
    const sub = price * diffDays;
    const tax = Math.round(sub * 0.08 * 100) / 100; // 8% tax estimate
    return {
      days: diffDays,
      subtotal: sub,
      taxes: tax,
      total: sub + tax,
    };
  }, [checkIn, checkOut, price]);

  const savings = originalPrice ? (originalPrice - price) * days : 0;
  const savingsPercent = originalPrice
    ? Math.round(((originalPrice - price) / originalPrice) * 100)
    : 0;

  const handleReserve = () => {
    const params = new URLSearchParams({
      lot: lot.id,
      checkin: checkIn,
      checkout: checkOut,
    });
    router.push(`/checkout?${params.toString()}`);
  };

  const handleShare = async () => {
    if (navigator.share) {
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
      // Fallback: copy to clipboard
      await navigator.clipboard.writeText(window.location.href);
      alert("Link copied to clipboard!");
    }
  };

  return (
    <div className="bg-white rounded-xl shadow-lg border border-gray-200 p-6 sticky top-24">
      {/* Price Header */}
      <div className="flex justify-between items-start mb-6">
        <div>
          <span className="text-3xl font-bold text-gray-900">${price}</span>
          <span className="text-gray-500 font-medium"> / day</span>
        </div>
        {originalPrice && savingsPercent > 0 && (
          <div className="flex flex-col items-end">
            <span className="text-sm text-gray-400 line-through">
              ${originalPrice}
            </span>
            <span className="text-xs font-bold text-green-600 bg-green-50 px-2 py-0.5 rounded">
              Save {savingsPercent}%
            </span>
          </div>
        )}
      </div>

      {/* Date Selection */}
      <div className="space-y-3 mb-6">
        <div className="border border-gray-200 rounded-lg p-3 hover:border-brand-orange transition-colors cursor-pointer focus-within:ring-1 focus-within:ring-brand-orange">
          <label className="block text-xs font-bold text-gray-500 uppercase mb-1">
            Check-in
          </label>
          <div className="flex items-center text-gray-900 font-bold text-sm relative">
            <Calendar
              size={16}
              className="mr-2 text-brand-blue pointer-events-none"
            />
            <input
              type="date"
              value={checkIn}
              onChange={(e) => setCheckIn(e.target.value)}
              className="w-full bg-transparent outline-none cursor-pointer font-bold text-sm"
            />
          </div>
        </div>
        <div className="border border-gray-200 rounded-lg p-3 hover:border-brand-orange transition-colors cursor-pointer focus-within:ring-1 focus-within:ring-brand-orange">
          <label className="block text-xs font-bold text-gray-500 uppercase mb-1">
            Check-out
          </label>
          <div className="flex items-center text-gray-900 font-bold text-sm relative">
            <Calendar
              size={16}
              className="mr-2 text-brand-blue pointer-events-none"
            />
            <input
              type="date"
              value={checkOut}
              onChange={(e) => setCheckOut(e.target.value)}
              className="w-full bg-transparent outline-none cursor-pointer font-bold text-sm"
            />
          </div>
        </div>
      </div>

      {/* Price Breakdown */}
      <div className="bg-gray-50 rounded-lg p-4 mb-6 border border-gray-100">
        <div className="flex justify-between text-sm text-gray-600 mb-2">
          <span>
            ${price} x {days} {days === 1 ? "day" : "days"}
          </span>
          <span>${subtotal.toFixed(2)}</span>
        </div>
        <div className="flex justify-between text-sm text-gray-600 mb-2">
          <span>Taxes & Fees</span>
          <span>${taxes.toFixed(2)}</span>
        </div>
        {savings > 0 && (
          <div className="flex justify-between text-sm text-green-600 mb-2">
            <span>Your Savings</span>
            <span>-${savings.toFixed(2)}</span>
          </div>
        )}
        <div className="border-t border-gray-200 pt-2 flex justify-between font-bold text-gray-900 text-lg">
          <span>Total</span>
          <span>${total.toFixed(2)}</span>
        </div>
      </div>

      {/* Reserve Button */}
      <div className="space-y-3">
        <button
          onClick={handleReserve}
          className="w-full bg-brand-orange text-white font-bold py-3.5 rounded-lg hover:bg-orange-600 transition-all shadow-md active:scale-[0.98]"
        >
          Reserve Now
        </button>
        <div className="flex items-center justify-center text-sm text-gray-500 font-medium">
          <Shield size={14} className="mr-1.5 text-green-500" />
          Free cancellation up to 24h before
        </div>
      </div>

      {/* Share & Save */}
      <div className="mt-6 flex justify-between items-center pt-6 border-t border-gray-100">
        <button
          onClick={handleShare}
          className="flex items-center text-gray-500 hover:text-gray-900 text-sm font-medium transition-colors"
        >
          <Share2 size={16} className="mr-2" /> Share
        </button>
        <button
          onClick={() => setIsSaved(!isSaved)}
          className={`flex items-center text-sm font-medium transition-colors ${
            isSaved
              ? "text-brand-orange"
              : "text-gray-500 hover:text-brand-orange"
          }`}
        >
          <Heart
            size={16}
            className={`mr-2 ${isSaved ? "fill-brand-orange" : ""}`}
          />
          {isSaved ? "Saved" : "Save"}
        </button>
      </div>
    </div>
  );
}
