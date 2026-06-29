/**
 * Shared parking search logic
 *
 * Extracted from the search API route so it can be reused
 * by both /api/search and /api/chat (AI tool calling).
 */

import { getAirportByCode, Airport } from "@/config/airports";
import {
  reslab,
  ReslabError,
  ReslabLocation,
  ReslabMinPriceResponse,
  stripHtml,
  getFeaturedPhoto,
} from "@/lib/reslab/client";
import { UnifiedLot, SortOption } from "@/types/lot";
import { calculateDistance } from "@/lib/utils/geo";
import { convertTo24Hour } from "@/lib/utils/time";
import { generateSlug } from "@/lib/utils/slug";
import { captureAPIError } from "@/lib/sentry";

export { generateSlug };

/**
 * Transform ResLab location to UnifiedLot format
 */
export function transformLocation(
  location: ReslabLocation,
  minPriceData: ReslabMinPriceResponse | null,
  airportLat: number,
  airportLng: number
): UnifiedLot {
  const lat = parseFloat(location.latitude);
  const lng = parseFloat(location.longitude);

  const distance = calculateDistance(airportLat, airportLng, lat, lng);

  // Get featured photo or first photo
  const featuredPhotoUrl = getFeaturedPhoto(location);

  // Transform photos
  const photos = (location.photos || []).map((p) => ({
    id: String(p.id),
    url: p.filename,
    alt: location.name,
  }));

  // Transform amenities
  const amenities = (location.amenities || []).map((a) => ({
    id: a.id,
    name: a.name,
    displayName: a.display_name,
    icon: a.icon,
  }));

  // Determine availability
  let availability: "available" | "limited" | "unavailable" = "available";
  if (minPriceData?.reservation.sold_out) {
    availability = "unavailable";
  } else if (
    minPriceData?.reservation.available_spots !== undefined &&
    minPriceData.reservation.available_spots < 10
  ) {
    availability = "limited";
  }

  // Get currency code
  const currencyCode = location.currency?.code || "USD";

  return {
    id: `reslab-${location.id}`,
    source: "reslab",
    sourceId: String(location.id),
    reslabLocationId: location.id,

    name: location.name,
    slug: generateSlug(location.name),
    address: location.address,
    city: location.city,
    state: location.state?.code || "",
    zipCode: location.zip_code,
    country: location.country?.name,
    latitude: lat,
    longitude: lng,

    description: stripHtml(location.description),
    directions: stripHtml(location.directions),
    specialConditions: stripHtml(location.special_conditions),
    phone: location.phone,

    shuttleInfo: location.shuttle_info_summary
      ? {
          summary: stripHtml(location.shuttle_info_summary),
          details: stripHtml(location.shuttle_info_details),
        }
      : undefined,

    amenities,
    photos:
      photos.length > 0
        ? photos
        : [
            {
              id: "placeholder",
              url: "/placeholder-parking.jpg",
              alt: location.name,
            },
          ],

    rating: undefined,
    reviewCount: undefined,

    distanceFromAirport: distance,

    pricing: minPriceData
      ? {
          // Daily rate includes ResLab fees but excludes taxes.
          // Fees are hidden as a separate line — rolled into the per-day rate
          // so pricing is consistent across search, lot detail, and checkout.
          minPrice:
            (minPriceData.reservation.sub_total + minPriceData.reservation.fees_total) /
            (minPriceData.reservation.totals?.parking?.number_of_days || 1),
          currency: currencyCode === "USD" ? "$" : currencyCode,
          currencyCode,
          parkingTypes: [],
          grandTotal: minPriceData.reservation.grand_total,
          subtotal: minPriceData.reservation.sub_total,
          feesTotal: minPriceData.reservation.fees_total,
          taxTotal: minPriceData.reservation.tax_total,
          taxValue: location.tax_value,
          taxType: location.tax_type,
          numberOfDays: minPriceData.reservation.totals?.parking?.number_of_days,
        }
      : undefined,

    availability,

    minimumBookingDays: location.minimum_booking_days || undefined,
    hoursBeforeReservation: location.hours_before_reservation || undefined,
    dailyOrHourly: location.daily_or_hourly,

    dueAtLocation: Boolean(location.parking_due_at_location),
    dueAtLocationAmount: minPriceData?.reservation.due_at_location,

    extraFields: (location.extra_fields || []).map((f) => ({
      id: f.id,
      name: f.name,
      label: f.label,
      type: f.type,
      inputType: f.input_type,
      perCar: Boolean(f.per_car),
    })),

    cancellationPolicies: (location.cancellation_policies || [])
      .filter((p) => p.type === "parking")
      .map((p) => ({
        numberOfDays: p.number_of_days,
        percentage: p.percentage,
      })),
  };
}

/**
 * Sort lots by the specified option
 */
