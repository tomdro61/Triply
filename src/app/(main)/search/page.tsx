"use client";

import { useState, useEffect, useMemo, useRef, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { Map, List } from "lucide-react";
import { Navbar } from "@/components/shared";
import {
  SearchHeader,
  SearchResultsList,
  SearchMap,
  ProductDetailSlider,
  type SearchTab,
} from "@/components/search";
import { MobileMapCard } from "@/components/search/mobile-map-card";
import { UnifiedLot, SortOption } from "@/types/lot";
import { getAirportByCode } from "@/config/airports";
import { trackSearch } from "@/lib/analytics/gtag";

function SearchPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // Get initial values from URL params
  const initialAirport = searchParams.get("airport") || "JFK";
  const initialCheckin =
    searchParams.get("checkin") ||
    new Date().toISOString().split("T")[0];
  const initialCheckout =
    searchParams.get("checkout") ||
    new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

  // State
  const [tab, setTab] = useState<SearchTab>("parking");
  const [airport, setAirport] = useState(initialAirport);
  const [departDate, setDepartDate] = useState(initialCheckin);
  const [returnDate, setReturnDate] = useState(initialCheckout);
  const [sortBy, setSortBy] = useState<SortOption>("popularity");
  const [lots, setLots] = useState<UnifiedLot[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [selectedLot, setSelectedLot] = useState<UnifiedLot | null>(null);
  const [mobileView, setMobileView] = useState<"list" | "map">("list");
  const [activeMapCardIndex, setActiveMapCardIndex] = useState(0);
  const carouselRef = useRef<HTMLDivElement>(null);

  const airportInfo = getAirportByCode(airport);
  const locationName = airportInfo?.city || "New York";

  // Fetch search results
  const fetchResults = async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const params = new URLSearchParams({
        airport,
        checkin: departDate,
        checkout: returnDate,
        sort: sortBy,
      });
      const response = await fetch(`/api/search?${params.toString()}`);
      const data = await response.json();
      // Treat an HTTP failure (e.g. ResLab degraded → 503) as an error, not as
      // "no lots". Showing an empty results page on an upstream failure is the
      // misleading silent-failure that hid the 2026-06-29 incident.
      if (!response.ok || data.error) {
        console.error("Search API error:", data.error || `HTTP ${response.status}`);
        setLoadError(true);
        setLots([]);
      } else {
        setLots(data.results || []);
        trackSearch({ airportCode: airport, checkin: departDate, checkout: returnDate });
      }
    } catch (err) {
      console.error("Error fetching search results:", err);
      setLoadError(true);
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
    });
    router.push(`/search?${params.toString()}`);
    fetchResults();
  };

  // Handle carousel scroll to detect active card
  const handleCarouselScroll = () => {
    const el = carouselRef.current;
    if (!el) return;
    const cardWidth = el.offsetWidth * 0.88 + 12; // 88% width + gap
    const index = Math.round(el.scrollLeft / cardWidth);
    setActiveMapCardIndex(Math.min(index, sortedLots.length - 1));
  };

  // Highlight the corresponding map marker when carousel scrolls
  useEffect(() => {
    if (mobileView === "map" && sortedLots[activeMapCardIndex]) {
      setHoveredId(sortedLots[activeMapCardIndex].id);
    }
  }, [activeMapCardIndex, mobileView, sortedLots]);

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
          onSearch={handleSearch}
        />

        {/* Split View Content */}
        <div className="flex-1 flex overflow-hidden relative">
          {/* Mobile: List View */}
          {loading ? (
            <div className={`w-full lg:w-2/5 h-full flex items-center justify-center bg-gray-50 ${mobileView === "map" ? "hidden lg:flex" : ""}`}>
              <div className="text-center">
                <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-brand-orange mx-auto mb-4" />
                <p className="text-gray-500">Searching for parking...</p>
              </div>
            </div>
          ) : loadError ? (
            <div className={`w-full lg:w-2/5 h-full flex items-center justify-center bg-gray-50 ${mobileView === "map" ? "hidden lg:flex" : ""}`}>
              <div className="text-center px-6 max-w-sm">
                <p className="text-gray-900 font-semibold mb-2">
                  We couldn&apos;t load parking right now
                </p>
                <p className="text-gray-500 text-sm mb-4">
                  This is usually temporary. Please try again in a moment.
                </p>
                <button
                  onClick={fetchResults}
                  className="bg-brand-orange text-white font-semibold text-sm px-5 py-2.5 rounded-full active:scale-95 transition-transform"
                >
                  Try again
                </button>
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
              className={mobileView === "map" ? "hidden lg:block" : ""}
            />
          )}

          {/* Mobile: Map View */}
          {mobileView === "map" && !loading && !loadError && (
            <div className="lg:hidden w-full h-full relative">
              <SearchMap
                lots={sortedLots}
                hoveredId={hoveredId}
                onHover={setHoveredId}
                onSelect={setSelectedLot}
                showControls={false}
                airport={airportInfo}
              />

              {/* Card carousel at bottom */}
              {sortedLots.length > 0 && (
                <div className="absolute bottom-0 left-0 right-0 pb-20 pt-2">
                  <div
                    ref={carouselRef}
                    onScroll={handleCarouselScroll}
                    className="flex gap-3 overflow-x-auto snap-x snap-mandatory px-4 no-scrollbar"
                  >
                    {sortedLots.map((lot) => (
                      <MobileMapCard
                        key={lot.id}
                        lot={lot}
                        onSelect={setSelectedLot}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Desktop: Map (always visible on lg+) */}
          <div className="hidden lg:block w-3/5 h-full relative border-l border-gray-200">
            <SearchMap
              lots={sortedLots}
              hoveredId={hoveredId}
              onHover={setHoveredId}
              onSelect={setSelectedLot}
              airport={airportInfo}
            />
          </div>
        </div>
      </div>

      {/* Mobile View Toggle Button */}
      {!loading && sortedLots.length > 0 && (
        <button
          onClick={() => setMobileView(mobileView === "list" ? "map" : "list")}
          className="lg:hidden fixed bottom-6 left-1/2 -translate-x-1/2 z-40 flex items-center gap-2 bg-navy text-white font-semibold text-sm px-5 py-3 rounded-full shadow-lg active:scale-95 transition-transform"
        >
          {mobileView === "list" ? (
            <>
              <Map size={18} />
              Map
            </>
          ) : (
            <>
              <List size={18} />
              List
            </>
          )}
        </button>
      )}

      {/* Slide-out Product Detail */}
      {selectedLot && (
        <ProductDetailSlider
          lot={selectedLot}
          checkIn={departDate}
          checkOut={returnDate}
          checkInTime=""
          checkOutTime=""
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
