/**
 * Structured data + canonical for a lot page (`/[airport]/airport-parking/[lot]`).
 *
 * Pure, so the JSON-LD has a unit test (PR #120 review): the price in the
 * markup must be the price the page shows — since PRs #113/#115 that is the
 * fee-inclusive total per day from `priceViewFromPricing`, not the pre-fee
 * `pricing.minPrice`; the placeholder photo must never go out as `image`;
 * and a lot reached through another airport's URL canonicalises to the airport
 * that owns it.
 */
import { productionAirports, type Airport } from "@/config/airports";
import { priceViewFromPricing } from "@/lib/pricing/price-view";
import { lotBelongsToAirport } from "@/lib/search/airport-ownership";
import type { UnifiedLot } from "@/types/lot";

/** Same host as the sitemap and `NEXT_PUBLIC_APP_URL` in production. */
export const SITE_ORIGIN = "https://www.triplypro.com";

export function lotCanonicalPath(airportSlug: string, lotSlug: string): string {
  return `/${airportSlug}/airport-parking/${lotSlug}`;
}

/**
 * The airport whose slug belongs in this lot's canonical URL. `findLotBySlug`
 * does not limit matches to the airport in the URL, so a JFK lot renders under
 * an LGA URL too (LGA listed JFK lots until the own-airport filter, Oct 8, and
 * those URLs are indexed). A self-canonical on each copy would keep them
 * apart; pointing both at the owning airport merges them. Direct lots are
 * already limited to their airport by `getLotById`.
 */
export function canonicalAirportFor(lot: UnifiedLot, airport: Airport): Airport {
  if (lot.source !== "reslab" || lotBelongsToAirport(lot, airport)) return airport;
  return productionAirports.find((a) => lotBelongsToAirport(lot, a)) ?? airport;
}

/** An image Google can fetch: an absolute URL, never the "/placeholder-parking.jpg" filler. */
function schemaImage(lot: UnifiedLot): string | undefined {
  const photo = lot.photos?.[0];
  if (!photo || photo.id === "placeholder" || !/^https?:\/\//.test(photo.url)) return undefined;
  return photo.url;
}

export function buildLotSchema(lot: UnifiedLot, airportSlug: string, urlLotSlug: string): Record<string, unknown> {
  const url = `${SITE_ORIGIN}${lotCanonicalPath(airportSlug, lot.slug || urlLotSlug)}`;
  const image = schemaImage(lot);
  // The figure the page leads with: total incl. taxes + service fee, per day.
  const view = priceViewFromPricing(lot.pricing, lot.dueAtLocationAmount);
  const perDay = view?.perDay ?? null;
  return {
    "@context": "https://schema.org",
    // LocalBusiness alongside ParkingFacility (a CivicStructure) so Google treats
    // the page as review-eligible once real ratings exist.
    "@type": ["ParkingFacility", "LocalBusiness"],
    name: lot.name,
    url,
    ...(image && { image }),
    ...(lot.address && {
      address: {
        "@type": "PostalAddress",
        streetAddress: lot.address,
        ...(lot.city && { addressLocality: lot.city }),
        ...(lot.state && { addressRegion: lot.state }),
        ...(lot.zipCode && { postalCode: lot.zipCode }),
      },
    }),
    ...(lot.latitude &&
      lot.longitude && {
        geo: { "@type": "GeoCoordinates", latitude: lot.latitude, longitude: lot.longitude },
      }),
    // No `offers`: schema.org has no `offers` on LocalBusiness/ParkingFacility
    // (the Rich Results Test ignores it) — and only a fee-inclusive figure may
    // be published as a price. Nothing when the total can't be built.
    ...(perDay !== null && perDay > 0 && {
      priceRange: `From $${perDay.toFixed(2)}/day, taxes & fees included`,
    }),
    ...(lot.phone && { telephone: lot.phone }),
    // Only real Triply guest reviews. rating/reviewCount stay unset until
    // booking_reviews has enough for a lot (#119) — never a placeholder.
    ...(lot.rating &&
      lot.reviewCount &&
      lot.reviewCount > 0 && {
        aggregateRating: {
          "@type": "AggregateRating",
          ratingValue: lot.rating.toFixed(1),
          reviewCount: lot.reviewCount,
          bestRating: "5",
          worstRating: "1",
        },
      }),
  };
}
