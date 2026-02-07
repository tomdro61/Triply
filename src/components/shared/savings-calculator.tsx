"use client";

import { useState, useMemo } from "react";
import { Calculator, TrendingDown, Plane } from "lucide-react";

interface SavingsData {
  airport: string;
  days: number;
  driveUpRate: number;
  triplyRate: number;
}

const airportData: Record<string, { name: string; driveUpDaily: number; triplyDaily: number }> = {
  JFK: { name: "JFK International", driveUpDaily: 35, triplyDaily: 14 },
  LGA: { name: "LaGuardia", driveUpDaily: 32, triplyDaily: 12 },
};

export function SavingsCalculator() {
  const [selectedAirport, setSelectedAirport] = useState<string>("JFK");
  const [days, setDays] = useState<number>(7);
  const [isAnimating, setIsAnimating] = useState(false);

  const savings = useMemo(() => {
    const airport = airportData[selectedAirport];
    if (!airport) return null;

    const driveUpTotal = airport.driveUpDaily * days;
    const triplyTotal = airport.triplyDaily * days;
    const savedAmount = driveUpTotal - triplyTotal;
    const savedPercent = Math.round((savedAmount / driveUpTotal) * 100);

    return {
      driveUpTotal,
      triplyTotal,
      savedAmount,
      savedPercent,
    };
  }, [selectedAirport, days]);

  const handleCalculate = () => {
    setIsAnimating(true);
    setTimeout(() => setIsAnimating(false), 600);
  };

  const dayOptions = [3, 5, 7, 10, 14, 21];

  return (
    <section className="py-20 lg:py-24 bg-gradient-to-br from-brand-dark via-gray-900 to-brand-dark relative overflow-hidden">
      {/* Background decoration */}
      <div className="absolute inset-0 opacity-10">
        <div className="absolute top-20 left-10 w-72 h-72 bg-brand-orange rounded-full blur-3xl" />
        <div className="absolute bottom-20 right-10 w-96 h-96 bg-brand-blue rounded-full blur-3xl" />
      </div>

      <div className="max-w-4xl mx-auto px-4 sm:px-6 relative z-10">
        <div className="text-center mb-10">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-brand-orange/20 mb-6">
            <Calculator className="w-8 h-8 text-brand-orange" />
          </div>
          <h2 className="text-3xl md:text-4xl font-bold text-white mb-3">
            See How Much You Could Save
          </h2>
          <p className="text-gray-400 text-lg max-w-xl mx-auto">
            Compare drive-up rates vs. booking with Triply
          </p>
        </div>

        <div className="bg-white/5 backdrop-blur-sm border border-white/10 rounded-2xl p-6 md:p-8">
          {/* Input Row */}
          <div className="grid md:grid-cols-3 gap-8 mb-8">
            {/* Airport Selection */}
            <div>
              <label className="block text-xs font-bold text-gray-400 uppercase mb-2">
                Airport
              </label>
              <div className="relative">
                <Plane className="absolute left-3 top-1/2 -translate-y-1/2 text-brand-orange w-5 h-5" />
                <select
                  value={selectedAirport}
                  onChange={(e) => {
                    setSelectedAirport(e.target.value);
                    handleCalculate();
                  }}
                  className="w-full pl-10 pr-4 py-3 bg-white/10 border border-white/20 rounded-lg text-white focus:ring-2 focus:ring-brand-orange focus:border-transparent outline-none cursor-pointer"
                >
                  {Object.entries(airportData).map(([code, data]) => (
                    <option key={code} value={code} className="text-gray-900">
                      {code} - {data.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Days Selection */}
            <div className="md:col-span-2">
              <label className="block text-xs font-bold text-gray-400 uppercase mb-2">
                Trip Length
              </label>
              <div className="flex flex-wrap gap-2">
                {dayOptions.map((d) => (
                  <button
                    key={d}
                    onClick={() => {
                      setDays(d);
                      handleCalculate();
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
              {/* Drive-up Price */}
              <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-5 text-center">
                <p className="text-red-400 text-xs font-bold uppercase mb-1">
                  Airport Drive-Up
                </p>
                <p className="text-3xl font-bold text-red-400 line-through decoration-2">
                  ${savings.driveUpTotal}
                </p>
                <p className="text-gray-500 text-sm mt-1">
                  ${airportData[selectedAirport].driveUpDaily}/day
                </p>
              </div>

              {/* Triply Price */}
              <div className="bg-green-500/10 border border-green-500/20 rounded-xl p-5 text-center">
                <p className="text-green-400 text-xs font-bold uppercase mb-1">
                  With Triply
                </p>
                <p className="text-3xl font-bold text-green-400">
                  ${savings.triplyTotal}
                </p>
                <p className="text-gray-500 text-sm mt-1">
                  ${airportData[selectedAirport].triplyDaily}/day
                </p>
              </div>

              {/* Savings */}
              <div className="bg-brand-orange/20 border border-brand-orange/30 rounded-xl p-5 text-center relative overflow-hidden">
                <div className="absolute -top-2 -right-2 bg-brand-orange text-white text-xs font-bold px-2 py-1 rounded-bl-lg">
                  {savings.savedPercent}% OFF
                </div>
                <p className="text-brand-orange text-xs font-bold uppercase mb-1">
                  You Save
                </p>
                <p className="text-3xl font-bold text-brand-orange flex items-center justify-center">
                  <TrendingDown className="w-6 h-6 mr-1" />
                  ${savings.savedAmount}
                </p>
                <p className="text-gray-400 text-sm mt-1">
                  on your {days}-day trip
                </p>
              </div>
            </div>
          )}
        </div>

        <p className="text-center text-gray-500 text-sm mt-6">
          * Rates shown are averages. Actual prices may vary based on dates and availability.
        </p>
      </div>
    </section>
  );
}
