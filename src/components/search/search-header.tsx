"use client";

import { useState } from "react";
import {
  MapPin,
  ChevronDown,
  ChevronUp,
  SlidersHorizontal,
  Calendar as CalendarIcon,
} from "lucide-react";
import { format, parse } from "date-fns";
import { getAirportByCode } from "@/config/airports";
import { DateRangePicker } from "@/components/ui/date-picker";
import { AirportCombobox } from "@/components/shared/airport-combobox";

export type SearchTab = "parking";

interface SearchHeaderProps {
  tab: SearchTab;
  onTabChange: (tab: SearchTab) => void;
  airport: string;
  onAirportChange: (airport: string) => void;
  departDate: string;
  onDepartDateChange: (date: string) => void;
  returnDate: string;
  onReturnDateChange: (date: string) => void;
  onSearch: () => void;
}

function formatShortDate(dateStr: string): string {
  const date = new Date(dateStr + "T00:00:00");
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function SearchHeader({
  tab,
  onTabChange,
  airport,
  onAirportChange,
  departDate,
  onDepartDateChange,
  returnDate,
  onReturnDateChange,
  onSearch,
}: SearchHeaderProps) {
  const [expanded, setExpanded] = useState(false);
  const airportInfo = getAirportByCode(airport);
  const airportLabel = airportInfo
    ? `${airportInfo.code}`
    : airport;

  return (
    <div className="bg-white border-b border-gray-200 z-30 shadow-sm relative flex-shrink-0">
      {/* Mobile: Compact summary bar */}
      <div className="lg:hidden">
        <button
          onClick={() => setExpanded(!expanded)}
          className="w-full px-4 py-3 flex items-center justify-between"
        >
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex items-center gap-1.5 text-sm font-semibold text-gray-900">
              <MapPin size={16} className="text-brand-orange flex-shrink-0" />
              <span>{airportLabel}</span>
            </div>
            <span className="text-gray-300">|</span>
            <div className="flex items-center gap-1.5 text-sm text-gray-600 truncate">
              <CalendarIcon size={14} className="text-gray-400 flex-shrink-0" />
              <span className="truncate">
                {formatShortDate(departDate)} — {formatShortDate(returnDate)}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-1 ml-3 flex-shrink-0 text-brand-orange">
            <SlidersHorizontal size={16} />
            {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </div>
        </button>

        {/* Expandable form */}
        {expanded && (
          <div className="px-4 pb-4 border-t border-gray-100">
            {/* Location */}
            <div className="mt-3 mb-3">
              <AirportCombobox
                value={airport}
                onChange={onAirportChange}
                placeholder="Search airports..."
                variant="compact"
              />
            </div>

            {/* Depart & Return */}
            <DateRangePicker
              startDate={departDate}
              endDate={returnDate}
              onStartChange={onDepartDateChange}
              onEndChange={onReturnDateChange}
              minDate={new Date()}
            >
              {({ startTriggerProps, endTriggerProps }) => (
                <>
                  <div className="mb-3 py-2.5 px-3 bg-gray-50 border border-gray-200 rounded-lg">
                    <button
                      type="button"
                      ref={startTriggerProps.ref}
                      onClick={startTriggerProps.onClick}
                      className="flex items-center w-full text-left cursor-pointer text-sm"
                    >
                      <CalendarIcon size={20} className="mr-2 text-brand-blue opacity-80 flex-shrink-0" />
                      <span className={departDate ? "text-gray-900 font-medium truncate" : "text-gray-400 truncate"}>
                        {departDate ? format(parse(departDate, "yyyy-MM-dd", new Date()), "MMM d, yyyy") : "Depart date"}
                      </span>
                    </button>
                  </div>

                  <div className="mb-3 py-2.5 px-3 bg-gray-50 border border-gray-200 rounded-lg">
                    <button
                      type="button"
                      ref={endTriggerProps.ref}
                      onClick={endTriggerProps.onClick}
                      className="flex items-center w-full text-left cursor-pointer text-sm"
                    >
                      <CalendarIcon size={20} className="mr-2 text-brand-blue opacity-80 flex-shrink-0" />
                      <span className={returnDate ? "text-gray-900 font-medium truncate" : "text-gray-400 truncate"}>
                        {returnDate ? format(parse(returnDate, "yyyy-MM-dd", new Date()), "MMM d, yyyy") : "Return date"}
                      </span>
                    </button>
                  </div>
                </>
              )}
            </DateRangePicker>

            {/* Update Button */}
            <button
              onClick={() => {
                onSearch();
                setExpanded(false);
              }}
              className="w-full bg-brand-orange hover:bg-orange-600 text-white font-bold py-2.5 px-6 rounded-lg shadow-sm transition-all active:scale-95"
            >
              Update Search
            </button>
          </div>
        )}
      </div>

      {/* Desktop: Full form */}
      <div className="hidden lg:block max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-2 pb-4">
        {/* Search Inputs */}
        <div className="flex flex-col xl:flex-row gap-3">
          {/* Location */}
          <div className="flex-grow xl:w-1/4">
            <AirportCombobox
              value={airport}
              onChange={onAirportChange}
              placeholder="Search airports..."
              variant="compact"
            />
          </div>

          {/* Date Group */}
          <DateRangePicker
            startDate={departDate}
            endDate={returnDate}
            onStartChange={onDepartDateChange}
            onEndChange={onReturnDateChange}
            minDate={new Date()}
          >
            {({ startTriggerProps, endTriggerProps }) => (
              <div className="flex flex-col sm:flex-row gap-3 xl:w-2/3">
                {/* Depart */}
                <div className="flex-1 py-2.5 px-3 bg-gray-50 border border-gray-200 rounded-lg">
                  <button
                    type="button"
                    ref={startTriggerProps.ref}
                    onClick={startTriggerProps.onClick}
                    className="flex items-center w-full text-left cursor-pointer text-sm"
                  >
                    <CalendarIcon size={20} className="mr-2 text-brand-blue opacity-80 flex-shrink-0" />
                    <span className={departDate ? "text-gray-900 font-medium truncate" : "text-gray-400 truncate"}>
                      {departDate ? format(parse(departDate, "yyyy-MM-dd", new Date()), "MMM d, yyyy") : "Depart date"}
                    </span>
                  </button>
                </div>

                {/* Return */}
                <div className="flex-1 py-2.5 px-3 bg-gray-50 border border-gray-200 rounded-lg">
                  <button
                    type="button"
                    ref={endTriggerProps.ref}
                    onClick={endTriggerProps.onClick}
                    className="flex items-center w-full text-left cursor-pointer text-sm"
                  >
                    <CalendarIcon size={20} className="mr-2 text-brand-blue opacity-80 flex-shrink-0" />
                    <span className={returnDate ? "text-gray-900 font-medium truncate" : "text-gray-400 truncate"}>
                      {returnDate ? format(parse(returnDate, "yyyy-MM-dd", new Date()), "MMM d, yyyy") : "Return date"}
                    </span>
                  </button>
                </div>
              </div>
            )}
          </DateRangePicker>

          {/* Update Button */}
          <button
            onClick={onSearch}
            className="bg-brand-orange hover:bg-orange-600 text-white font-bold py-2.5 px-6 rounded-lg shadow-sm transition-all active:scale-95 whitespace-nowrap"
          >
            Update
          </button>
        </div>
      </div>
    </div>
  );
}
