"use client";

import { ChevronDown } from "lucide-react";
import { UnifiedLot, SortOption } from "@/types/lot";
import { LotCard } from "./lot-card";
import { SearchTab } from "./search-header";

interface SearchResultsListProps {
  lots: UnifiedLot[];
  tab: SearchTab;
  location: string;
  sortBy: SortOption;
  onSortChange: (sort: SortOption) => void;
  hoveredId: string | null;
  onHover: (id: string | null) => void;
  onSelect: (lot: UnifiedLot) => void;
}

export function SearchResultsList({
  lots,
  tab,
  location,
  sortBy,
  onSortChange,
  hoveredId,
  onHover,
  onSelect,
}: SearchResultsListProps) {
  return (
    <div className="w-full lg:w-2/5 h-full overflow-y-auto no-scrollbar bg-gray-50">
      {/* Sticky Filters & Results Header */}
      <div className="sticky top-0 z-20 bg-gray-50 px-4 sm:px-6 py-4 border-b border-gray-200 shadow-sm backdrop-blur-sm bg-opacity-95">
        <div className="flex justify-between items-end">
          <div className="flex items-baseline gap-2">
            <h2 className="text-lg font-bold text-gray-900 capitalize leading-none">
              {tab === "hotels" ? "Park + Hotel" : "Parking"} in {location}
            </h2>
            <span className="text-sm font-medium text-gray-400">
              {lots.length} Results
            </span>
          </div>

          {/* Sort */}
          <div className="relative flex items-center w-[140px]">
            <select
              value={sortBy}
              onChange={(e) => onSortChange(e.target.value as SortOption)}
              className="w-full pl-3 pr-8 py-2 bg-white border border-gray-300 rounded-lg text-xs font-semibold text-gray-700 focus:ring-1 focus:ring-brand-orange focus:border-brand-orange cursor-pointer hover:bg-gray-50 transition-colors appearance-none shadow-sm"
            >
              <option value="popularity">Recommended</option>
              <option value="price_asc">Lowest Price</option>
              <option value="price_desc">Highest Price</option>
              <option value="rating">Top Rated</option>
              <option value="distance">Closest</option>
            </select>
            <ChevronDown
              className="absolute right-2.5 top-1/2 transform -translate-y-1/2 text-gray-500 pointer-events-none"
              size={14}
            />
          </div>
        </div>
      </div>

      <div className="p-4 sm:p-6 space-y-4 pb-20">
        {lots.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-gray-500">No parking lots found for your search criteria.</p>
          </div>
        ) : (
          lots.map((lot) => (
            <LotCard
              key={lot.id}
              lot={lot}
              isHovered={hoveredId === lot.id}
              onHover={onHover}
              onSelect={onSelect}
            />
          ))
        )}
      </div>
    </div>
  );
}
