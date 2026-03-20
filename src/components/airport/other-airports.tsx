import Link from "next/link";
import { Airport, productionAirports } from "@/config/airports";
import { Plane } from "lucide-react";

interface OtherAirportsProps {
  currentAirport: Airport;
}

// Top-traffic airports for cross-linking
const TOP_AIRPORTS = ["JFK", "LAX", "ORD", "ATL", "MIA", "SFO", "DFW", "DEN", "SEA", "BOS"];

// Region mapping based on state
function getRegion(state: string): string {
  const northeast = ["NY", "NJ", "CT", "MA", "PA", "RI", "VT", "NH", "ME", "MD", "DE", "DC"];
  const southeast = ["FL", "GA", "NC", "SC", "VA", "TN", "AL", "MS", "LA", "KY", "WV", "AR"];
  const midwest = ["IL", "OH", "MI", "IN", "WI", "MN", "MO", "IA", "KS", "NE", "ND", "SD"];
  const west = ["CA", "WA", "OR", "NV", "AZ", "CO", "UT", "NM", "ID", "MT", "WY", "HI", "AK"];
  const south = ["TX", "OK"];

  if (northeast.includes(state)) return "Northeast";
  if (southeast.includes(state)) return "Southeast";
  if (midwest.includes(state)) return "Midwest";
  if (west.includes(state)) return "West";
  if (south.includes(state)) return "South";
  return "Other";
}

export function OtherAirports({ currentAirport }: OtherAirportsProps) {
  const currentRegion = getRegion(currentAirport.state);

  // Pick related airports: same region first, then top-traffic, excluding current
  const sameRegion = productionAirports.filter(
    (a) => a.code !== currentAirport.code && getRegion(a.state) === currentRegion
  );

  const topTraffic = productionAirports.filter(
    (a) =>
      a.code !== currentAirport.code &&
      TOP_AIRPORTS.includes(a.code) &&
      getRegion(a.state) !== currentRegion
  );

  // Combine: up to 6 same-region + fill to 12 with top-traffic
  const related = [
    ...sameRegion.slice(0, 6),
    ...topTraffic.slice(0, 12 - Math.min(sameRegion.length, 6)),
  ].slice(0, 12);

  if (related.length === 0) return null;

  return (
    <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
      <h2 className="text-2xl font-bold text-gray-900 mb-6">
        Other Airport Parking
      </h2>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
        {related.map((airport) => (
          <Link
            key={airport.code}
            href={`/${airport.slug}/airport-parking`}
            className="flex items-center gap-3 p-3 rounded-lg border border-gray-200 hover:border-brand-orange/30 hover:shadow-sm transition-all group"
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
      <div className="text-center mt-6">
        <Link
          href="/airport-parking"
          className="text-sm text-brand-orange font-medium hover:underline"
        >
          View all airports &rarr;
        </Link>
      </div>
    </section>
  );
}
