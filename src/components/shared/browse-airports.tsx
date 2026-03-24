import Link from "next/link";
import { Plane } from "lucide-react";
import { productionAirports } from "@/config/airports";

// Top-traffic airports to feature on the homepage
const FEATURED_CODES = [
  "JFK", "LAX", "ORD", "ATL", "MIA", "SFO", "DFW", "DEN",
  "SEA", "BOS", "EWR", "LGA", "IAH", "MCO", "PHX", "MSP",
];

export function BrowseAirports() {
  const featured = FEATURED_CODES
    .map((code) => productionAirports.find((a) => a.code === code))
    .filter(Boolean) as typeof productionAirports;

  return (
    <section className="bg-gray-50 py-16">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-10">
          <h2 className="text-2xl md:text-3xl font-bold text-gray-900">
            Browse Airport Parking
          </h2>
          <p className="text-gray-500 mt-2">
            Compare parking at {productionAirports.length}+ airports across the US and Canada
          </p>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          {featured.map((airport) => (
            <Link
              key={airport.code}
              href={`/${airport.slug}/airport-parking`}
              className="flex items-center gap-3 p-3 rounded-lg border border-gray-200 bg-white hover:border-brand-orange/30 hover:shadow-sm transition-all group"
            >
              <div className="w-8 h-8 rounded-full bg-gray-100 group-hover:bg-brand-orange/10 flex items-center justify-center shrink-0 transition-colors">
                <Plane className="w-4 h-4 text-gray-400 group-hover:text-brand-orange transition-colors" />
              </div>
              <div className="min-w-0">
                <span className="text-sm font-medium text-gray-900 block truncate">
                  {airport.city} ({airport.code})
                </span>
                <span className="text-xs text-gray-400 block truncate">
                  {airport.state}
                </span>
              </div>
            </Link>
          ))}
        </div>

        <div className="text-center mt-8">
          <Link
            href="/airport-parking"
            className="inline-flex items-center text-sm font-medium text-brand-orange hover:underline"
          >
            View all {productionAirports.length} airports &rarr;
          </Link>
        </div>
      </div>
    </section>
  );
}
