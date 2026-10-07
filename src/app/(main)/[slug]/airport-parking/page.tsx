import { Metadata } from "next";
import { notFound } from "next/navigation";
import { getAirportBySlug } from "@/config/airports";
import { fetchAirportPageData } from "@/lib/airport-page/data";
import { generateSEOContent, generateFAQs, emptyStateCopy } from "@/lib/airport-page/content";
import { buildAirportSchemas } from "@/lib/airport-page/schemas";
import { getAirportContent } from "@/data/airport-content";
import { JsonLd } from "@/components/seo/JsonLd";
import { Navbar, Footer } from "@/components/shared";
import { Newsletter } from "@/components/shared/newsletter";
import { Breadcrumbs } from "@/components/airport/breadcrumbs";
import { HeroSection } from "@/components/airport/hero-section";
import { LotGrid } from "@/components/airport/lot-grid";
import { RatesTable } from "@/components/airport/rates-table";
import { SEOContent } from "@/components/airport/seo-content";
import { AirportFAQ } from "@/components/airport/airport-faq";
import { OtherAirports } from "@/components/airport/other-airports";

export const revalidate = 3600; // ISR: 1 hour

// ISR revalidation reaches the same ~54-page ResLab location sweep as
// /api/search (fetchAirportPageData → searchParking → getChannelLocationsCached,
// budgeted at 40s). The invocation ceiling must sit above that budget so the
// build settles and arms its circuit breaker; killed mid-sweep it leaves the
// breaker un-armed, which re-opens the per-request sweep loop behind the
// 2026-08-10 outage.
export const maxDuration = 60;

interface PageProps {
  params: Promise<{ slug: string }>;
}

// No paths are prerendered at build: each airport page is rendered on its
// first request and then served from the ISR cache (revalidated hourly).
// Prerendering every production airport (~85) at build fired hundreds of
// concurrent ResLab min-price calls from every build worker; when an airport's
// calls all failed, the build baked the empty "no lots" page, which then stayed
// up for an hour or more after every deploy (77 empty after the 2026-10-06
// deploy). A failed first render now throws (data.ts) → that request gets an
// uncached error, and a later request retries once data.ts's 5-minute
// per-instance failure memo expires.
// Links to these pages set prefetch={false} so a list can't render them all
// at once either. Plan: notes/2026-10-07-airport-pages-plan-v2.md.
export async function generateStaticParams() {
  return [];
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const airport = getAirportBySlug(slug);
  if (!airport) return {};

  const [data, customContent] = await Promise.all([
    fetchAirportPageData(airport),
    getAirportContent(airport.code),
  ]);
  const priceText = data.cheapestPrice ? ` from $${data.cheapestPrice.toFixed(0)}` : "";
  // Trailing space lives in the value so a 0-lot page doesn't read "Compare  parking".
  const lotCount = data.totalLots > 0 ? `${data.totalLots}+ ` : "";

  return {
    title: `${airport.city} Airport Parking - Cheap ${airport.code} Parking Rates${priceText}`,
    description: customContent?.metaDescription
      ?? `Compare ${lotCount}parking lots near ${airport.name}. Reserve ${airport.code} parking${priceText}/day with free cancellation. Book now & save.`,
    alternates: {
      canonical: `https://www.triplypro.com/${airport.slug}/airport-parking`,
    },
    openGraph: {
      title: `${airport.code} Airport Parking${priceText}/day`,
      description: `Compare ${lotCount}parking lots near ${airport.name}. Book online and save up to 60%.`,
      url: `https://www.triplypro.com/${airport.slug}/airport-parking`,
      type: "website",
    },
  };
}

export default async function AirportParkingPage({ params }: PageProps) {
  const { slug } = await params;
  const airport = getAirportBySlug(slug);
  if (!airport) notFound();

  const [data, customContent] = await Promise.all([
    fetchAirportPageData(airport),
    getAirportContent(airport.code),
  ]);
  const seoSections = customContent?.sections ?? generateSEOContent(airport, data);
  const faqs = customContent?.faqs ?? generateFAQs(airport, data);
  const emptyState = emptyStateCopy(airport.name, data.locationsConsidered);
  // FAQPage JSON-LD only when the FAQ is actually shown (it isn't at 0 lots) —
  // Google requires FAQ markup to match visible content.
  const schemas = buildAirportSchemas(airport, data, data.totalLots > 0 ? faqs : []);

  return (
    <>
      {schemas.map((schema, idx) => (
        <JsonLd key={idx} data={schema} />
      ))}

      <Navbar forceSolid />
      <Breadcrumbs airport={airport} />
      <HeroSection airport={airport} data={data} />

      {data.totalLots > 0 ? (
        <>
          <LotGrid airport={airport} lots={data.topLots} />
          <RatesTable airport={airport} lots={data.lots} />
          <SEOContent sections={seoSections} />
          <AirportFAQ faqs={faqs} airportCode={airport.code} />
        </>
      ) : (
        <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16 text-center">
          <h2 className="text-2xl font-bold text-gray-900 mb-3">
            {emptyState.heading}
          </h2>
          <p className="text-gray-500 max-w-lg mx-auto">{emptyState.body}</p>
        </section>
      )}

      <OtherAirports currentAirport={airport} />
      <Newsletter />
      <Footer />
    </>
  );
}
