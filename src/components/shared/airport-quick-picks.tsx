"use client";

import { useRouter } from "next/navigation";
import { MapPin, DollarSign, Plane } from "lucide-react";
import { ScrollReveal } from "./scroll-reveal";

const airports = [
  {
    code: "JFK",
    name: "JFK International",
    city: "New York, NY",
    spots: "100+",
    priceFrom: 14,
    gradient: "from-[#1A1A2E] to-[#2a2a4e]",
  },
  {
    code: "LGA",
    name: "LaGuardia Airport",
    city: "New York, NY",
    spots: "80+",
    priceFrom: 12,
    gradient: "from-[#0f172a] to-[#1e3a5f]",
  },
];

export function AirportQuickPicks() {
  const router = useRouter();

  const handleClick = (code: string) => {
    const checkin = new Date();
    checkin.setDate(checkin.getDate() + 1);
    const checkout = new Date();
    checkout.setDate(checkout.getDate() + 8);

    const params = new URLSearchParams({
      airport: code,
      checkin: checkin.toISOString().split("T")[0],
      checkout: checkout.toISOString().split("T")[0],
      type: "parking",
    });

    router.push(`/search?${params.toString()}`);
  };

  return (
    <section className="py-16 lg:py-20">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
        <ScrollReveal>
          <p className="text-brand-orange font-bold text-sm uppercase tracking-wider mb-3">
            Popular Airports
          </p>
          <h2 className="text-3xl md:text-4xl font-bold text-gray-900">
            Find Parking at Your Airport
          </h2>
        </ScrollReveal>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-10">
          {airports.map((airport, index) => (
            <ScrollReveal key={airport.code} delay={index * 0.15}>
              <div
                onClick={() => handleClick(airport.code)}
                className={`relative overflow-hidden rounded-2xl bg-gradient-to-br ${airport.gradient} h-[240px] md:h-[320px] group cursor-pointer transition-transform duration-500 hover:scale-[1.02]`}
              >
                {/* Subtle ambient orb */}
                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[300px] h-[300px] rounded-full bg-brand-orange/5 blur-[100px] pointer-events-none" />

                {/* Decorative airport code */}
                <div className="absolute top-4 right-6 text-white/[0.06] text-[120px] md:text-[160px] font-bold leading-none pointer-events-none select-none">
                  {airport.code}
                </div>

                {/* Content */}
                <div className="absolute bottom-0 left-0 right-0 p-6 md:p-8">
                  <div className="flex items-center gap-2 mb-2">
                    <Plane size={18} className="text-brand-orange" />
                    <span className="text-white/60 text-sm">{airport.city}</span>
                  </div>
                  <h3 className="text-2xl md:text-3xl font-bold text-white mb-3">
                    {airport.name}
                  </h3>
                  <div className="flex items-center gap-5 text-white/60 text-sm">
                    <span className="flex items-center gap-1.5">
                      <MapPin size={14} />
                      {airport.spots} spots
                    </span>
                    <span className="flex items-center gap-1.5">
                      <DollarSign size={14} />
                      From ${airport.priceFrom}/day
                    </span>
                  </div>

                  {/* Hover CTA */}
                  <div className="mt-4 opacity-0 translate-y-2 group-hover:opacity-100 group-hover:translate-y-0 transition-all duration-300">
                    <span className="inline-flex items-center gap-2 bg-brand-orange text-white text-sm font-medium px-4 py-2 rounded-lg">
                      Search Parking &rarr;
                    </span>
                  </div>
                </div>
              </div>
            </ScrollReveal>
          ))}
        </div>
      </div>
    </section>
  );
}