export function sortLots(lots: UnifiedLot[], sortBy: SortOption): UnifiedLot[] {
  const sorted = [...lots];

  switch (sortBy) {
    case "price_asc":
      sorted.sort(
        (a, b) => (a.pricing?.minPrice ?? 999) - (b.pricing?.minPrice ?? 999)
      );
      break;
    case "price_desc":
      sorted.sort(
        (a, b) => (b.pricing?.minPrice ?? 0) - (a.pricing?.minPrice ?? 0)
      );
      break;
    case "rating":
      sorted.sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
      break;
    case "distance":
      sorted.sort(
        (a, b) =>
          (a.distanceFromAirport ?? 999) - (b.distanceFromAirport ?? 999)
      );
      break;
    case "popularity":
    default:
      sorted.sort(
        (a, b) =>
          (a.distanceFromAirport ?? 999) - (b.distanceFromAirport ?? 999)
      );
      break;
  }

  return sorted;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main search function (used by both /api/search and /api/chat tool)
// ─────────────────────────────────────────────────────────────────────────────

export interface SearchParkingParams {
  airport: string;
  checkin: string; // YYYY-MM-DD
  checkout: string; // YYYY-MM-DD
  checkinTime?: string; // "10:00 AM" format
  checkoutTime?: string; // "2:00 PM" format
  sort?: SortOption;
}

export interface SearchParkingResult {
  airport: Airport;
  checkin: string;
  checkout: string;
  checkinTime: string;
  checkoutTime: string;
  results: UnifiedLot[];
  total: number;
  message?: string;
  // True when some/all ResLab pricing calls failed, so the list is incomplete.
  // The route refuses to CDN-cache a degraded result.
  degraded?: boolean;
}

// ───────────────────────────────────────────────────────────────────────────
// ResLab geo-search workaround (2026-06-29)
//
// ResLab's lat/lng location search (`/locations/search?lat&lng`) is down — it
// hangs and 504s — while every other endpoint (list, single, by-ID, pricing)
// works. Until they fix it, find lots near an airport by fetching the full
// channel location list (which works) and filtering by distance ourselves. The
// list objects are complete (photos/amenities/etc.), so search cards render
// identically.
//
// To revert once ResLab's geo-search recovers: flip this to false. The original
// lat/lng path is preserved untouched in searchParking's `else` branch below.
// ───────────────────────────────────────────────────────────────────────────
const RESLAB_GEO_SEARCH_BROKEN = true;

// Cache the full channel location list so the workaround doesn't re-page on
// every search (the channel has ~533 locations across ~54 pages). Module-level
// TTL cache — same pattern as the auth-token cache in the ResLab client.
const LOCATION_LIST_TTL_MS = 60 * 60 * 1000;
let cachedLocationList: { data: ReslabLocation[]; expiry: number } | null = null;

async function getChannelLocationsCached(): Promise<ReslabLocation[]> {
  if (cachedLocationList && Date.now() < cachedLocationList.expiry) {
    return cachedLocationList.data;
  }
  // Page 1 must succeed (gives last_page + the first slice). If it throws, let
  // it propagate — the route turns it into an uncacheable 503 + retry.
  const first = await reslab.getAllLocations(1);
  const all: ReslabLocation[] = [...first.data];
  const remaining: number[] = [];
  for (let p = 2; p <= first.last_page; p++) remaining.push(p);

  // Fetch remaining pages in small concurrent batches to keep load civil.
  // Tolerate an individual page failing rather than zeroing out all search.
  let failedPages = 0;
  const BATCH = 8;
  for (let i = 0; i < remaining.length; i += BATCH) {
    const results = await Promise.allSettled(
      remaining.slice(i, i + BATCH).map((p) => reslab.getAllLocations(p))
    );
    for (const r of results) {
      if (r.status === "fulfilled") all.push(...r.value.data);
      else failedPages++;
    }
  }

  // ResLab's paginated list returns the same location id on multiple pages —
  // dedupe by id so search doesn't render duplicate lot cards.
  const unique = Array.from(new Map(all.map((l) => [l.id, l])).values());

  if (failedPages > 0) {
    // Incomplete build (could be missing lots near an airport). Serve what we
    // have so search isn't fully down, but surface it and DON'T cache a partial
    // list — the next request rebuilds.
    captureAPIError(
      new Error(
        `ResLab location-list build incomplete: ${failedPages}/${first.last_page} pages failed`
      ),
      { endpoint: "/api/search", method: "GET", statusCode: 502 }
    );
    return unique;
  }

  cachedLocationList = {
    data: unique,
    expiry: Date.now() + LOCATION_LIST_TTL_MS,
  };
  return unique;
}

// Replacement for ResLab's broken lat/lng geo-search: locations within
// `radiusKm` of the airport. 15km matches ResLab's documented search radius.
async function findLocationsNearAirport(
  lat: number,
  lng: number,
  radiusKm = 15
): Promise<ReslabLocation[]> {
  const all = await getChannelLocationsCached();
  return all.filter((loc) => {
    const llat = parseFloat(loc.latitude);
    const llng = parseFloat(loc.longitude);
    if (Number.isNaN(llat) || Number.isNaN(llng)) return false;
    return calculateDistance(lat, lng, llat, llng) <= radiusKm;
  });
}

export async function searchParking(
  params: SearchParkingParams
): Promise<SearchParkingResult> {
  const {
    airport: airportCode,
    checkin,
    checkout,
    // Search results show "from $X" estimates only — the customer must pick
    // their actual times on the lot detail page before booking.
    checkinTime = "10:00 AM",
    checkoutTime = "2:00 PM",
    sort = "popularity",
  } = params;

  // Validate airport
  const airportInfo = getAirportByCode(airportCode);
  if (!airportInfo) {
    throw new Error(`Invalid airport code: ${airportCode}`);
  }

  // Convert times to 24-hour format
  const checkinTime24 = convertTo24Hour(checkinTime);
  const checkoutTime24 = convertTo24Hour(checkoutTime);

  // Format dates for ResLab API (YYYY-MM-DD HH:mm:ss)
  const fromDate = `${checkin} ${checkinTime24}:00`;
  const toDate = `${checkout} ${checkoutTime24}:00`;

  // Search for locations near the airport.
  //
  // safety-removed: the previous `catch { locations = [] }` swallowed ResLab
  // outages into a "0 lots" success. /api/search caches 200s at the CDN, so a
  // transient ResLab 502 got cached as "No parking found" and stuck for the
  // full TTL — the live incident on 2026-06-29. Let ResLab errors propagate so
  // the route returns an uncacheable 5xx instead of poisoning the cache.
  let locations: ReslabLocation[];
  if (airportInfo.reslabLocationId) {
    // Single mapped location — search-by-ID works even during the geo outage.
    locations =
      (await reslab.searchLocations({
        locations: [airportInfo.reslabLocationId],
      })) || [];
  } else if (RESLAB_GEO_SEARCH_BROKEN) {
    // Workaround for ResLab's broken lat/lng geo-search (see flag above).
    locations = await findLocationsNearAirport(
      airportInfo.latitude,
      airportInfo.longitude
    );
  } else {
    // Original path — restore by flipping RESLAB_GEO_SEARCH_BROKEN to false.
    locations =
      (await reslab.searchLocations({
        lat: String(airportInfo.latitude),
        lng: String(airportInfo.longitude),
      })) || [];
  }

  // Genuine "no lots near this airport" — distinct from a ResLab failure, which
  // now throws above. Returned as a 200, but the route serves every empty
  // result no-store (we never cache an empty search).
  if (locations.length === 0) {
    return {
      airport: airportInfo,
      checkin,
      checkout,
      checkinTime,
      checkoutTime,
      results: [],
      total: 0,
      message: "No parking locations found near this airport",
    };
  }

  // Get minimum price for each location. A per-location pricing failure is
  // non-fatal — we still show the others — but count them so we can tell a
  // genuine "everything is sold out" empty from a ResLab degradation (below).
  let pricingErrors = 0;
  const lotsWithPricing = await Promise.all(
    locations.map(async (location) => {
      let minPriceData: ReslabMinPriceResponse | null = null;

      try {
        minPriceData = await reslab.getMinPrice(location.id, {
          type: "parking",
          reservation_type: "parking",
          from_date: fromDate,
          to_date: toDate,
          number_of_spots: 1,
        });
      } catch {
        // Price unavailable for this location (transient ResLab error or
        // genuinely no price). Counted so an all-error result doesn't get
        // served as a cacheable empty success.
        pricingErrors++;
      }

      return transformLocation(
        location,
        minPriceData,
        airportInfo.latitude,
        airportInfo.longitude
      );
    })
  );

  // Filter out unavailable lots and lots with no valid pricing
  const availableLots = lotsWithPricing.filter(
    (lot) =>
      lot.availability !== "unavailable" &&
      lot.pricing?.grandTotal !== undefined &&
      lot.pricing.grandTotal > 0
  );

  // Found locations but priced none of them while pricing calls were erroring:
  // ResLab is degraded, not genuinely empty. Throw so the route returns an
  // uncacheable 5xx rather than caching a misleading "no parking" result.
  if (availableLots.length === 0 && pricingErrors > 0) {
    throw new ReslabError(
      502,
      `ResLab pricing unavailable for all ${locations.length} ${airportCode} location(s)`
    );
  }

  // Partial degradation: at least one lot priced but some pricing calls failed,
  // so the list is incomplete. The per-location catch above is otherwise silent
  // — surface it to Sentry, and flag it so the route won't CDN-cache a thin
  // result that would stick for the TTL (the 2026-06-29 failure mode, at
  // partial scale).
  if (pricingErrors > 0) {
    captureAPIError(
      new Error(
        `ResLab pricing degraded: ${pricingErrors}/${locations.length} ${airportCode} location(s) failed to price`
      ),
      { endpoint: "/api/search", method: "GET", statusCode: 502 }
    );
  }

  // Sort lots
  const sortedLots = sortLots(availableLots, sort);

  return {
    airport: airportInfo,
    checkin,
    checkout,
    checkinTime,
    checkoutTime,
    results: sortedLots,
    total: sortedLots.length,
    degraded: pricingErrors > 0,
  };
}
