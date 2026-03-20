import Link from "next/link";
import Image from "next/image";
import { Airport } from "@/config/airports";
import { UnifiedLot } from "@/types/lot";
import { MapPin, Bus, ArrowRight } from "lucide-react";

interface LotGridProps {
  airport: Airport;
  lots: UnifiedLot[];
}

function LotCard({ lot, airportSlug }: { lot: UnifiedLot; airportSlug: string }) {
  const photoUrl = lot.photos[0]?.url || "/placeholder-parking.jpg";
  const price = lot.pricing?.minPrice;
  const distance = lot.distanceFromAirport;
  const topAmenities = lot.amenities.slice(0, 3);

  return (
    <Link
      href={`/${airportSlug}/airport-parking/${lot.sourceId}`}
      className="group bg-white rounded-xl border border-gray-200 overflow-hidden hover:shadow-lg hover:border-brand-orange/30 transition-all"
    >
      <div className="relative h-40 bg-gray-100">
        <Image
          src={photoUrl}
          alt={lot.name}
          fill
          className="object-cover group-hover:scale-105 transition-transform duration-300"
          sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
        />
        {lot.availability === "limited" && (
          <span className="absolute top-2 right-2 bg-red-500 text-white text-xs font-medium px-2 py-0.5 rounded-full">
            Limited Spots
          </span>
        )}
      </div>
      <div className="p-4">
        <h3 className="font-semibold text-gray-900 text-sm line-clamp-1 group-hover:text-brand-orange transition-colors">
          {lot.name}
        </h3>

        <div className="flex items-center gap-3 mt-2 text-xs text-gray-500">
          {distance !== undefined && (
            <span className="flex items-center gap-1">
              <MapPin className="w-3 h-3" />
              {distance.toFixed(1)} mi
            </span>
          )}
          {lot.shuttleInfo && (
            <span className="flex items-center gap-1">
              <Bus className="w-3 h-3" />
              Shuttle
            </span>
          )}
        </div>

        {topAmenities.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-2">
            {topAmenities.map((a) => (
              <span
                key={a.id}
                className="text-[11px] bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full"
              >
                {a.displayName}
              </span>
            ))}
          </div>
        )}

        {price !== undefined && (
          <div className="mt-3 flex items-center justify-between">
            <div>
              <span className="text-lg font-bold text-brand-orange">
                ${price.toFixed(2)}
              </span>
              <span className="text-xs text-gray-400">/day</span>
            </div>
            <span className="text-xs text-brand-orange font-medium group-hover:underline flex items-center gap-0.5">
              View Details <ArrowRight className="w-3 h-3" />
            </span>
          </div>
        )}
      </div>
    </Link>
  );
}

export function LotGrid({ airport, lots }: LotGridProps) {
  if (lots.length === 0) return null;

  return (
    <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold text-gray-900">
          Top Parking Near {airport.code}
        </h2>
        <Link
          href={`/search?airport=${airport.code}`}
          className="text-sm text-brand-orange font-medium hover:underline flex items-center gap-1"
        >
          View all lots <ArrowRight className="w-4 h-4" />
        </Link>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
        {lots.map((lot) => (
          <LotCard key={lot.id} lot={lot} airportSlug={airport.slug} />
        ))}
      </div>
    </section>
  );
}
