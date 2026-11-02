import { Airport } from "@/config/airports";
import { UnifiedLot } from "@/types/lot";
import { AirportPageData } from "./data";
import { FAQItem } from "./content";

const BASE_URL = "https://www.triplypro.com";

export interface AirportRating {
  /** Count-weighted mean of the lots' verified averages, 1 decimal. */
  average: number;
  /** Verified stays behind that average. */
  count: number;
}

/**
 * The airport's rating across its lots, from verified Triply reviews only
 * (booking_reviews via lot.reviews; never a source's own rating). A lot counts
 * only once it shows a rating itself (MIN_REVIEWS_FOR_RATING), so the airport
 * figure is built from exactly the ratings on the cards. null when no lot has
 * one — which is always the case while LOT_REVIEWS_DISPLAY_ENABLED is off.
 * Shared by the hero line and the JSON-LD: Google requires the markup's rating
 * to be visible on the page.
 */
export function airportRating(lots: UnifiedLot[]): AirportRating | null {
  let count = 0;
  let weighted = 0;
  for (const lot of lots) {
    const r = lot.reviews;
    if (!r || r.average === null || r.count <= 0) continue;
    count += r.count;
    weighted += r.average * r.count;
  }
  if (count === 0) return null;
  return { average: Math.round((weighted / count) * 10) / 10, count };
}

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
 * Build Product + AggregateOffer (+ AggregateRating when real) JSON-LD schema
 */
function buildProductSchema(
  airport: Airport,
  data: AirportPageData
): Record<string, unknown> | null {
  if (!data.priceRange) return null;

  const rating = airportRating(data.lots);

  return {
    "@context": "https://schema.org",
    "@type": "Product",
    name: `${airport.code} Airport Parking`,
    description: `Off-airport parking near ${airport.name}`,
    url: `${BASE_URL}/${airport.slug}/airport-parking`,
    brand: { "@type": "Brand", name: "Triply" },
    ...(rating && {
      aggregateRating: {
        "@type": "AggregateRating",
        ratingValue: rating.average.toFixed(1),
        // ratingCount, as on lot pages (src/lib/seo/lot-schema.ts): the count includes star-only ratings.
        ratingCount: rating.count,
        bestRating: 5,
        worstRating: 1,
      },
    }),
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
