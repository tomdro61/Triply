"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { MapPin, Star, Check, ChevronRight, Loader2 } from "lucide-react";
import { UnifiedLot } from "@/types/lot";

interface FeaturedParkingProps {
  defaultAirport?: string;
}

// Using test locations until production inventory is available
// Display names are user-friendly, codes map to ResLab test locations
const airports = [
  { code: "TEST-NY", name: "New York", displayCode: "JFK", slug: "beacon-test" },
  { code: "TEST-OH", name: "Cincinnati", displayCode: "CVG", slug: "cincinnati-test" },
];

// Simulated ratings since ResLab doesn't provide them
// In production, this would come from a reviews system
function getSimulatedRating(lotId: string): { rating: number; count: number } {
  // Use lot ID to generate consistent pseudo-random rating
  const hash = lotId.split("").reduce((a, b) => {
    a = (a << 5) - a + b.charCodeAt(0);
    return a & a;
  }, 0);
  const rating = 4.2 + (Math.abs(hash) % 8) / 10; // 4.2 - 4.9
  const count = 500 + (Math.abs(hash) % 3000); // 500 - 3500
  return { rating: Math.round(rating * 10) / 10, count };
}

// Get top amenities to display
function getTopAmenities(lot: UnifiedLot): string[] {
  const amenityNames = lot.amenities.map((a) => a.displayName || a.name);

  // Prioritize certain amenities
  const priorityAmenities = [
    "Free Shuttle",
    "Shuttle",
    "24/7 Security",
    "Security",
    "Covered Parking",
    "Covered",
    "Valet",
    "EV Charging",
    "Handicap Accessible",
  ];

  const sorted = amenityNames.sort((a, b) => {
    const aIndex = priorityAmenities.findIndex((p) =>
      a.toLowerCase().includes(p.toLowerCase())
    );
    const bIndex = priorityAmenities.findIndex((p) =>
      b.toLowerCase().includes(p.toLowerCase())
    );
    if (aIndex === -1 && bIndex === -1) return 0;
    if (aIndex === -1) return 1;
    if (bIndex === -1) return -1;
    return aIndex - bIndex;
  });

  return sorted.slice(0, 3);
}


