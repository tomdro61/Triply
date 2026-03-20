import Link from "next/link";
import { Airport } from "@/config/airports";
import { UnifiedLot } from "@/types/lot";
import { ArrowRight } from "lucide-react";

interface RatesTableProps {
  airport: Airport;
  lots: UnifiedLot[];
}

export function RatesTable({ airport, lots }: RatesTableProps) {
  // Show lots that have pricing, sorted by price ascending
  const pricedLots = lots
    .filter((l) => l.pricing?.minPrice !== undefined && l.pricing.minPrice > 0)
    .sort((a, b) => (a.pricing?.minPrice ?? 0) - (b.pricing?.minPrice ?? 0))
    .slice(0, 10);

  if (pricedLots.length === 0) return null;

  return (
    <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
      <h2 className="text-2xl font-bold text-gray-900 mb-2">
        {airport.code} Parking Rates
      </h2>
      <p className="text-sm text-gray-500 mb-6">
        Rates shown for a sample 7-day trip. Actual rates vary by dates.
      </p>

      <div className="overflow-x-auto">
        <table className="w-full text-left">
          <thead>
            <tr className="border-b border-gray-200">
              <th className="py-3 pr-4 text-sm font-semibold text-gray-600">Parking Lot</th>
              <th className="py-3 px-4 text-sm font-semibold text-gray-600 hidden sm:table-cell">Distance</th>
              <th className="py-3 px-4 text-sm font-semibold text-gray-600 hidden md:table-cell">Shuttle</th>
              <th className="py-3 pl-4 text-sm font-semibold text-gray-600 text-right">Daily Rate</th>
              <th className="py-3 pl-4 text-sm font-semibold text-gray-600 text-right w-20"></th>
            </tr>
          </thead>
          <tbody>
            {pricedLots.map((lot, idx) => (
              <tr
                key={lot.id}
                className={`border-b border-gray-100 hover:bg-gray-50 transition-colors ${idx === 0 ? "bg-orange-50/50" : ""}`}
              >
                <td className="py-3.5 pr-4">
                  <span className="text-sm font-medium text-gray-900">{lot.name}</span>
                  {idx === 0 && (
                    <span className="ml-2 text-[10px] bg-brand-orange text-white px-1.5 py-0.5 rounded-full font-medium">
                      Best Price
                    </span>
                  )}
                </td>
                <td className="py-3.5 px-4 text-sm text-gray-500 hidden sm:table-cell">
                  {lot.distanceFromAirport !== undefined
                    ? `${lot.distanceFromAirport.toFixed(1)} mi`
                    : "—"}
                </td>
                <td className="py-3.5 px-4 text-sm text-gray-500 hidden md:table-cell">
                  {lot.shuttleInfo ? "Yes" : "—"}
                </td>
                <td className="py-3.5 pl-4 text-right">
                  <span className="text-sm font-bold text-brand-orange">
                    ${lot.pricing!.minPrice.toFixed(2)}
                  </span>
                  <span className="text-xs text-gray-400">/day</span>
                </td>
                <td className="py-3.5 pl-4 text-right">
                  <Link
                    href={`/${airport.slug}/airport-parking/${lot.sourceId}`}
                    className="text-xs text-brand-orange hover:underline font-medium inline-flex items-center gap-0.5"
                  >
                    Book <ArrowRight className="w-3 h-3" />
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
