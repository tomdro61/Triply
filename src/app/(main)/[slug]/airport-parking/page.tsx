import { Metadata } from "next";
import { notFound } from "next/navigation";
import { getAirportBySlug } from "@/config/airports";
import { fetchAirportPageData } from "@/lib/airport-page/data";
import {
  generateSEOContent,
  generateFAQs,
  emptyStateCopy,
  isKnownEmpty,
  emptyMetaDescription,
} from "@/lib/airport-page/content";
import { buildAirportSchemas } from "@/lib/airport-page/schemas";
import { getAirportContent } from "@/data/airport-content";
import { getNoLotsAirportContent } from "@/data/airport-content/no-lots";
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
import { ComparisonCallout } from "@/components/comparison/comparison-callout";
import { AirportGuides } from "@/components/airport/airport-guides";

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

  const [data, customContent, noLotsGuide] = await Promise.all([
    fetchAirportPageData(airport),
    getAirportContent(airport.code),
    getNoLotsAirportContent(airport.code),
  ]);
  const priceText = data.cheapestPrice ? ` from $${data.cheapestPrice.toFixed(0)}` : "";
  // Trailing space lives in the value so a 0-lot page doesn't read "Compare  parking".
  const lotCount = data.totalLots > 0 ? `${data.totalLots}+ ` : "";
  // Nothing bookable: don't let a hand-written meta (SLC's "6+ lots from
  // $6.50/day") advertise inventory the page can't sell. Every airport page
  // stays indexable, including ones listing no lots yet (Vin, 10 Nov 2026:
  // index every page to reach more customers).
  const empty = isKnownEmpty(data.totalLots, data.locationsConsidered);
  const description = empty
    ? noLotsGuide?.metaDescription ?? emptyMetaDescription(airport.name, airport.code)
    : customContent?.metaDescription
      ?? `Compare ${lotCount}parking lots near ${airport.name}. Reserve ${airport.code} parking${priceText}/day with free cancellation. Book now & save.`;

  return {
    // Nothing bookable: no "Cheap … Rates" promise in the search result, and
    // "Guide" only when the guide is on the page.
    title: !empty
      ? `${airport.city} Airport Parking - Cheap ${airport.code} Parking Rates${priceText}`
      : noLotsGuide
        ? `${airport.city} Airport Parking Guide (${airport.code})`
        : `${airport.city} Airport Parking (${airport.code})`,
    description,
    alternates: {
      canonical: `https://www.triplypro.com/${airport.slug}/airport-parking`,
    },
    openGraph: {
      title: `${airport.code} Airport Parking${priceText ? `${priceText}/day` : ""}`,
      description: empty
        ? description
        : `Compare ${lotCount}parking lots near ${airport.name}. Book online and save up to 60%.`,
      url: `https://www.triplypro.com/${airport.slug}/airport-parking`,
      type: "website",
    },
  };
}

export default async function AirportParkingPage({ params }: PageProps) {
  const { slug } = await params;
  const airport = getAirportBySlug(slug);
  if (!airport) notFound();

  const [data, customContent, noLotsContent] = await Promise.all([
    fetchAirportPageData(airport),
    getAirportContent(airport.code),
    getNoLotsAirportContent(airport.code),
  ]);
  // Nothing to book: show the no-lots guide (the airport's own parking,
  // transit, nearby airports) when one exists, so the page still helps.
  // Same test as the metadata (isKnownEmpty), so the guide and its meta
  // description always appear together.
  const noLotsGuide = isKnownEmpty(data.totalLots, data.locationsConsidered) ? noLotsContent : null;
  const seoSections = customContent?.sections ?? generateSEOContent(airport, data);
  const faqs = customContent?.faqs ?? generateFAQs(airport, data);
  // Above a guide, say plainly that nothing is bookable here, with no
  // "Coming Soon" / "expanding our inventory" promise (nothing backs one at
  // DAL or RSW) and no pointer to a search that would come back empty.
  const emptyState = noLotsGuide
    ? {
        heading: `No Lots to Book at ${airport.code} Right Now`,
        body: `Triply has no bookable lots at ${airport.name} at the moment. Below is the airport's own parking, transit and pickup information.`,
      }
    : emptyStateCopy(airport.name, data.locationsConsidered);
  // FAQPage JSON-LD only for the FAQ actually on screen (Google requires FAQ
  // markup to match visible content): the airport FAQ when there are lots,
  // the no-lots guide's FAQ when that guide shows, else none. Article the
  // same way: the hand-written guide on screen, if any.
  const showsGuide = data.totalLots > 0 && customContent !== null;
  const schemas = buildAirportSchemas(
    airport,
    data,
    data.totalLots > 0 ? faqs : noLotsGuide?.faqs ?? [],
    showsGuide ? customContent : noLotsGuide
  );

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
          <SEOContent
            sections={seoSections}
            updatedOn={customContent?.updatedOn}
          />
          <ComparisonCallout airport={airport} />
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

      {noLotsGuide && (
        <>
          <SEOContent sections={noLotsGuide.sections} updatedOn={noLotsGuide.updatedOn} />
          <AirportFAQ faqs={noLotsGuide.faqs} airportCode={airport.code} />
        </>
      )}

      <AirportGuides airport={airport} />
      <OtherAirports currentAirport={airport} />
      <Newsletter />
      <Footer />
    </>
  );
}
