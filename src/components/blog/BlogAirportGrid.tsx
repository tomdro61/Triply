import Link from "next/link";

interface BlogAirportGridProps {
  airports: Array<{
    code: string;
    name: string;
    city: string;
  }>;
}

export function BlogAirportGrid({ airports }: BlogAirportGridProps) {
  if (airports.length === 0) return null;

  return (
    <section className="mt-16">
      <h2 className="text-2xl font-heading font-bold text-navy mb-6">
        Browse by Airport
      </h2>
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
        {airports.map((airport) => (
          <Link
            key={airport.code}
            href={`/blog/airport/${airport.code.toLowerCase()}`}
            className="px-4 py-3 bg-white rounded-lg border border-gray-200 hover:border-coral hover:shadow-sm transition-all text-center"
          >
            <span className="block text-sm font-semibold text-navy">
              {airport.code}
            </span>
            <span className="block text-xs text-gray-500 mt-1 truncate">
              {airport.city}
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}
