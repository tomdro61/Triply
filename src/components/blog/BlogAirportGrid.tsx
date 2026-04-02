import Link from "next/link";

interface BlogAirportGridProps {
  airports: Array<{
    code: string;
    name: string;
    city: string;
  }>;
  activeCode?: string;
}

export function BlogAirportGrid({ airports, activeCode }: BlogAirportGridProps) {
  if (airports.length === 0) return null;

  return (
    <div>
      <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">
        Browse by Airport
      </h3>
      <div className="flex flex-wrap gap-2">
        {airports.map((airport) => (
          <Link
            key={airport.code}
            href={`/blog/airport/${airport.code.toLowerCase()}`}
            className={`px-3 py-1.5 text-sm font-medium rounded-full transition-colors ${
              activeCode?.toUpperCase() === airport.code
                ? "bg-coral text-white"
                : "bg-gray-100 text-gray-700 hover:bg-gray-200"
            }`}
          >
            {airport.code}
          </Link>
        ))}
      </div>
    </div>
  );
}