export function FeaturedParking({ defaultAirport = "TEST-NY" }: FeaturedParkingProps) {
  const [selectedAirport, setSelectedAirport] = useState(defaultAirport);
  const selectedAirportInfo = airports.find((a) => a.code === selectedAirport) || airports[0];
  const [lots, setLots] = useState<UnifiedLot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Get default dates (tomorrow + 7 days)
  // Note: ResLab requires advance booking, so we use tomorrow, not today
  const getDefaultDates = () => {
    const checkin = new Date();
    checkin.setDate(checkin.getDate() + 1); // Tomorrow
    const checkout = new Date();
    checkout.setDate(checkout.getDate() + 8); // Tomorrow + 7 days
    return {
      checkin: checkin.toISOString().split("T")[0],
      checkout: checkout.toISOString().split("T")[0],
    };
  };

  useEffect(() => {
    async function fetchLots() {
      setLoading(true);
      setError(null);

      const { checkin, checkout } = getDefaultDates();

      try {
        const response = await fetch(
          `/api/search?airport=${selectedAirport}&checkin=${checkin}&checkout=${checkout}&sort=popularity`
        );

        if (!response.ok) {
          throw new Error("Failed to fetch parking options");
        }

        const data = await response.json();
        setLots(data.results?.slice(0, 4) || []);
      } catch (err) {
        console.error("Error fetching featured parking:", err);
        setError("Unable to load parking options");
        setLots([]);
      } finally {
        setLoading(false);
      }
    }

    fetchLots();
  }, [selectedAirport]);

  const { checkin, checkout } = getDefaultDates();

  return (
    <section className="py-16 lg:py-20 bg-gray-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between mb-8">
          <div>
            <h2 className="text-2xl md:text-3xl font-bold text-gray-900 mb-2">
              Featured Parking Options
            </h2>
            <p className="text-gray-500">
              Top-rated lots with the best prices
            </p>
          </div>

          {/* Airport Tabs */}
          <div className="flex items-center gap-2 mt-4 sm:mt-0">
            {airports.map((airport) => (
              <button
                key={airport.code}
                onClick={() => setSelectedAirport(airport.code)}
                className={`px-5 py-2.5 rounded-full text-sm font-medium transition-all ${
                  selectedAirport === airport.code
                    ? "bg-brand-orange text-white shadow-md"
                    : "bg-white text-gray-600 hover:bg-gray-100 border border-gray-200"
                }`}
              >
                {airport.name}
              </button>
            ))}
          </div>
        </div>

        {/* View All Link */}
        <div className="flex justify-end mb-6">
          <Link
            href={`/search?airport=${selectedAirport}&checkin=${checkin}&checkout=${checkout}`}
            className="text-brand-orange hover:text-brand-orange/80 font-medium text-sm flex items-center gap-1"
          >
            View All Parking Options
            <ChevronRight size={16} />
          </Link>
        </div>

        {/* Loading State */}
        {loading && (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-8 h-8 text-brand-orange animate-spin" />
          </div>
        )}

        {/* Error State */}
        {error && !loading && (
          <div className="text-center py-20 text-gray-500">
            {error}
          </div>
        )}

        {/* Parking Cards Grid */}
        {!loading && !error && lots.length > 0 && (
          <div className="flex gap-4 overflow-x-auto snap-x snap-mandatory pb-4 -mx-4 px-4 sm:mx-0 sm:px-0 sm:grid sm:grid-cols-2 lg:grid-cols-4 sm:gap-6 sm:overflow-visible sm:pb-0 no-scrollbar">
            {lots.map((lot) => {
              const { rating, count } = getSimulatedRating(lot.id);
              const amenities = getTopAmenities(lot);

              return (
                <div
                  key={lot.id}
                  className="min-w-[280px] snap-start sm:min-w-0 bg-white rounded-xl overflow-hidden shadow-sm hover:shadow-lg transition-shadow border border-gray-100 group"
                >
                  {/* Image */}
                  <div className="relative h-44 overflow-hidden">
                    <Image
                      src={lot.photos[0]?.url || "/placeholder-parking.jpg"}
                      alt={lot.name}
                      fill
                      className="object-cover group-hover:scale-105 transition-transform duration-500"
                    />

                    {/* Rating Badge */}
                    <div className="absolute top-3 right-3">
                      <div className="bg-white/95 backdrop-blur-sm rounded-md px-2 py-1 flex items-center gap-1 shadow">
                        <Star size={14} className="text-yellow-400 fill-yellow-400" />
                        <span className="text-sm font-bold text-gray-900">{rating}</span>
                        <span className="text-xs text-gray-500">({count.toLocaleString()})</span>
                      </div>
                    </div>
                  </div>

                  {/* Content */}
                  <div className="p-4">
                    {/* Name */}
                    <h3 className="font-bold text-gray-900 mb-1 truncate group-hover:text-brand-orange transition-colors">
                      {lot.name}
                    </h3>

                    {/* Distance */}
                    <div className="flex items-center text-gray-500 text-sm mb-3">
                      <MapPin size={14} className="mr-1 text-brand-orange" />
                      {lot.distanceFromAirport !== undefined
                        ? `${lot.distanceFromAirport} mi to ${selectedAirportInfo.displayCode}`
                        : lot.address}
                    </div>

                    {/* Amenities */}
                    {amenities.length > 0 && (
                      <div className="space-y-1.5 mb-4">
                        {amenities.map((amenity, idx) => (
                          <div key={idx} className="flex items-center text-sm text-gray-600">
                            <Check size={14} className="mr-2 text-green-500 flex-shrink-0" />
                            <span className="truncate">{amenity}</span>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Fallback if no amenities */}
                    {amenities.length === 0 && (
                      <div className="h-[72px] flex items-center justify-center text-gray-400 text-sm">
                        Contact for amenities
                      </div>
                    )}

                    {/* Price & CTA */}
                    <div className="flex items-end justify-between pt-3 border-t border-gray-100">
                      <div className="flex items-baseline">
                        <span className="text-2xl font-bold text-gray-900">
                          ${lot.pricing?.minPrice?.toFixed(0) || "--"}
                        </span>
                        <span className="text-gray-500 text-sm ml-1">/day</span>
                      </div>

                      <Link
                        href={`/${selectedAirportInfo.slug}/airport-parking/${lot.sourceId}`}
                        className="px-4 py-2 text-sm font-medium text-brand-orange border border-brand-orange rounded-lg hover:bg-brand-orange hover:text-white transition-colors"
                      >
                        Details
                      </Link>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Empty State */}
        {!loading && !error && lots.length === 0 && (
          <div className="text-center py-20 text-gray-500">
            No parking options available for {selectedAirportInfo.name}
          </div>
        )}
      </div>
    </section>
  );
}
