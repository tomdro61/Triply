import { Metadata } from "next";
import { notFound } from "next/navigation";
import { getAirportBySlug, productionAirports } from "@/config/airports";
import { fetchAirportPageData } from "@/lib/airport-page/data";
import { generateSEOContent, generateFAQs } from "@/lib/airport-page/content";
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

interface PageProps {
  params: Promise<{ slug: string }>;
}

export async function generateStaticParams() {
  return productionAirports.map((airport) => ({
    slug: airport.slug,
  }));
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
  const lotCount = data.totalLots > 0 ? `${data.totalLots}+` : "";

  return {
    title: `${airport.city} Airport Parking - Cheap ${airport.code} Parking Rates${priceText}`,
    description: customContent?.metaDescription
      ?? `Compare ${lotCount} parking lots near ${airport.name}. Reserve ${airport.code} parking${priceText}/day with free cancellation. Book now & save.`,
    alternates: {
      canonical: `https://www.triplypro.com/${airport.slug}/airport-parking`,
    },
    openGraph: {
      title: `${airport.code} Airport Parking${priceText}/day`,
      description: `Compare ${lotCount} parking lots near ${airport.name}. Book online and save up to 60%.`,
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
  const schemas = buildAirportSchemas(airport, data, faqs);

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
            Parking Options Coming Soon
          </h2>
          <p className="text-gray-500 max-w-lg mx-auto">
            We&apos;re expanding our parking inventory near {airport.name}.
            Use the search above to check for the latest availability.
          </p>
        </section>
      )}

      <OtherAirports currentAirport={airport} />
      <Newsletter />
      <Footer />
    </>
  );
}
