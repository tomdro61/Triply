import { Airport } from "@/config/airports";
import { AirportPageData } from "./data";
import { FAQItem } from "./content";

const BASE_URL = "https://www.triplypro.com";

/**
 * Build Airport JSON-LD schema
 */
function buildAirportSchema(airport: Airport): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "Airport",
    name: airport.name,
    iataCode: airport.code,
    address: {
      "@type": "PostalAddress",
      addressLocality: airport.city,
      addressRegion: airport.state,
      addressCountry: airport.country || "US",
    },
    geo: {
      "@type": "GeoCoordinates",
      latitude: airport.latitude,
      longitude: airport.longitude,
    },
  };
}

/**
 * Build Product + AggregateOffer JSON-LD schema
 */
function buildProductSchema(
  airport: Airport,
  data: AirportPageData
): Record<string, unknown> | null {
  if (!data.priceRange) return null;

  return {
    "@context": "https://schema.org",
    "@type": "Product",
    name: `${airport.code} Airport Parking`,
    description: `Off-airport parking near ${airport.name}`,
    url: `${BASE_URL}/${airport.slug}/airport-parking`,
    // No aggregateRating here: this page lists several lots, and Google wants a rating to be
    // about one item, not a list. Each lot's own verified rating is on its lot page (seo/lot-schema.ts).
    brand: { "@type": "Brand", name: "Triply" },
    offers: {
      "@type": "AggregateOffer",
      lowPrice: data.priceRange.min.toFixed(2),
      highPrice: data.priceRange.max.toFixed(2),
      priceCurrency: "USD",
      offerCount: data.totalLots,
      availability: "https://schema.org/InStock",
    },
  };
}

/** The hand-written guide's own dates (AirportContent.publishedOn/updatedOn). */
export interface GuideDates {
  publishedOn: string;
  updatedOn: string;
}

/**
 * Build Article JSON-LD for the hand-written guide on the page.
 * Dates come from the content file, never the render: the page re-renders
 * hourly for live prices, and a dateModified that moves with every ISR pass
 * is a freshness claim the words don't back.
 */
function buildArticleSchema(
  airport: Airport,
  dates: GuideDates
): Record<string, unknown> {
  const url = `${BASE_URL}/${airport.slug}/airport-parking`;
  return {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: `${airport.city} Airport Parking Guide (${airport.code})`,
    datePublished: dates.publishedOn,
    dateModified: dates.updatedOn,
    author: { "@type": "Organization", name: "Triply Editorial Team", url: BASE_URL },
    publisher: { "@type": "Organization", name: "Triply", url: BASE_URL },
    mainEntityOfPage: { "@type": "WebPage", "@id": url },
    about: { "@type": "Airport", name: airport.name, iataCode: airport.code },
  };
}

/**
 * Build FAQPage JSON-LD schema
 */
function buildFAQSchema(faqs: FAQItem[]): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqs.map((faq) => ({
      "@type": "Question",
      name: faq.question,
      acceptedAnswer: {
        "@type": "Answer",
        text: faq.answer,
      },
    })),
  };
}

/**
 * Build all JSON-LD schemas for an airport landing page.
 * Returns array of schema objects to render via <JsonLd />.
 * `guide` is set only when the page shows hand-written copy; template pages
 * have no authored date to give, so they get no Article.
 */
export function buildAirportSchemas(
  airport: Airport,
  data: AirportPageData,
  faqs: FAQItem[],
  guide?: GuideDates | null
): Record<string, unknown>[] {
  const schemas: Record<string, unknown>[] = [buildAirportSchema(airport)];

  if (guide) schemas.push(buildArticleSchema(airport, guide));

  const productSchema = buildProductSchema(airport, data);
  if (productSchema) schemas.push(productSchema);

  if (faqs.length > 0) schemas.push(buildFAQSchema(faqs));

  return schemas;
}
