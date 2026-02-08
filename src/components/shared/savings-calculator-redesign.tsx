"use client";

import { useState, useMemo } from "react";
import { Calculator, TrendingDown, Plane } from "lucide-react";
import { ScrollReveal } from "./scroll-reveal";

const airportData: Record<string, { name: string; driveUpDaily: number; triplyDaily: number }> = {
  JFK: { name: "JFK International", driveUpDaily: 35, triplyDaily: 14 },
  LGA: { name: "LaGuardia", driveUpDaily: 32, triplyDaily: 12 },
};

export function SavingsCalculatorRedesign() {
  const [selectedAirport, setSelectedAirport] = useState("JFK");
  const [days, setDays] = useState(7);
  const [isAnimating, setIsAnimating] = useState(false);

  const savings = useMemo(() => {
    const airport = airportData[selectedAirport];
    if (!airport) return null;
    const driveUpTotal = airport.driveUpDaily * days;
    const triplyTotal = airport.triplyDaily * days;
    const savedAmount = driveUpTotal - triplyTotal;
    const savedPercent = Math.round((savedAmount / driveUpTotal) * 100);
    return { driveUpTotal, triplyTotal, savedAmount, savedPercent };
  }, [selectedAirport, days]);

  const handleChange = () => {
    setIsAnimating(true);
    setTimeout(() => setIsAnimating(false), 600);
  };

  const dayOptions = [3, 5, 7, 10, 14, 21];

  return (
    <section
      className="py-20 lg:py-24 relative overflow-hidden"
      style={{
        backgroundImage: `url('https://images.unsplash.com/photo-1530521954074-e64f6810b32d?auto=format&fit=crop&w=2000&q=80')`,
        backgroundSize: "cover",
        backgroundPosition: "center",
      }}
    >
      {/* Dark overlay */}
      <div className="absolute inset-0 bg-gradient-to-br from-[#0a0a1a]/90 via-[#1A1A2E]/92 to-[#0d1033]/90" />
      {/* Background orb */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[500px] h-[500px] rounded-full bg-brand-orange/8 blur-[150px] pointer-events-none" />

      <div className="max-w-4xl mx-auto px-4 sm:px-6 relative z-10">
        <ScrollReveal className="text-center mb-10">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-brand-orange/20 mb-5">
            <Calculator className="w-7 h-7 text-brand-orange" />
          </div>
          <h2 className="text-3xl md:text-4xl font-bold text-white mb-3">
            See How Much You Could Save
          </h2>
          <p className="text-gray-400 text-lg max-w-xl mx-auto">
            Compare drive-up rates vs. booking with Triply
          </p>
        </ScrollReveal>

        <ScrollReveal delay={0.2}>
          <div className="bg-white/15 backdrop-blur-lg border border-white/20 rounded-2xl p-6 md:p-8">
            {/* Input Row */}
            <div className="grid md:grid-cols-3 gap-8 mb-8">
              {/* Airport */}
              <div>
                <label className="block text-xs font-bold text-gray-400 uppercase tracking-wider mb-2">
                  Airport
                </label>
                <div className="relative">
                  <Plane className="absolute left-3 top-1/2 -translate-y-1/2 text-brand-orange w-5 h-5" />
                  <select
                    value={selectedAirport}
                    onChange={(e) => {
                      setSelectedAirport(e.target.value);
                      handleChange();
                    }}
                    className="w-full pl-10 pr-4 py-3 bg-white/10 border border-white/20 rounded-lg text-white focus:ring-2 focus:ring-brand-orange focus:border-transparent outline-none cursor-pointer [&>option]:text-gray-900 [&>option]:bg-white"
                  >
                    {Object.entries(airportData).map(([code, data]) => (
                      <option key={code} value={code}>
                        {code} - {data.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Days */}
              <div className="md:col-span-2">
                <label className="block text-xs font-bold text-gray-400 uppercase tracking-wider mb-2">
                  Trip Length
                </label>
                <div className="flex flex-wrap gap-2">
                  {dayOptions.map((d) => (
                    <button
                      key={d}
                      onClick={() => {
                        setDays(d);
                        handleChange();
                      }}
                      className={`px-4 py-2.5 rounded-lg text-sm font-medium transition-all ${
                        days === d
                          ? "bg-brand-orange text-white shadow-lg shadow-brand-orange/30"
                          : "bg-white/10 text-gray-300 hover:bg-white/20"
                      }`}
                    >
                      {d} days
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Results */}
            {savings && (
              <div
                className={`grid md:grid-cols-3 gap-6 transition-all duration-500 ${
                  isAnimating ? "scale-105 opacity-80" : "scale-100 opacity-100"
                }`}
              >
                {/* Drive-up */}
                <div className="bg-red-500/20 border border-red-500/30 rounded-xl p-5 text-center">
                  <p className="text-red-400 text-xs font-bold uppercase mb-1">Airport Drive-Up</p>
                  <p className="text-3xl font-bold text-red-400 line-through decoration-2">
                    ${savings.driveUpTotal}
                  </p>
                  <p className="text-gray-500 text-sm mt-1">
                    ${airportData[selectedAirport].driveUpDaily}/day
                  </p>
                </div>

                {/* Triply */}
                <div className="bg-green-500/20 border border-green-500/30 rounded-xl p-5 text-center">
                  <p className="text-green-400 text-xs font-bold uppercase mb-1">With Triply</p>
                  <p className="text-3xl font-bold text-green-400">${savings.triplyTotal}</p>
                  <p className="text-gray-500 text-sm mt-1">
                    ${airportData[selectedAirport].triplyDaily}/day
                  </p>
                </div>

                {/* Savings */}
                <div className="bg-brand-orange/25 border border-brand-orange/40 rounded-xl p-5 text-center relative overflow-hidden">
                  <div className="absolute -top-2 -right-2 bg-brand-orange text-white text-xs font-bold px-2 py-1 rounded-bl-lg">
                    {savings.savedPercent}% OFF
                  </div>
                  <p className="text-brand-orange text-xs font-bold uppercase mb-1">You Save</p>
                  <p className="text-3xl font-bold text-brand-orange flex items-center justify-center">
                    <TrendingDown className="w-6 h-6 mr-1" />
                    ${savings.savedAmount}
                  </p>
                  <p className="text-gray-400 text-sm mt-1">on your {days}-day trip</p>
                </div>
              </div>
            )}
          </div>

          <p className="text-center text-gray-500 text-sm mt-6">
            * Rates shown are averages. Actual prices may vary based on dates and availability.
          </p>
        </ScrollReveal>
      </div>

    </section>
  );
}
