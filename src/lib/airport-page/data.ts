import { cache } from "react";
import { Airport } from "@/config/airports";
import { searchParking } from "@/lib/reslab/search";
import { ReslabError } from "@/lib/reslab/client";
import { UnifiedLot } from "@/types/lot";
import { captureAPIError } from "@/lib/sentry";

export interface AirportPageData {
  lots: UnifiedLot[];
  topLots: UnifiedLot[];
  cheapestLot: UnifiedLot | null;
  cheapestPrice: number | null;
  closestLot: UnifiedLot | null;
  totalLots: number;
  priceRange: { min: number; max: number } | null;
  hasShuttle: boolean;
  commonAmenities: string[];
  distanceRange: { min: number; max: number } | null;
}

/**
 * Fetch and compute all data needed for an airport landing page.
 * Uses default dates (tomorrow + 7 days) matching FeaturedParking pattern.
 */
// Wrapped in React.cache so generateMetadata and the page component share a
// single fetch per request (dedupes the ResLab call AND the Sentry capture on
// failure — they're invoked twice per request otherwise).
export const fetchAirportPageData = cache(async function fetchAirportPageData(
  airport: Airport
): Promise<AirportPageData> {
  const checkin = new Date();
  checkin.setDate(checkin.getDate() + 1);
  const checkout = new Date();
  checkout.setDate(checkout.getDate() + 8);

  const checkinStr = checkin.toISOString().split("T")[0];
  const checkoutStr = checkout.toISOString().split("T")[0];

  let lots: UnifiedLot[] = [];

  try {
    const result = await searchParking({
      airport: airport.code,
      checkin: checkinStr,
      checkout: checkoutStr,
      sort: "price_asc",
    });
    // A DEGRADED result does not throw — it returns successfully with a thin
    // (or empty) lot list because the ResLab location-list build was rejected.
    // /api/search protects itself by serving those no-store; this page has no
    // such guard, so without this check Next would commit a 2-lot (or zero-lot)
    // render into the ISR cache and serve it — to users and to Googlebot, with
    // a truncated JSON-LD ItemList and a wrong lot count in the metadata — for
    // the full hour. Treat it exactly like a throw so the last-good page stands.
    if (result.degraded) {
      throw new ReslabError(
        502,
        `Degraded ResLab result for ${airport.code} ` +
          `(${result.results.length} lots) — refusing to bake it into ISR`
      );
    }
    lots = result.results;
  } catch (err) {
    // searchParking throws on a real ResLab failure, and also when our own
    // location-list circuit breaker is open (a cold instance backing off after
    // a failed build — see getChannelLocationsCached). A genuine "no lots"
    // still returns an empty result without throwing. Both throw cases mean
    // "we don't know the inventory", so always surface it — this page is
    // ISR-cached for 1h, so a swallowed failure is otherwise invisible.
    captureAPIError(err instanceof Error ? err : new Error(String(err)), {
      endpoint: "/[slug]/airport-parking",
      method: "GET",
    });

    // At runtime (ISR revalidation), rethrow so Next.js keeps serving the
    // last-good cached page instead of overwriting it with an empty render —
    // the same cached-empty-on-blip failure mode the /api/search fix prevents.
    // During `next build` we must NOT throw: a transient ResLab blip would fail
    // the entire deploy (including unrelated changes), so fall through to the
    // empty state in that phase only.
    if (process.env.NEXT_PHASE !== "phase-production-build") {
      throw err;
    }
  }

  if (lots.length === 0) {
    return {
      lots: [],
      topLots: [],
      cheapestLot: null,
      cheapestPrice: null,
      closestLot: null,
      totalLots: 0,
      priceRange: null,
      hasShuttle: false,
      commonAmenities: [],
      distanceRange: null,
    };
  }

  const prices = lots
    .map((l) => l.pricing?.minPrice)
    .filter((p): p is number => p !== undefined && p > 0);

  const distances = lots
    .map((l) => l.distanceFromAirport)
    .filter((d): d is number => d !== undefined);

  const cheapestLot = lots.reduce<UnifiedLot | null>((best, lot) => {
    if (!lot.pricing?.minPrice) return best;
    if (!best || lot.pricing.minPrice < (best.pricing?.minPrice ?? Infinity)) {
      return lot;
    }
    return best;
  }, null);

  const closestLot = lots.reduce<UnifiedLot | null>((best, lot) => {
    if (lot.distanceFromAirport === undefined) return best;
    if (
      !best ||
      lot.distanceFromAirport < (best.distanceFromAirport ?? Infinity)
    ) {
      return lot;
    }
    return best;
  }, null);

  const hasShuttle = lots.some((l) => l.shuttleInfo?.summary);

  // Count amenity frequency across all lots
  const amenityCounts = new Map<string, number>();
  for (const lot of lots) {
    for (const amenity of lot.amenities) {
      amenityCounts.set(
        amenity.displayName,
        (amenityCounts.get(amenity.displayName) || 0) + 1
      );
    }
  }
  const commonAmenities = [...amenityCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([name]) => name);

  return {
    lots,
    topLots: lots.slice(0, 6),
    cheapestLot,
    cheapestPrice: prices.length > 0 ? Math.min(...prices) : null,
    closestLot,
    totalLots: lots.length,
    priceRange:
      prices.length > 0
        ? { min: Math.min(...prices), max: Math.max(...prices) }
        : null,
    hasShuttle,
    commonAmenities,
    distanceRange:
      distances.length > 0
        ? {
            min: Math.min(...distances),
            max: Math.max(...distances),
          }
        : null,
  };
});
