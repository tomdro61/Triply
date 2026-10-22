import { Metadata } from "next";
import { notFound } from "next/navigation";
import { getAirportBySlug } from "@/config/airports";
import { fetchAirportPageData } from "@/lib/airport-page/data";
import { getComparisonBySlug, liveComparisons } from "@/data/comparison";
import { buildComparisonView, buildComparisonSchemas, comparisonUrl } from "@/lib/comparison/build";
import { JsonLd } from "@/components/seo/JsonLd";
import { Navbar, Footer } from "@/components/shared";
import { Newsletter } from "@/components/shared/newsletter";
import { AirportFAQ } from "@/components/airport/airport-faq";
import { ComparisonBody } from "@/components/comparison/comparison-body";

// Matches the sibling airport page. Both pull the same React-cached ResLab
// data, so an aligned window keeps this page's headline rate consistent with
// the hub page it links to — a visitor who clicks through should not see the
// price change.
export const revalidate = 3600;

// ISR revalidation reaches the same ~54-page ResLab location sweep as
// /[slug]/airport-parking (fetchAirportPageData → searchParking →
// getChannelLocationsCached, budgeted at 40s). The invocation ceiling must sit
// above that budget so the build settles and arms its circuit breaker; killed
// mid-sweep it leaves the breaker un-armed, which re-opens the per-request
// sweep loop behind the 2026-08-10 outage. Do not lower this.
export const maxDuration = 60;

interface PageProps {
  params: Promise<{ slug: string }>;
}

export async function generateStaticParams() {
  // Only "live" comparisons prerender. A "draft" entry still resolves through
  // the dynamic segment, and is 404'd in the component below.
  return liveComparisons.map((c) => ({ slug: c.slug }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const airport = getAirportBySlug(slug);
  const comparison = getComparisonBySlug(slug);
  if (!airport || !comparison || comparison.status !== "live") return {};

  const data = await fetchAirportPageData(airport);
  const view = buildComparisonView(airport, comparison, data);
  const url = comparisonUrl(slug);

  // Only front-load a price in the title/meta when the live number backs it.
  // Promoting a rate we can't currently verify is the exact failure the blog
  // engine's rate-staleness guard exists to prevent — worse here, because a
  // comparison title is a direct claim about a named competitor.
  const priceBit =
    view.pricesAsserted && view.triplyFrom !== null
      ? ` from $${view.triplyFrom.toFixed(2)}/day`
      : "";

  return {
    title: `SpotHero vs APR vs Triply — ${airport.city} (${airport.code}) Parking Compared 2026`,
    description:
      `We compared SpotHero, AirportParkingReservations, and Triply Pro for ${airport.name} off-airport parking` +
      `${priceBit ? ` — Triply lists lots${priceBit}` : ""}. Head-to-head rates, same-lot pricing, shuttles, and all-in totals.`,
    alternates: { canonical: url },
    openGraph: {
      title: `SpotHero vs APR vs Triply — ${airport.code} Parking Compared`,
      description: `Head-to-head off-airport parking rates at ${airport.name}, with all-in totals and same-lot pricing.`,
      url,
      type: "article",
    },
  };
}

export default async function ComparisonPage({ params }: PageProps) {
  const { slug } = await params;
  const airport = getAirportBySlug(slug);
  const comparison = getComparisonBySlug(slug);

  // Three ways to miss: an airport with no comparison written, a comparison
  // held in draft, or a slug that isn't an airport at all. All 404 — this
  // route lives under [slug], so without the guard every one of the ~85
  // airport slugs would resolve to an empty comparison page.
  if (!airport || !comparison || comparison.status !== "live") notFound();

  const data = await fetchAirportPageData(airport);
  const view = buildComparisonView(airport, comparison, data);
  const schemas = buildComparisonSchemas(view);

  return (
    <>
      {schemas.map((schema, idx) => (
        <JsonLd key={idx} data={schema} />
      ))}

      <Navbar forceSolid />
      <ComparisonBody view={view} />
      <AirportFAQ faqs={view.faqs} airportCode={airport.code} />
      <Newsletter />
      <Footer />
    </>
  );
}
