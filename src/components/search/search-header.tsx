"use client";

import { MapPin, ChevronDown, SquareParking, Hotel } from "lucide-react";
import { enabledAirports } from "@/config/airports";

export type SearchTab = "parking" | "hotels";

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

const tabs = [
  { id: "parking" as SearchTab, icon: SquareParking, label: "Parking" },
  { id: "hotels" as SearchTab, icon: Hotel, label: "Park + Hotel" },
];

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
  return (
    <div className="bg-white border-b border-gray-200 z-30 shadow-sm relative flex-shrink-0">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-2 pb-4">
        {/* Type Tabs */}
        <div className="flex mb-3 gap-6 border-b border-gray-100">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => onTabChange(t.id)}
              className={`flex items-center pb-3 text-sm font-medium border-b-2 transition-all whitespace-nowrap ${
                tab === t.id
                  ? "border-brand-orange text-brand-orange"
                  : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
              }`}
            >
              <t.icon
                size={18}
                className={`mr-2 ${tab === t.id ? "stroke-2" : "stroke-1"}`}
              />
              {t.label}
            </button>
          ))}
        </div>

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
          <div className="flex flex-col sm:flex-row gap-3 xl:w-2/3">
            {/* Depart */}
            <div className="flex flex-1 gap-2">
              <div className="relative flex-grow">
                <input
                  type="date"
                  value={departDate}
                  onChange={(e) => onDepartDateChange(e.target.value)}
                  className="w-full pl-4 pr-2 py-2.5 bg-gray-50 border border-gray-200 rounded-lg text-sm font-medium text-gray-900 focus:bg-white focus:ring-2 focus:ring-brand-orange focus:border-transparent outline-none transition-all cursor-pointer"
                />
              </div>
              <div className="relative w-32">
                <select
                  value={departTime}
                  onChange={(e) => onDepartTimeChange(e.target.value)}
                  className="w-full pl-3 pr-8 py-2.5 bg-gray-50 border border-gray-200 rounded-lg text-sm font-medium text-gray-900 focus:bg-white focus:ring-2 focus:ring-brand-orange focus:border-transparent outline-none appearance-none transition-all cursor-pointer"
                >
                  {timeOptions.map((time) => (
                    <option key={time} value={time}>
                      {time}
                    </option>
                  ))}
                </select>
                <ChevronDown
                  className="absolute right-2 top-1/2 transform -translate-y-1/2 text-gray-400 pointer-events-none"
                  size={14}
                />
              </div>
            </div>

            {/* Return */}
            <div className="flex flex-1 gap-2">
              <div className="relative flex-grow">
                <input
                  type="date"
                  value={returnDate}
                  onChange={(e) => onReturnDateChange(e.target.value)}
                  className="w-full pl-4 pr-2 py-2.5 bg-gray-50 border border-gray-200 rounded-lg text-sm font-medium text-gray-900 focus:bg-white focus:ring-2 focus:ring-brand-orange focus:border-transparent outline-none transition-all cursor-pointer"
                />
              </div>
              <div className="relative w-32">
                <select
                  value={returnTime}
                  onChange={(e) => onReturnTimeChange(e.target.value)}
                  className="w-full pl-3 pr-8 py-2.5 bg-gray-50 border border-gray-200 rounded-lg text-sm font-medium text-gray-900 focus:bg-white focus:ring-2 focus:ring-brand-orange focus:border-transparent outline-none appearance-none transition-all cursor-pointer"
                >
                  {timeOptions.map((time) => (
                    <option key={time} value={time}>
                      {time}
                    </option>
                  ))}
                </select>
                <ChevronDown
                  className="absolute right-2 top-1/2 transform -translate-y-1/2 text-gray-400 pointer-events-none"
                  size={14}
                />
              </div>
            </div>
          </div>

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
