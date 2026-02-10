"use client";

import { useEffect, useState, useMemo, useRef } from "react";
import {
  Search,
  GitCompareArrows,
  MousePointerClick,
  Award,
  CalendarX,
  ShieldCheck,
  Headphones,
  TrendingDown,
  Plane,
  Sparkles,
  ArrowRight,
} from "lucide-react";

// --- Airport data for savings calculator ---

const airportData: Record<string, { name: string; driveUpDaily: number; triplyDaily: number }> = {
  JFK: { name: "JFK International", driveUpDaily: 35, triplyDaily: 14 },
  LGA: { name: "LaGuardia", driveUpDaily: 32, triplyDaily: 12 },
};

const dayOptions = [3, 5, 7, 10, 14, 21];

// --- How it works steps ---

const steps = [
  {
    step: 1,
    icon: Search,
    title: "Search",
    description:
      "Enter your airport and travel dates to instantly see 100+ parking options.",
    iconBg: "bg-blue-500/10",
    iconColor: "text-blue-500",
  },
  {
    step: 2,
    icon: GitCompareArrows,
    title: "Compare",
    description:
      "Sort by price, distance, and rating. Every fee is shown upfront — no surprises.",
    iconBg: "bg-green-500/10",
    iconColor: "text-green-500",
  },
  {
    step: 3,
    icon: MousePointerClick,
    title: "Book",
    description:
      "Reserve your spot in seconds. Free cancellation on most bookings.",
    iconBg: "bg-brand-orange/10",
    iconColor: "text-brand-orange",
  },
];

// --- Trust props ---

const trustProps = [
  { icon: CalendarX, label: "Free Cancellation", description: "Cancel most bookings for free up to 24 hours before check-in.", iconColor: "text-purple-400" },
  { icon: Award, label: "Best Price Guarantee", description: "Find a lower price elsewhere and we'll match it — guaranteed.", iconColor: "text-brand-orange" },
  { icon: ShieldCheck, label: "Verified Partners", description: "Every lot is vetted for security, quality, and reliability.", iconColor: "text-teal-400" },
  { icon: Headphones, label: "24/7 Support", description: "Real humans ready to help via phone, email, or chat.", iconColor: "text-blue-400" },
];

// --- Component ---

