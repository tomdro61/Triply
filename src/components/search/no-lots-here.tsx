import Link from "next/link";
import { nearbyAirports } from "@/lib/search/nearby-airports";

/**
 * The zero-result state: say plainly that nothing here is bookable for these
 * dates, and offer the nearest airports for the same dates, so a search is
 * never a dead end (customer-army audit 2026-11-06, item 5). Same look as the
 * one-line message it replaces.
 */
export function NoLotsHere({
  airportCode,
  checkin,
  checkout,
}: {
  airportCode: string;
  checkin: string;
  checkout: string;
}) {
  const nearby = nearbyAirports(airportCode);
  const href = (code: string) => {
    const p = new URLSearchParams({ airport: code });
    if (checkin) p.set("checkin", checkin);
    if (checkout) p.set("checkout", checkout);
    return `/search?${p.toString()}`;
  };

  return (
    <div className="text-center py-12 px-4">
      <p className="text-gray-700 font-medium">No lots at {airportCode} can be booked online for these dates.</p>
      {nearby.length > 0 && (
        <>
          <p className="text-gray-500 text-sm mt-3">Try a nearby airport for the same dates:</p>
          <div className="flex flex-wrap justify-center gap-2 mt-2">
            {nearby.map(({ airport, miles }) => (
              <Link
                key={airport.code}
                href={href(airport.code)}
                prefetch={false}
                className="inline-flex items-center px-3 py-1.5 bg-white border border-gray-200 rounded-full text-sm text-gray-700 font-medium hover:border-brand-orange"
              >
                {airport.city} ({airport.code}) · {Math.round(miles)} mi
              </Link>
            ))}
          </div>
        </>
      )}
      <p className="text-sm mt-4">
        <Link href="/airport-parking" prefetch={false} className="text-brand-orange hover:underline">
          See all airports
        </Link>
      </p>
    </div>
  );
}
