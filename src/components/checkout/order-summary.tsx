"use client";

import Image from "next/image";
import { Calendar, MapPin, Star, Shield, Clock } from "lucide-react";
import { UnifiedLot } from "@/types/lot";
import { PriceBreakdown } from "@/types/checkout";
import { PromoCode } from "./promo-code";

interface OrderSummaryProps {
  lot: UnifiedLot;
  checkIn: string;
  checkOut: string;
  priceBreakdown: PriceBreakdown;
  promoCode: string | null;
  onApplyPromo: (code: string) => Promise<boolean>;
  onRemovePromo: () => void;
}

export function OrderSummary({
  lot,
  checkIn,
  checkOut,
  priceBreakdown,
  promoCode,
  onApplyPromo,
  onRemovePromo,
}: OrderSummaryProps) {
  const mainImage = lot.photos[0]?.url || "/placeholder-lot.jpg";

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr + "T00:00:00");
    return date.toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  };

  return (
    <div className="bg-white rounded-xl shadow-lg border border-gray-200 overflow-hidden sticky top-24">
      {/* Lot Image */}
      <div className="relative h-40">
        <Image
          src={mainImage}
          alt={lot.name}
          fill
          className="object-cover"
          sizes="400px"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent" />
        <div className="absolute bottom-3 left-3 right-3">
          <h3 className="text-white font-bold text-lg leading-tight">
            {lot.name}
          </h3>
          <div className="flex items-center gap-2 mt-1">
            {lot.rating && (
              <div className="flex items-center bg-white/20 backdrop-blur px-2 py-0.5 rounded text-white text-xs">
                <Star size={12} className="fill-yellow-400 text-yellow-400 mr-1" />
                {lot.rating.toFixed(1)}
              </div>
            )}
            <div className="flex items-center text-white/90 text-xs">
              <MapPin size={12} className="mr-1" />
              {lot.distanceFromAirport?.toFixed(1)} mi from airport
            </div>
          </div>
        </div>
      </div>

      {/* Booking Details */}
      <div className="p-4 border-b border-gray-100">
        <h4 className="font-semibold text-gray-900 mb-3">Booking Details</h4>
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-gray-100 rounded-lg flex items-center justify-center">
              <Calendar size={18} className="text-brand-orange" />
            </div>
            <div>
              <p className="text-xs text-gray-500">Check-in</p>
              <p className="font-medium text-gray-900">{formatDate(checkIn)}</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-gray-100 rounded-lg flex items-center justify-center">
              <Calendar size={18} className="text-brand-orange" />
            </div>
            <div>
              <p className="text-xs text-gray-500">Check-out</p>
              <p className="font-medium text-gray-900">{formatDate(checkOut)}</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-gray-100 rounded-lg flex items-center justify-center">
              <Clock size={18} className="text-brand-orange" />
            </div>
            <div>
              <p className="text-xs text-gray-500">Duration</p>
              <p className="font-medium text-gray-900">
                {priceBreakdown.days} {priceBreakdown.days === 1 ? "day" : "days"}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Promo Code */}
      <div className="p-4 border-b border-gray-100">
        <h4 className="font-semibold text-gray-900 mb-3">Promo Code</h4>
        <PromoCode
          appliedCode={promoCode}
          discount={priceBreakdown.discount}
          onApply={onApplyPromo}
          onRemove={onRemovePromo}
        />
      </div>

      {/* Price Breakdown */}
      <div className="p-4">
        <h4 className="font-semibold text-gray-900 mb-3">Price Summary</h4>
        <div className="space-y-2">
          <div className="flex justify-between text-sm">
            <span className="text-gray-600">
              ${priceBreakdown.dailyRate.toFixed(2)} x {priceBreakdown.days}{" "}
              {priceBreakdown.days === 1 ? "day" : "days"}
            </span>
            <span className="text-gray-900">
              ${priceBreakdown.subtotal.toFixed(2)}
            </span>
          </div>
          {priceBreakdown.discount > 0 && (
            <div className="flex justify-between text-sm text-green-600">
              <span>Promo Discount</span>
              <span>-${priceBreakdown.discount.toFixed(2)}</span>
            </div>
          )}
          <div className="flex justify-between text-sm">
            <span className="text-gray-600">Taxes & Fees</span>
            <span className="text-gray-900">
              ${priceBreakdown.taxes.toFixed(2)}
            </span>
          </div>
          <div className="border-t border-gray-200 pt-2 mt-2">
            <div className="flex justify-between">
              <span className="font-bold text-gray-900">Total</span>
              <span className="font-bold text-gray-900 text-xl">
                ${priceBreakdown.total.toFixed(2)}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Trust Badges */}
      <div className="px-4 pb-4">
        <div className="bg-green-50 rounded-lg p-3 flex items-center gap-2">
          <Shield size={18} className="text-green-600" />
          <div className="text-sm">
            <p className="font-medium text-green-800">Free Cancellation</p>
            <p className="text-green-600 text-xs">Up to 24 hours before check-in</p>
          </div>
        </div>
      </div>
    </div>
  );
}
