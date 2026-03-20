"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Calendar as CalendarIcon } from "lucide-react";
import { format, parse } from "date-fns";
import { DateRangePicker } from "@/components/ui/date-picker";
import { Button } from "@/components/ui/button";
import { AirportCombobox } from "@/components/shared/airport-combobox";

interface SearchWidgetProps {
  airportCode: string;
}

export function SearchWidget({ airportCode }: SearchWidgetProps) {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(false);
  const [location, setLocation] = useState(airportCode);
  const [departDate, setDepartDate] = useState("");
  const [returnDate, setReturnDate] = useState("");

  const handleSearch = () => {
    if (!location) return;
    setIsLoading(true);

    const params = new URLSearchParams({
      airport: location,
      ...(departDate && { checkin: departDate }),
      ...(returnDate && { checkout: returnDate }),
    });

    router.push(`/search?${params.toString()}`);
  };

  return (
    <div className="bg-white rounded-2xl shadow-xl p-4 sm:p-6 max-w-3xl mx-auto">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {/* Airport */}
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1.5">Airport</label>
          <AirportCombobox
            value={location}
            onChange={setLocation}
            variant="compact"
          />
        </div>

        {/* Dates */}
        <DateRangePicker
          startDate={departDate}
          endDate={returnDate}
          onStartChange={setDepartDate}
          onEndChange={setReturnDate}
          minDate={new Date()}
        >
          {({ startTriggerProps, endTriggerProps }) => (
            <>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1.5">Depart</label>
                <button
                  type="button"
                  ref={startTriggerProps.ref}
                  onClick={startTriggerProps.onClick}
                  className="w-full flex items-center gap-2 px-3 py-2.5 border border-gray-200 rounded-lg text-sm text-left hover:border-brand-orange transition-colors"
                >
                  <CalendarIcon className="w-4 h-4 text-gray-400" />
                  <span className={departDate ? "text-gray-900" : "text-gray-400"}>
                    {departDate
                      ? format(parse(departDate, "yyyy-MM-dd", new Date()), "MMM d, yyyy")
                      : "Select date"}
                  </span>
                </button>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1.5">Return</label>
                <button
                  type="button"
                  ref={endTriggerProps.ref}
                  onClick={endTriggerProps.onClick}
                  className="w-full flex items-center gap-2 px-3 py-2.5 border border-gray-200 rounded-lg text-sm text-left hover:border-brand-orange transition-colors"
                >
                  <CalendarIcon className="w-4 h-4 text-gray-400" />
                  <span className={returnDate ? "text-gray-900" : "text-gray-400"}>
                    {returnDate
                      ? format(parse(returnDate, "yyyy-MM-dd", new Date()), "MMM d, yyyy")
                      : "Select date"}
                  </span>
                </button>
              </div>
            </>
          )}
        </DateRangePicker>
      </div>

      <Button
        onClick={handleSearch}
        disabled={!location || isLoading}
        className="w-full mt-4 bg-brand-orange hover:bg-brand-orange/90 text-white font-bold h-12 text-base"
      >
        {isLoading ? (
          <Loader2 className="w-5 h-5 animate-spin" />
        ) : (
          "Search Parking"
        )}
      </Button>
    </div>
  );
}
