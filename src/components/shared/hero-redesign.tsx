"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { MapPin, Calendar, Loader2, ChevronDown, Search, Star, ShieldCheck, Clock, RefreshCw } from "lucide-react";
import { enabledAirports } from "@/config/airports";

export function HeroRedesign() {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(false);
  const [location, setLocation] = useState("");
  const [departDate, setDepartDate] = useState("");
  const [returnDate, setReturnDate] = useState("");

  const handleSearch = () => {
    if (!location) return;

    setIsLoading(true);

    const params = new URLSearchParams({
      airport: location,
      checkin: departDate,
      checkout: returnDate,
      type: "parking",
    });

    setTimeout(() => {
      setIsLoading(false);
      router.push(`/search?${params.toString()}`);
    }, 500);
  };

  return (
    <section
      className="relative min-h-dvh min-h-[600px] flex items-center justify-center overflow-hidden"
      style={{
        backgroundImage: `linear-gradient(to bottom, rgba(10,10,26,0.75), rgba(26,26,46,0.88)), url('https://images.unsplash.com/photo-1469854523086-cc02fe5d8800?ixlib=rb-4.0.3&auto=format&fit=crop&w=2021&q=80')`,
        backgroundSize: "cover",
        backgroundPosition: "center",
      }}
    >
      {/* Ambient gradient orbs */}
      <div className="absolute top-[-10%] right-[-5%] w-[500px] h-[500px] rounded-full bg-brand-orange/15 blur-[150px] animate-float-orb pointer-events-none" />
      <div className="absolute bottom-[-10%] left-[-5%] w-[600px] h-[600px] rounded-full bg-brand-blue/10 blur-[180px] animate-float-orb-delayed pointer-events-none" />

      <div className="relative z-10 w-full max-w-5xl px-4 sm:px-6 pt-24 pb-20">
        {/* Headline */}
        <motion.h1
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.2, ease: "easeOut" }}
          className="text-center font-heading leading-[0.95] tracking-tight mb-6"
        >
          <span className="block text-5xl sm:text-6xl md:text-7xl lg:text-8xl xl:text-[110px] font-bold text-white">
            Your Trip
          </span>
          <span className="block text-5xl sm:text-6xl md:text-7xl lg:text-8xl xl:text-[110px] font-bold text-brand-orange">
            Simplified
          </span>
        </motion.h1>

        {/* Subtitle */}
        <motion.p
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.4, ease: "easeOut" }}
          className="text-white/90 text-center text-lg md:text-xl max-w-2xl mx-auto mb-10"
        >
          Compare 100+ parking options at JFK and LaGuardia.
          <br className="hidden sm:block" /> Save up to 60% on airport parking.
        </motion.p>

        {/* Search Form */}
        <motion.div
          initial={{ opacity: 0, y: 40, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.8, delay: 0.6, ease: "easeOut" }}
          className="bg-white rounded-2xl p-5 md:p-8 shadow-2xl shadow-black/30 max-w-3xl mx-auto"
        >
          <div className="grid grid-cols-1 md:grid-cols-12 gap-4 items-end">
            {/* Airport */}
            <div className="md:col-span-4">
              <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-1.5">
                Where to?
              </label>
              <div className="relative">
                <MapPin
                  size={18}
                  className="absolute left-3 top-1/2 -translate-y-1/2 text-brand-orange pointer-events-none"
                />
                <select
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  className="w-full pl-10 pr-4 py-3 bg-gray-50 border border-gray-200 rounded-xl text-slate-800 focus:ring-2 focus:ring-brand-orange focus:border-transparent outline-none cursor-pointer appearance-none"
                >
                  <option value="">Select Airport</option>
                  {enabledAirports.map((a) => (
                    <option key={a.code} value={a.code}>
                      {a.code} - {a.name}
                    </option>
                  ))}
                </select>
                <ChevronDown
                  size={16}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none"
                />
              </div>
            </div>

            {/* Depart */}
            <div className="md:col-span-3">
              <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-1.5">
                Depart
              </label>
              <div className="relative">
                <Calendar
                  size={18}
                  className="absolute left-3 top-1/2 -translate-y-1/2 text-brand-orange pointer-events-none"
                />
                <input
                  type="date"
                  value={departDate}
                  onChange={(e) => setDepartDate(e.target.value)}
                  className="w-full pl-10 pr-4 py-3 bg-gray-50 border border-gray-200 rounded-xl text-slate-800 focus:ring-2 focus:ring-brand-orange focus:border-transparent outline-none cursor-pointer"
                />
              </div>
            </div>

            {/* Return */}
            <div className="md:col-span-3">
              <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-1.5">
                Return
              </label>
              <div className="relative">
                <Calendar
                  size={18}
                  className="absolute left-3 top-1/2 -translate-y-1/2 text-brand-orange pointer-events-none"
                />
                <input
                  type="date"
                  value={returnDate}
                  onChange={(e) => setReturnDate(e.target.value)}
                  className="w-full pl-10 pr-4 py-3 bg-gray-50 border border-gray-200 rounded-xl text-slate-800 focus:ring-2 focus:ring-brand-orange focus:border-transparent outline-none cursor-pointer"
                />
              </div>
            </div>

            {/* Search Button */}
            <div className="md:col-span-2">
              <button
                onClick={handleSearch}
                disabled={isLoading || !location}
                className="w-full bg-brand-orange hover:bg-brand-orange/90 text-white font-bold rounded-xl h-[50px] shadow-lg shadow-brand-orange/25 transition-all active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {isLoading ? (
                  <Loader2 className="animate-spin h-5 w-5" />
                ) : (
                  <>
                    <Search size={18} />
                    <span className="hidden md:inline">Search</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </motion.div>

        {/* Trust stats */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.9, ease: "easeOut" }}
          className="flex flex-wrap justify-center gap-3 mt-8 max-w-3xl mx-auto"
        >
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
        </motion.div>
      </div>

      {/* Scroll indicator */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1, y: [0, 8, 0] }}
        transition={{
          opacity: { delay: 1.2, duration: 0.5 },
          y: { repeat: Infinity, duration: 1.5, ease: "easeInOut" },
        }}
        className="absolute bottom-8 left-1/2 -translate-x-1/2 text-white/30"
      >
        <ChevronDown size={28} />
      </motion.div>

    </section>
  );
}
