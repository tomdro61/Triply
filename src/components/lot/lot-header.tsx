"use client";

import Link from "next/link";
import { ChevronLeft, Star, MapPin } from "lucide-react";
import { UnifiedLot } from "@/types/lot";

interface LotHeaderProps {
  lot: UnifiedLot;
  backUrl: string;
}

export function LotHeader({ lot, backUrl }: LotHeaderProps) {
  return (
    <div className="bg-white border-b border-gray-200">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
        <Link
          href={backUrl}
          className="flex items-center text-gray-600 hover:text-brand-orange transition-colors font-medium text-sm mb-4"
        >
          <ChevronLeft size={18} className="mr-1" />
          Back to Search
        </Link>

        <h1 className="text-3xl font-bold text-gray-900 mb-2">{lot.name}</h1>
        <div className="flex flex-wrap items-center gap-4 text-sm text-gray-600">
          <div className="flex items-center text-brand-blue">
            <MapPin size={16} className="mr-1" />
            {lot.distanceFromAirport !== undefined
              ? `${lot.distanceFromAirport.toFixed(1)} mi from airport`
              : `${lot.address}, ${lot.city}, ${lot.state}`}
          </div>
          {lot.rating && (
            <div className="flex items-center">
              <Star size={16} className="text-yellow-400 fill-yellow-400 mr-1" />
              <span className="font-bold text-gray-900 mr-1">
                {lot.rating.toFixed(1)}
              </span>
              <span className="text-gray-500">
                ({lot.reviewCount || 0} reviews)
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