export function Comparison() {
  const [isVisible, setIsVisible] = useState(false);
  const sectionRef = useRef<HTMLDivElement>(null);
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

  const handleCalculate = () => {
    setIsAnimating(true);
    setTimeout(() => setIsAnimating(false), 600);
  };

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setIsVisible(true);
        }
      },
      { threshold: 0.15 }
    );

    if (sectionRef.current) {
      observer.observe(sectionRef.current);
    }

    return () => observer.disconnect();
  }, []);

  return (
    <section
      ref={sectionRef}
      className="py-20 lg:py-28 relative overflow-hidden"
      style={{
        backgroundImage: `url('https://images.unsplash.com/photo-1436491865332-7a61a109cc05?auto=format&fit=crop&w=2000&q=80')`,
        backgroundSize: "cover",
        backgroundPosition: "center",
      }}
    >
      {/* Dark overlay */}
      <div className="absolute inset-0 bg-gradient-to-br from-[#0a0a1a]/92 via-[#1A1A2E]/93 to-[#0d1033]/92" />

      {/* Floating orb */}
      <div className="absolute top-20 right-20 w-96 h-96 bg-brand-orange/8 rounded-full blur-3xl pointer-events-none" />

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10">
        {/* ── Header ── */}
        <div className="text-center mb-16">
          <div className="inline-flex items-center gap-2 bg-brand-orange/10 border border-brand-orange/20 rounded-full px-4 py-2 mb-6">
            <Sparkles className="w-4 h-4 text-brand-orange" />
            <span className="text-brand-orange font-bold text-sm uppercase tracking-wider">
              Why Choose Triply?
            </span>
          </div>

          <h2 className="text-3xl md:text-5xl font-bold text-white mb-4 leading-tight">
            The Smart Way to
            <br />
            <span className="text-brand-orange">Book Airport Parking</span>
          </h2>

          <p className="text-gray-300 text-lg md:text-xl max-w-2xl mx-auto">
            Stop overpaying and wasting time. Triply brings transparency,
            savings, and peace of mind to every booking.
          </p>
        </div>

        {/* ── Everything You Need ── */}
        <div className="mb-16">
          <h3 className="text-2xl md:text-3xl font-bold text-white text-center mb-10">
            Everything You Need in One Platform
          </h3>

          {/* Search, Compare, Book */}
          <div className="relative grid grid-cols-1 md:grid-cols-[1fr_auto_1fr_auto_1fr] items-stretch gap-4 md:gap-0 max-w-5xl mx-auto mb-6">
            {steps.map((s, i) => {
              const Icon = s.icon;
              return (
                <div key={i} className="contents">
                  <div
                    className={`bg-white/10 backdrop-blur-sm border border-white/15 rounded-2xl p-6 hover:bg-white/10 hover:border-brand-orange/30 transition-all duration-300 group text-center ${
                      isVisible ? "animate-fade-in-up" : "opacity-0"
                    }`}
                    style={{
                      animationDelay: isVisible ? `${i * 150}ms` : "0ms",
                      animationFillMode: "forwards",
                    }}
                  >
                    <div className="relative inline-block mb-4">
                      <div
                        className={`inline-flex items-center justify-center w-16 h-16 rounded-xl ${s.iconBg} group-hover:scale-110 transition-transform duration-300`}
                      >
                        <Icon className={`w-8 h-8 ${s.iconColor}`} />
                      </div>
                      <div className="absolute -top-2 -right-2 w-6 h-6 bg-brand-orange text-white text-xs font-bold rounded-full flex items-center justify-center shadow-lg">
                        {s.step}
                      </div>
                    </div>

                    <h4 className="text-xl font-bold text-white mb-2 group-hover:text-brand-orange transition-colors">
                      {s.title}
                    </h4>

                    <p className="text-gray-400 text-sm leading-relaxed">
                      {s.description}
                    </p>
                  </div>

                  {/* Arrow connector */}
                  {i < steps.length - 1 && (
                    <div className="hidden md:flex items-center justify-center px-2">
                      <ArrowRight className="w-6 h-6 text-brand-orange/60 flex-shrink-0" />
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Trust props */}

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 md:gap-6 max-w-5xl mx-auto">
            {trustProps.map((t, i) => {
              const Icon = t.icon;
              return (
                <div
                  key={i}
                  className={`bg-white/10 backdrop-blur-sm border border-white/15 rounded-xl p-5 text-center hover:bg-white/10 transition-all duration-300 group ${
                    isVisible ? "animate-fade-in-up" : "opacity-0"
                  }`}
                  style={{
                    animationDelay: isVisible ? `${450 + i * 100}ms` : "0ms",
                    animationFillMode: "forwards",
                  }}
                >
                  <Icon className={`w-7 h-7 ${t.iconColor} mx-auto mb-3 group-hover:scale-110 transition-transform duration-300`} />
                  <h4 className="text-white font-bold text-sm mb-1">{t.label}</h4>
                  <p className="text-gray-400 text-xs leading-relaxed">{t.description}</p>
                </div>
              );
            })}
          </div>
        </div>

        {/* ── Savings Calculator ── */}
        <div className="max-w-4xl mx-auto mb-16">
          <h3 className="text-2xl md:text-3xl font-bold text-white text-center mb-3">
            See How Much You Save
          </h3>
          <p className="text-gray-400 text-center mb-8">
            Compare on-site airport rates vs. booking with Triply
          </p>

          <div className="bg-white/10 backdrop-blur-lg border border-white/20 rounded-2xl p-6 md:p-8">
            {/* Inputs */}
            <div className="grid md:grid-cols-3 gap-8 mb-8">
              {/* Airport */}
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

              {/* Trip Length */}
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
                      className={`px-4 py-2.5 rounded-lg text-sm font-medium transition-all cursor-pointer ${
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
                {/* On-site */}
                <div className="bg-red-500/15 border border-red-500/25 rounded-xl p-5 text-center">
                  <p className="text-red-400 text-xs font-bold uppercase mb-1">
                    On-Site Airport
                  </p>
                  <p className="text-3xl font-bold text-red-400 line-through decoration-2">
                    ${savings.driveUpTotal}
                  </p>
                  <p className="text-gray-500 text-sm mt-1">
                    ${airportData[selectedAirport].driveUpDaily}/day
                  </p>
                </div>

                {/* Triply */}
                <div className="bg-green-500/15 border border-green-500/25 rounded-xl p-5 text-center">
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
                <div className="bg-brand-orange/25 border border-brand-orange/40 rounded-xl p-5 text-center relative overflow-hidden">
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

          <p className="text-center text-gray-500 text-sm mt-4">
            * Rates shown are averages. Actual prices may vary based on dates and availability.
          </p>
        </div>

        {/* ── CTA ── */}
        <div className="text-center">
          <a
            href="/search"
            className="inline-flex items-center gap-3 bg-brand-orange text-white font-bold px-10 py-5 rounded-full hover:bg-white hover:text-brand-dark transition-all duration-300 shadow-2xl shadow-brand-orange/40 hover:shadow-xl hover:scale-105 text-lg cursor-pointer"
          >
            Start Saving Now
            <ArrowRight size={24} />
          </a>
          <p className="text-gray-400 text-sm mt-4">
            No signup required &middot; Best Price Guarantee &middot; Free to
            use
          </p>
        </div>
      </div>
    </section>
  );
}
