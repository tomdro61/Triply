"use client";

import { useState, useEffect, useMemo, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { Navbar } from "@/components/shared";
import {
  SearchHeader,
  SearchResultsList,
  SearchMap,
  ProductDetailSlider,
  type SearchTab,
} from "@/components/search";
import { UnifiedLot, SortOption } from "@/types/lot";
import { getAirportByCode } from "@/config/airports";
import { trackSearch } from "@/lib/analytics/gtag";

function SearchPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // Get initial values from URL params
  const initialAirport = searchParams.get("airport") || "TEST-NY"; // Default to test location
  const initialCheckin =
    searchParams.get("checkin") ||
    new Date().toISOString().split("T")[0];
  const initialCheckout =
    searchParams.get("checkout") ||
    new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
  const initialCheckinTime = searchParams.get("checkinTime") || "10:00 AM";
  const initialCheckoutTime = searchParams.get("checkoutTime") || "2:00 PM";

  // State
  const [tab, setTab] = useState<SearchTab>("parking");
  const [airport, setAirport] = useState(initialAirport);
  const [departDate, setDepartDate] = useState(initialCheckin);
  const [returnDate, setReturnDate] = useState(initialCheckout);
  const [departTime, setDepartTime] = useState(initialCheckinTime);
  const [returnTime, setReturnTime] = useState(initialCheckoutTime);
  const [sortBy, setSortBy] = useState<SortOption>("popularity");
  const [lots, setLots] = useState<UnifiedLot[]>([]);
  const [loading, setLoading] = useState(true);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [selectedLot, setSelectedLot] = useState<UnifiedLot | null>(null);

  const airportInfo = getAirportByCode(airport);
  const locationName = airportInfo?.city || "New York";

  // Fetch search results
  const fetchResults = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        airport,
        checkin: departDate,
        checkout: returnDate,
        checkinTime: departTime,
        checkoutTime: returnTime,
        sort: sortBy,
      });
      const response = await fetch(`/api/search?${params.toString()}`);
      const data = await response.json();
      if (data.error) {
        console.error("Search API error:", data.error);
        setLots([]);
      } else {
        setLots(data.results || []);
        trackSearch({ airport, checkin: departDate, checkout: returnDate });
      }
    } catch (error) {
      console.error("Error fetching search results:", error);
      setLots([]);
    } finally {
      setLoading(false);
    }
  };

  // Initial fetch
  useEffect(() => {
    fetchResults();
  }, []);

  // Re-fetch when sort changes
  useEffect(() => {
    if (!loading) {
      fetchResults();
    }
  }, [sortBy]);

  // Sort lots client-side for instant feedback
  const sortedLots = useMemo(() => {
    const sorted = [...lots];
    switch (sortBy) {
      case "price_asc":
        sorted.sort(
          (a, b) => (a.pricing?.minPrice ?? 0) - (b.pricing?.minPrice ?? 0)
        );
        break;
      case "price_desc":
        sorted.sort(
          (a, b) => (b.pricing?.minPrice ?? 0) - (a.pricing?.minPrice ?? 0)
        );
        break;
      case "rating":
        sorted.sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
        break;
      case "distance":
        sorted.sort(
          (a, b) =>
            (a.distanceFromAirport ?? 999) - (b.distanceFromAirport ?? 999)
        );
        break;
      default:
        break;
    }
    return sorted;
  }, [lots, sortBy]);

  const handleSearch = () => {
    // Update URL params
    const params = new URLSearchParams({
      airport,
      checkin: departDate,
      checkout: returnDate,
      checkinTime: departTime,
      checkoutTime: returnTime,
    });
    router.push(`/search?${params.toString()}`);
    fetchResults();
  };

  return (
    <div className="bg-white h-screen flex flex-col">
      <Navbar forceSolid />

      {/* Add padding for navbar */}
      <div className="pt-20 flex flex-col flex-1 overflow-hidden">
        <SearchHeader
          tab={tab}
          onTabChange={setTab}
          airport={airport}
          onAirportChange={setAirport}
          departDate={departDate}
          onDepartDateChange={setDepartDate}
          returnDate={returnDate}
          onReturnDateChange={setReturnDate}
          departTime={departTime}
          onDepartTimeChange={setDepartTime}
          returnTime={returnTime}
          onReturnTimeChange={setReturnTime}
          onSearch={handleSearch}
        />

        {/* Split View Content */}
        <div className="flex-1 flex overflow-hidden relative">
          {loading ? (
            <div className="w-full lg:w-2/5 h-full flex items-center justify-center bg-gray-50">
              <div className="text-center">
                <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-brand-orange mx-auto mb-4" />
                <p className="text-gray-500">Searching for parking...</p>
              </div>
            </div>
          ) : (
            <SearchResultsList
              lots={sortedLots}
              tab={tab}
              location={locationName}
              sortBy={sortBy}
              onSortChange={setSortBy}
              hoveredId={hoveredId}
              onHover={setHoveredId}
              onSelect={setSelectedLot}
            />
          )}

          {/* Right: Map */}
          <div className="hidden lg:block w-3/5 h-full relative border-l border-gray-200">
            <SearchMap
              lots={sortedLots}
              hoveredId={hoveredId}
              onHover={setHoveredId}
              onSelect={setSelectedLot}
            />
          </div>
        </div>
      </div>

      {/* Slide-out Product Detail */}
      {selectedLot && (
        <ProductDetailSlider
          lot={selectedLot}
          checkIn={departDate}
          checkOut={returnDate}
          checkInTime={departTime}
          checkOutTime={returnTime}
          airportCode={airport}
          onClose={() => setSelectedLot(null)}
        />
      )}
    </div>
  );
}

export default function SearchPage() {
  return (
    <Suspense
      fallback={
        <div className="h-screen flex items-center justify-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-brand-orange" />
        </div>
      }
    >
      <SearchPageContent />
    </Suspense>
  );
}
