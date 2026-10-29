import Link from "next/link";
import { ArrowRight, Scale } from "lucide-react";
import { Airport } from "@/config/airports";
import { getComparisonBySlug } from "@/data/comparison";

/**
 * Reciprocal internal link from the airport hub page → its comparison page.
 *
 * Renders nothing when that airport has no LIVE comparison, so this can be
 * dropped into /[slug]/airport-parking unconditionally and will stay correct
 * as pages are flipped live or back to draft in @/data/comparison — there is
 * no second list to keep in sync.
 */
export function ComparisonCallout({ airport }: { airport: Airport }) {
  const comparison = getComparisonBySlug(airport.slug);
  if (!comparison || comparison.status !== "live") return null;

  return (
    <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <Link
        href={`/${airport.slug}/spothero-vs-airportparkingreservations-vs-triply`}
        className="group flex items-start gap-4 rounded-xl border border-gray-200 bg-white p-5 hover:border-brand-orange transition-colors max-w-4xl"
      >
        <span className="rounded-lg bg-brand-orange/10 p-2.5 shrink-0">
          <Scale className="w-5 h-5 text-brand-orange" />
        </span>
        <span className="min-w-0">
          <span className="block font-semibold text-gray-900 group-hover:text-brand-orange transition-colors">
            SpotHero vs AirportParkingReservations vs Triply for {airport.city} (
            {airport.code})
          </span>
          <span className="block text-sm text-gray-600 mt-1">
            Head-to-head rates, same-lot pricing, and what each platform
            actually charges after fees.
          </span>
          <span className="mt-2 inline-flex items-center gap-1 text-sm font-medium text-brand-orange">
            See the comparison
            <ArrowRight className="w-3.5 h-3.5" />
          </span>
        </span>
      </Link>
    </section>
  );
}
