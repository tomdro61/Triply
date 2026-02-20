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
import { enabledAirports, getAirportByCode } from "@/config/airports";
import { DateRangePicker } from "@/components/ui/date-picker";

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
  departTime: string;
  onDepartTimeChange: (time: string) => void;
  returnTime: string;
  onReturnTimeChange: (time: string) => void;
  onSearch: () => void;
}

const timeOptions = [
  "12:00 AM",
  "12:30 AM",
  "1:00 AM",
  "1:30 AM",
  "2:00 AM",
  "2:30 AM",
  "3:00 AM",
  "3:30 AM",
  "4:00 AM",
  "4:30 AM",
  "5:00 AM",
  "5:30 AM",
  "6:00 AM",
  "6:30 AM",
  "7:00 AM",
  "7:30 AM",
  "8:00 AM",
  "8:30 AM",
  "9:00 AM",
  "9:30 AM",
  "10:00 AM",
  "10:30 AM",
  "11:00 AM",
  "11:30 AM",
  "12:00 PM",
  "12:30 PM",
  "1:00 PM",
  "1:30 PM",
  "2:00 PM",
  "2:30 PM",
  "3:00 PM",
  "3:30 PM",
  "4:00 PM",
  "4:30 PM",
  "5:00 PM",
  "5:30 PM",
  "6:00 PM",
  "6:30 PM",
  "7:00 PM",
  "7:30 PM",
  "8:00 PM",
  "8:30 PM",
  "9:00 PM",
  "9:30 PM",
  "10:00 PM",
  "10:30 PM",
  "11:00 PM",
  "11:30 PM",
];

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
  departTime,
  onDepartTimeChange,
  returnTime,
  onReturnTimeChange,
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
            <div className="relative mt-3 mb-3">
              <MapPin
                className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-500 pointer-events-none"
                size={18}
              />
              <select
                value={airport}
                onChange={(e) => onAirportChange(e.target.value)}
                className="w-full pl-10 pr-4 py-2.5 bg-gray-50 border border-gray-200 rounded-lg text-sm font-semibold text-gray-900 focus:bg-white focus:ring-2 focus:ring-brand-orange focus:border-transparent outline-none transition-all appearance-none cursor-pointer"
              >
                {enabledAirports.map((a) => (
                  <option key={a.code} value={a.code}>
                    {a.city} ({a.code})
                  </option>
                ))}
              </select>
              <ChevronDown
                className="absolute right-3 top-1/2 transform -translate-y-1/2 text-gray-400 pointer-events-none"
                size={14}
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
                  <div className="flex gap-2 mb-3">
                    <div className="flex-grow py-2.5 px-3 bg-gray-50 border border-gray-200 rounded-lg">
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
                    <div className="relative w-32">
                      <select
                        value={departTime}
                        onChange={(e) => onDepartTimeChange(e.target.value)}
                        className="w-full pl-3 pr-8 py-2.5 bg-gray-50 border border-gray-200 rounded-lg text-sm font-medium text-gray-900 focus:bg-white focus:ring-2 focus:ring-brand-orange focus:border-transparent outline-none appearance-none transition-all cursor-pointer"
                      >
                        {timeOptions.map((time) => (
                          <option key={time} value={time}>{time}</option>
                        ))}
                      </select>
                      <ChevronDown className="absolute right-2 top-1/2 transform -translate-y-1/2 text-gray-400 pointer-events-none" size={14} />
                    </div>
                  </div>

                  <div className="flex gap-2 mb-3">
                    <div className="flex-grow py-2.5 px-3 bg-gray-50 border border-gray-200 rounded-lg">
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
                    <div className="relative w-32">
                      <select
                        value={returnTime}
                        onChange={(e) => onReturnTimeChange(e.target.value)}
                        className="w-full pl-3 pr-8 py-2.5 bg-gray-50 border border-gray-200 rounded-lg text-sm font-medium text-gray-900 focus:bg-white focus:ring-2 focus:ring-brand-orange focus:border-transparent outline-none appearance-none transition-all cursor-pointer"
                      >
                        {timeOptions.map((time) => (
                          <option key={time} value={time}>{time}</option>
                        ))}
                      </select>
                      <ChevronDown className="absolute right-2 top-1/2 transform -translate-y-1/2 text-gray-400 pointer-events-none" size={14} />
                    </div>
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

      {/* Desktop: Full form (unchanged) */}
      <div className="hidden lg:block max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-2 pb-4">
        {/* Search Inputs */}
        <div className="flex flex-col xl:flex-row gap-3">
          {/* Location */}
          <div className="relative flex-grow group xl:w-1/4">
            <MapPin
              className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-500 pointer-events-none"
              size={18}
            />
            <select
              value={airport}
              onChange={(e) => onAirportChange(e.target.value)}
              className="w-full pl-10 pr-4 py-2.5 bg-gray-50 border border-gray-200 rounded-lg text-sm font-semibold text-gray-900 focus:bg-white focus:ring-2 focus:ring-brand-orange focus:border-transparent outline-none transition-all appearance-none cursor-pointer"
            >
              {enabledAirports.map((a) => (
                <option key={a.code} value={a.code}>
                  {a.city} ({a.code})
                </option>
              ))}
            </select>
            <ChevronDown
              className="absolute right-3 top-1/2 transform -translate-y-1/2 text-gray-400 pointer-events-none"
              size={14}
            />
          </div>

          {/* Date & Time Group */}
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
                <div className="flex flex-1 gap-2">
                  <div className="flex-grow py-2.5 px-3 bg-gray-50 border border-gray-200 rounded-lg">
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
                  <div className="relative w-32">
                    <select
                      value={departTime}
                      onChange={(e) => onDepartTimeChange(e.target.value)}
                      className="w-full pl-3 pr-8 py-2.5 bg-gray-50 border border-gray-200 rounded-lg text-sm font-medium text-gray-900 focus:bg-white focus:ring-2 focus:ring-brand-orange focus:border-transparent outline-none appearance-none transition-all cursor-pointer"
                    >
                      {timeOptions.map((time) => (
                        <option key={time} value={time}>{time}</option>
                      ))}
                    </select>
                    <ChevronDown className="absolute right-2 top-1/2 transform -translate-y-1/2 text-gray-400 pointer-events-none" size={14} />
                  </div>
                </div>

                {/* Return */}
                <div className="flex flex-1 gap-2">
                  <div className="flex-grow py-2.5 px-3 bg-gray-50 border border-gray-200 rounded-lg">
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
                  <div className="relative w-32">
                    <select
                      value={returnTime}
                      onChange={(e) => onReturnTimeChange(e.target.value)}
                      className="w-full pl-3 pr-8 py-2.5 bg-gray-50 border border-gray-200 rounded-lg text-sm font-medium text-gray-900 focus:bg-white focus:ring-2 focus:ring-brand-orange focus:border-transparent outline-none appearance-none transition-all cursor-pointer"
                    >
                      {timeOptions.map((time) => (
                        <option key={time} value={time}>{time}</option>
                      ))}
                    </select>
                    <ChevronDown className="absolute right-2 top-1/2 transform -translate-y-1/2 text-gray-400 pointer-events-none" size={14} />
                  </div>
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
