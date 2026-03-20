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
 */
export function buildAirportSchemas(
  airport: Airport,
  data: AirportPageData,
  faqs: FAQItem[]
): Record<string, unknown>[] {
  const schemas: Record<string, unknown>[] = [buildAirportSchema(airport)];

  const productSchema = buildProductSchema(airport, data);
  if (productSchema) schemas.push(productSchema);

  if (faqs.length > 0) schemas.push(buildFAQSchema(faqs));

  return schemas;
}
