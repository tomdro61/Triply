"use client";

import Link from "next/link";
import { MapPin, ExternalLink, Car } from "lucide-react";

interface ParkingLot {
  name: string;
  pricePerDay: string;
  totalPrice: string;
  distance: string;
  amenities: string;
  slug: string;
  numberOfDays?: number;
  searchUrl: string;
}

interface ChatParkingResultsProps {
  result: Record<string, unknown>;
}

export function ChatParkingResults({ result }: ChatParkingResultsProps) {
  const lots = (result.lots as ParkingLot[]) || [];
  const totalResults = (result.totalResults as number) || 0;
  const searchUrl = lots[0]?.searchUrl || "/search";

  if (!result.success || lots.length === 0) {
    return (
      <div className="text-xs text-gray-400 italic px-1">
        No parking results found
      </div>
    );
  }

  return (
    <div className="space-y-1.5 w-full">
      {lots.map((lot, index) => (
        <div
          key={index}
          className="bg-white border border-gray-200 rounded-lg p-2.5 text-xs hover:border-brand-orange/50 transition-colors"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-gray-900 truncate">{lot.name}</p>
              <div className="flex items-center gap-2 text-gray-500 mt-0.5">
                <span className="flex items-center gap-0.5">
                  <MapPin size={10} />
                  {lot.distance}
                </span>
                {lot.amenities && (
                  <span className="truncate">{lot.amenities}</span>
                )}
              </div>
            </div>
            <div className="text-right flex-shrink-0">
              <p className="font-bold text-brand-orange">{lot.pricePerDay}</p>
              <p className="text-gray-400">/day</p>
            </div>
          </div>

          {lot.totalPrice !== "N/A" && lot.numberOfDays && (
            <p className="text-gray-500 mt-1">
              Total: {lot.totalPrice} ({lot.numberOfDays} days)
            </p>
          )}
        </div>
      ))}

      {/* View full search link */}
      {totalResults > 0 && (
        <Link
          href={searchUrl}
          className="flex items-center justify-center gap-1.5 text-xs text-brand-orange font-medium py-1.5 hover:underline"
        >
          <Car size={12} />
          View all {totalResults} results
          <ExternalLink size={10} />
        </Link>
      )}
    </div>
  );
}
