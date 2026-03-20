import { Airport } from "@/config/airports";
import { AirportPageData } from "@/lib/airport-page/data";
import { Star, ShieldCheck, Clock } from "lucide-react";
import { SearchWidget } from "./search-widget";

interface HeroSectionProps {
  airport: Airport;
  data: AirportPageData;
}

export function HeroSection({ airport, data }: HeroSectionProps) {
  const { totalLots, cheapestPrice } = data;

  return (
    <section className="relative bg-gradient-to-br from-brand-dark via-brand-dark to-[#2a2a4e] py-16 lg:py-20">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-10">
          <h1 className="text-3xl md:text-5xl font-bold text-white mb-4">
            {airport.city} Airport Parking
            <span className="block text-lg md:text-2xl font-normal text-gray-300 mt-2">
              {airport.name} ({airport.code})
            </span>
          </h1>
          <p className="text-gray-400 text-base md:text-lg max-w-2xl mx-auto">
            {totalLots > 0
              ? `Compare ${totalLots} parking ${totalLots === 1 ? "lot" : "lots"} near ${airport.code}${cheapestPrice ? ` from $${cheapestPrice.toFixed(2)}/day` : ""}. Book online & save.`
              : `Find and compare parking options near ${airport.name}.`}
          </p>

          {/* Trust badges */}
          <div className="flex flex-wrap justify-center gap-4 md:gap-6 mt-6">
            <div className="flex items-center text-sm text-gray-300">
              <ShieldCheck className="w-4 h-4 text-brand-orange mr-1.5" />
              Free Cancellation
            </div>
            <div className="flex items-center text-sm text-gray-300">
              <Star className="w-4 h-4 text-brand-orange mr-1.5" />
              Verified Partners
            </div>
            <div className="flex items-center text-sm text-gray-300">
              <Clock className="w-4 h-4 text-brand-orange mr-1.5" />
              Instant Confirmation
            </div>
          </div>
        </div>

        <SearchWidget airportCode={airport.code} />
      </div>
    </section>
  );
}
