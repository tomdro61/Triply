"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { MapPin, Calendar, Loader2, SquareParking, Hotel, Sparkles, Star, ShieldCheck, Clock, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { enabledAirports } from "@/config/airports";
import { HeroChatInput } from "@/components/chat";

type SearchTab = "parking" | "hotel" | "ai";

export function Hero() {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<SearchTab>("parking");
  const [isLoading, setIsLoading] = useState(false);
  const [location, setLocation] = useState("");
  const [departDate, setDepartDate] = useState("");
  const [returnDate, setReturnDate] = useState("");

  const handleSearch = () => {
    if (!location) return;

    setIsLoading(true);

    // Build search params
    const params = new URLSearchParams({
      airport: location,
      checkin: departDate,
      checkout: returnDate,
      type: activeTab,
    });

    setTimeout(() => {
      setIsLoading(false);
      router.push(`/search?${params.toString()}`);
    }, 500);
  };

  const tabs = [
    { id: "parking" as const, icon: SquareParking, label: "Parking" },
    { id: "hotel" as const, icon: Hotel, label: "Park + Hotel" },
    { id: "ai" as const, icon: Sparkles, label: "AI Assistant" },
  ];

  return (
    <div
      className="relative min-h-[700px] lg:min-h-[750px] flex items-center justify-center bg-cover bg-center pt-20"
      style={{
        backgroundImage: `linear-gradient(to bottom, rgba(0,0,0,0.45), rgba(0,0,0,0.65)), url('https://images.unsplash.com/photo-1469854523086-cc02fe5d8800?ixlib=rb-4.0.3&auto=format&fit=crop&w=2021&q=80')`,
      }}
    >
      <div className="w-full max-w-5xl px-4 sm:px-6 relative z-10 pb-16 mt-6 md:mt-0">
        <h1 className="text-4xl md:text-6xl font-bold text-white text-center mb-6 drop-shadow-[0_2px_10px_rgba(0,0,0,0.5)]">
          Save Up to <span className="text-brand-orange">60%</span> on
          <br />
          Airport Parking
        </h1>
        <p className="text-white/90 text-center text-base md:text-xl mb-10 max-w-2xl mx-auto drop-shadow-[0_1px_4px_rgba(0,0,0,0.5)]">
          Compare 100+ parking options.
          <br className="hidden sm:block" /> Free cancellation on most bookings.
        </p>

        {/* Search Container */}
        <div className="bg-white rounded-xl shadow-2xl overflow-hidden">
          {/* Tabs */}
          <div className="flex overflow-x-auto no-scrollbar border-b border-gray-200 bg-gray-50">
            {tabs.map((tab) => {
              const isActive = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`flex items-center justify-center px-6 py-4 flex-1 transition-colors text-sm md:text-base font-medium
                    ${
                      isActive
                        ? "bg-white text-brand-orange border-b-2 border-brand-orange"
                        : "text-gray-500 hover:text-gray-700 hover:bg-gray-100"
                    }
                  `}
                >
                  <tab.icon
                    size={18}
                    className={`mr-2 ${isActive ? "stroke-2" : "stroke-1"}`}
                  />
                  {tab.label}
                </button>
              );
            })}
          </div>

          {/* Content Area */}
          <div className="p-4 md:p-6 bg-white">
            {activeTab === "ai" ? (
              <div className="bg-gradient-to-br from-gray-900 to-gray-800 rounded-lg p-4 md:p-6">
                <HeroChatInput />
              </div>
            ) : (
            <div className="grid grid-cols-1 md:grid-cols-12 gap-4 items-end animate-fade-in">
              {/* Location */}
              <div className="md:col-span-4 relative group">
                <label className="block text-xs font-bold text-gray-500 uppercase mb-1">
                  Where to?
                </label>
                <div className="relative flex items-center">
                  <MapPin
                    className="absolute left-3 text-brand-blue opacity-80 pointer-events-none"
                    size={20}
                  />
                  <select
                    value={location}
                    onChange={(e) => setLocation(e.target.value)}
                    className="w-full pl-10 pr-4 py-3 bg-gray-50 border border-gray-200 rounded-lg focus:ring-2 focus:ring-brand-orange focus:border-transparent outline-none font-medium text-gray-900 group-hover:bg-white transition-colors cursor-pointer"
                  >
                    <option value="">Select Airport</option>
                    {enabledAirports.map((a) => (
                      <option key={a.code} value={a.code}>
                        {a.code} - {a.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Depart Date */}
              <div className="md:col-span-3 relative group">
                <label className="block text-xs font-bold text-gray-500 uppercase mb-1">
                  Depart
                </label>
                <div className="relative flex items-center">
                  <Calendar
                    className="absolute left-3 text-brand-blue opacity-80 pointer-events-none"
                    size={20}
                  />
                  <input
                    type="date"
                    value={departDate}
                    onChange={(e) => setDepartDate(e.target.value)}
                    className="w-full pl-10 pr-4 py-3 bg-gray-50 border border-gray-200 rounded-lg focus:ring-2 focus:ring-brand-orange focus:border-transparent outline-none font-medium text-gray-900 group-hover:bg-white transition-colors cursor-pointer"
                  />
                </div>
              </div>

              {/* Return Date */}
              <div className="md:col-span-3 relative group">
                <label className="block text-xs font-bold text-gray-500 uppercase mb-1">
                  Return
                </label>
                <div className="relative flex items-center">
                  <Calendar
                    className="absolute left-3 text-brand-blue opacity-80 pointer-events-none"
                    size={20}
                  />
                  <input
                    type="date"
                    value={returnDate}
                    onChange={(e) => setReturnDate(e.target.value)}
                    className="w-full pl-10 pr-4 py-3 bg-gray-50 border border-gray-200 rounded-lg focus:ring-2 focus:ring-brand-orange focus:border-transparent outline-none font-medium text-gray-900 group-hover:bg-white transition-colors cursor-pointer"
                  />
                </div>
              </div>

              {/* Search Button */}
              <div className="md:col-span-2">
                <Button
                  onClick={handleSearch}
                  disabled={isLoading || !location}
                  className="w-full bg-brand-orange hover:bg-brand-orange/90 text-white font-bold py-3 px-4 rounded-lg shadow-md hover:shadow-lg transition-all transform active:scale-95 h-[50px]"
                >
                  {isLoading ? (
                    <Loader2 className="animate-spin h-6 w-6" />
                  ) : (
                    "Search"
                  )}
                </Button>
              </div>
            </div>
            )}
          </div>
        </div>

        {/* Trust badges */}
        <div className="flex flex-wrap justify-center gap-3 mt-8">
          {[
            { icon: Star, label: "4.9 Rating", color: "text-yellow-400" },
            { icon: ShieldCheck, label: "Verified Partners", color: "text-brand-orange" },
            { icon: Clock, label: "24/7 Support", color: "text-blue-400" },
            { icon: RefreshCw, label: "Free Cancellation", color: "text-green-400" },
          ].map((item) => (
            <div
              key={item.label}
              className="flex items-center gap-2 bg-white/[0.08] backdrop-blur-sm border border-white/[0.12] rounded-full px-4 py-2"
            >
              <item.icon size={16} className={item.color} />
              <span className="text-white/70 text-sm font-medium">{item.label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
