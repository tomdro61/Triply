"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { MapPin, Star, Loader2, ChevronRight } from "lucide-react";
import { ScrollReveal } from "./scroll-reveal";
import { UnifiedLot } from "@/types/lot";

const airports = [
  { code: "TEST-NY", name: "New York", displayCode: "JFK", slug: "beacon-test" },
  { code: "TEST-OH", name: "Cincinnati", displayCode: "CVG", slug: "cincinnati-test" },
];

function getSimulatedRating(lotId: string): { rating: number; count: number } {
  const hash = lotId.split("").reduce((a, b) => {
    a = (a << 5) - a + b.charCodeAt(0);
    return a & a;
  }, 0);
  const rating = 4.2 + (Math.abs(hash) % 8) / 10;
  const count = 500 + (Math.abs(hash) % 3000);
  return { rating: Math.round(rating * 10) / 10, count };
}

function getTopAmenities(lot: UnifiedLot): string[] {
  const amenityNames = lot.amenities.map((a) => a.displayName || a.name);
  const priorityAmenities = [
    "Free Shuttle", "Shuttle", "24/7 Security", "Security",
    "Covered Parking", "Covered", "Valet", "EV Charging",
  ];
  const sorted = amenityNames.sort((a, b) => {
    const aIndex = priorityAmenities.findIndex((p) => a.toLowerCase().includes(p.toLowerCase()));
    const bIndex = priorityAmenities.findIndex((p) => b.toLowerCase().includes(p.toLowerCase()));
    if (aIndex === -1 && bIndex === -1) return 0;
    if (aIndex === -1) return 1;
    if (bIndex === -1) return -1;
    return aIndex - bIndex;
  });
  return sorted.slice(0, 3);
}

export function FeaturedParkingRedesign() {
  const [selectedAirport, setSelectedAirport] = useState("TEST-NY");
  const selectedAirportInfo = airports.find((a) => a.code === selectedAirport) || airports[0];
  const [lots, setLots] = useState<UnifiedLot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const getDefaultDates = () => {
    const checkin = new Date();
    checkin.setDate(checkin.getDate() + 1);
    const checkout = new Date();
    checkout.setDate(checkout.getDate() + 8);
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
        if (!response.ok) throw new Error("Failed to fetch parking options");
        const data = await response.json();
        setLots(data.results?.slice(0, 3) || []);
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
    <section className="py-16 lg:py-20 bg-white">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between mb-10">
          <ScrollReveal>
            <p className="text-brand-orange font-bold text-sm uppercase tracking-wider mb-3">
              Featured Lots
            </p>
            <h2 className="text-3xl md:text-4xl font-bold text-gray-900">
              Top-Rated Parking
            </h2>
          </ScrollReveal>

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

        {/* Loading */}
        {loading && (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-8 h-8 text-brand-orange animate-spin" />
          </div>
        )}

        {/* Error */}
        {error && !loading && (
          <div className="text-center py-20 text-gray-500">{error}</div>
        )}

        {/* Cards */}
        {!loading && !error && lots.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
            {lots.map((lot, index) => {
              const { rating, count } = getSimulatedRating(lot.id);
              const amenities = getTopAmenities(lot);
              return (
                <ScrollReveal key={lot.id} delay={index * 0.1}>
                  <div className="bg-white rounded-2xl overflow-hidden shadow-sm hover:shadow-xl transition-all duration-300 group border border-gray-100 hover:-translate-y-1">
                    {/* Image */}
                    <div className="relative h-52 overflow-hidden">
                      <Image
                        src={lot.photos[0]?.url || "/placeholder-parking.jpg"}
                        alt={lot.name}
                        fill
                        className="object-cover group-hover:scale-105 transition-transform duration-500"
                      />
                      <div className="absolute inset-0 bg-gradient-to-t from-black/50 via-transparent to-transparent" />

                      {/* Price badge on image */}
                      <div className="absolute bottom-4 left-4 bg-white/95 backdrop-blur-sm rounded-lg px-3 py-1.5 shadow-md">
                        <span className="text-xl font-bold text-gray-900">
                          ${lot.pricing?.minPrice?.toFixed(0) || "--"}
                        </span>
                        <span className="text-sm text-gray-500 ml-1">/day</span>
                      </div>

                      {/* Rating badge */}
                      <div className="absolute top-3 right-3 bg-white/95 backdrop-blur-sm rounded-md px-2 py-1 flex items-center gap-1 shadow">
                        <Star size={14} className="text-yellow-400 fill-yellow-400" />
                        <span className="text-sm font-bold text-gray-900">{rating}</span>
                        <span className="text-xs text-gray-500">({count.toLocaleString()})</span>
                      </div>
                    </div>

                    {/* Content */}
                    <div className="p-5">
                      <h3 className="text-lg font-bold text-gray-900 group-hover:text-brand-orange transition-colors truncate">
                        {lot.name}
                      </h3>
                      <div className="flex items-center text-gray-500 text-sm mt-1.5 mb-3">
                        <MapPin size={14} className="mr-1 text-brand-orange flex-shrink-0" />
                        {lot.distanceFromAirport !== undefined
                          ? `${lot.distanceFromAirport} mi to ${selectedAirportInfo.displayCode}`
                          : lot.address}
                      </div>

                      {/* Amenity pills */}
                      {amenities.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 mb-4">
                          {amenities.map((amenity, idx) => (
                            <span key={idx} className="bg-gray-100 text-gray-600 text-xs px-2.5 py-1 rounded-full">
                              {amenity}
                            </span>
                          ))}
                        </div>
                      )}

                      {/* CTA */}
                      <Link
                        href={`/${selectedAirportInfo.slug}/airport-parking/${lot.sourceId}`}
                        className="mt-2 block text-center bg-brand-orange text-white py-2.5 rounded-xl font-medium text-sm hover:bg-brand-orange/90 transition-colors"
                      >
                        View Details
                      </Link>
                    </div>
                  </div>
                </ScrollReveal>
              );
            })}
          </div>
        )}

        {/* View All */}
        {!loading && !error && lots.length > 0 && (
          <div className="mt-10 text-center">
            <Link
              href={`/search?airport=${selectedAirport}&checkin=${checkin}&checkout=${checkout}`}
              className="inline-flex items-center gap-1 text-brand-orange hover:text-brand-orange/80 font-medium text-sm transition-colors"
            >
              View All Parking Options
              <ChevronRight size={16} />
            </Link>
          </div>
        )}

        {/* Empty */}
        {!loading && !error && lots.length === 0 && (
          <div className="text-center py-20 text-gray-500">
            No parking options available for {selectedAirportInfo.name}
          </div>
        )}
      </div>
    </section>
  );
}
