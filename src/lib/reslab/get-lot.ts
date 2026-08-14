import {
  reslab,
  ReslabError,
  ReslabLocation,
  ReslabMinPriceResponse,
  stripHtml,
  getFeaturedPhoto,
} from "./client";
import { UnifiedLot } from "@/types/lot";
import { calculateDistance } from "@/lib/utils/geo";
import { generateSlug } from "@/lib/utils/slug";
// One-way dependency: search.ts does NOT import get-lot.ts, so no cycle.
import { getChannelLocationsCached } from "./search";

/**
 * Airport coordinates for distance calculation
 */
interface AirportCoords {
  latitude: number;
  longitude: number;
}

/**
 * Transform ResLab location to UnifiedLot format with full pricing
 */
function transformLocationToLot(
  location: ReslabLocation,
  minPriceData: ReslabMinPriceResponse | null,
  airportCoords?: AirportCoords
): UnifiedLot {
  const lat = parseFloat(location.latitude);
  const lng = parseFloat(location.longitude);

  // Calculate distance from airport if coordinates provided
  const distanceFromAirport = airportCoords
    ? calculateDistance(airportCoords.latitude, airportCoords.longitude, lat, lng)
    : undefined;

  // Get featured photo or first photo
  const featuredPhotoUrl = getFeaturedPhoto(location);

  // Transform photos
  const photos = location.photos.map((p) => ({
    id: String(p.id),
    url: p.filename,
    alt: location.name,
  }));

  // Transform amenities
  const amenities = location.amenities.map((a) => ({
    id: a.id,
    name: a.name,
    displayName: a.display_name,
    icon: a.icon,
  }));

  // Get currency code
  const currencyCode = location.currency?.code || "USD";

  // Get parking type info from minPriceData rates
  // The rates array contains location_parking_type_id
  const parkingTypeId = minPriceData?.rates?.[0]?.location_parking_type_id || 0;
  const numberOfDays = minPriceData?.reservation?.totals?.parking?.number_of_days || 1;
  // Daily rate includes ResLab fees but excludes taxes.
  // Fees are hidden as a separate line — rolled into the per-day rate
  // so pricing is consistent across search, lot detail, and checkout.
  const subtotal = minPriceData?.reservation?.sub_total || 0;
  const feesTotal = minPriceData?.reservation?.fees_total || 0;
  const dailyRate = numberOfDays > 0 ? (subtotal + feesTotal) / numberOfDays : 0;

  // Create parking types array from the response
  const pricingParkingTypes = parkingTypeId ? [{
    id: parkingTypeId,
    name: "Standard Parking", // min-price doesn't return the name
    price: dailyRate,
    spotsAvailable: location.number_of_parkings,
  }] : [];

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

    distanceFromAirport,

    pricing: minPriceData
      ? {
          minPrice: dailyRate,
          currency: currencyCode === "USD" ? "$" : currencyCode,
          currencyCode,
          parkingTypes: pricingParkingTypes,
          grandTotal: minPriceData.reservation.grand_total,
          subtotal: minPriceData.reservation.sub_total,
          feesTotal: minPriceData.reservation.fees_total,
          taxTotal: minPriceData.reservation.tax_total,
          taxValue: location.tax_value,
          taxType: location.tax_type,
          numberOfDays: minPriceData.reservation.totals?.parking?.number_of_days,
        }
      : undefined,

    availability: minPriceData?.reservation.sold_out ? "unavailable" : "available",

    minimumBookingDays: location.minimum_booking_days || undefined,
    hoursBeforeReservation: location.hours_before_reservation || undefined,
    dailyOrHourly: location.daily_or_hourly,

    dueAtLocation: Boolean(location.parking_due_at_location),
    dueAtLocationAmount: minPriceData?.reservation.due_at_location,

    extraFields: location.extra_fields.map((f) => ({
      id: f.id,
      name: f.name,
      label: f.label,
      type: f.type,
      inputType: f.input_type,
      perCar: Boolean(f.per_car),
    })),

    cancellationPolicies: location.cancellation_policies
      .filter((p) => p.type === "parking")
      .map((p) => ({
        numberOfDays: p.number_of_days,
        percentage: p.percentage,
      })),
  };
}

/**
 * Fetch lot details from ResLab API
 * Uses getMinPrice instead of getLocationTypes (which has API issues)
 */
export async function getLotFromReslab(
  locationId: number,
  fromDate: string,
  toDate: string,
  airportCoords?: AirportCoords
): Promise<UnifiedLot | null> {
  try {
    // Get location details
    const location = await reslab.getLocation(locationId);

    // Get minimum price (which also returns parking type info)
    let minPriceData: ReslabMinPriceResponse | null = null;
    try {
      minPriceData = await reslab.getMinPrice(locationId, {
        type: "parking",
        reservation_type: "parking",
        from_date: fromDate,
        to_date: toDate,
        number_of_spots: 1,
      });
    } catch (error) {
      console.error("Error getting min price:", error);
      // Continue without pricing - we can still show the lot
    }

    return transformLocationToLot(location, minPriceData, airportCoords);
  } catch (error) {
    // `null` from this function means "this lot does not exist" — the page turns
    // it into notFound() and /api/checkout/lot into a 404. ONLY a genuine 404
    // from ResLab earns that. Flattening a 429/502/timeout into null produces a
    // false 404 on a confirmed-real lot (we got here because the id or slug
    // MATCHED), with nothing in Sentry — and 429/5xx is exactly what we see
    // during the rate-limit windows this work exists to harden against.
    if (error instanceof ReslabError && error.statusCode === 404) {
      return null;
    }
    throw error;
  }
}

/**
 * Find a lot by slug.
 *
 * ⚠️ This used to walk `/locations?page=N` itself — uncached, no TTL, no
 * circuit breaker, sequentially to `last_page` (54 pages) — ON THE REQUEST
 * PATH. ResLab limits that endpoint to 500 requests/day, so a single lookup
 * for a slug that matched nothing cost ~11% of the daily budget, and the lot
 * detail page calls this TWICE per render (page body + generateMetadata).
 *
 * Both entry points take unauthenticated attacker-controlled input:
 *   GET /api/checkout/lot?lotId=<junk>     (no auth, Zod accepts any string)
 *   GET /[slug]/airport-parking/<junk>     (fully dynamic, no revalidate)
 *
 * So roughly ten requests to a nonexistent slug exhausted the entire day's
 * budget and reproduced the 2026-08-10 site-wide search outage — reachable by
 * any third party, or by a bot crawling stale lot URLs. Found by /harden-plan
 * on 2026-08-14; five reviewers flagged it independently.
 *
 * Now reads the SHARED channel list via getChannelLocationsCached(), which
 * carries the 24h TTL, single-flight coalescing, circuit breaker, and
 * plausibility validation added in PR #15. A slug lookup costs ZERO extra
 * ResLab calls on a warm cache.
 *
 * Do NOT reintroduce a page walk here. If this needs to work when the shared
 * cache is unavailable, the answer is to fix the cache, not to sweep per
 * request.
 */
export async function findLotBySlug(
  slug: string,
  fromDate: string,
  toDate: string,
  airportCoords?: AirportCoords
): Promise<UnifiedLot | null> {
  // Deliberately NOT wrapped in try/catch. A ResLab failure (or an open
  // circuit breaker) must NOT be flattened into `null`, because null means
  // "this lot does not exist" — which the page turns into a 404 and Google
  // indexes as a dead URL. Distinguishing a real 404 from an upstream outage
  // is the project's hard rule; the previous `catch { return null }` was the
  // exact anti-pattern that produced the 2026-06-29 cached-empty incident.
  // Callers propagate; the page renders an error state rather than a false 404.
  const { data: locations, incomplete } = await getChannelLocationsCached();

  const match = locations.find((loc) => generateSlug(loc.name) === slug);
  if (!match) {
    if (incomplete) {
      // The list is KNOWN thin — the cache deliberately retains a partial sweep
      // (any failed page → complete:false) and serves it so search degrades
      // instead of 503ing, held for the 10-minute backoff per rebuild and up to
      // the 72h max-age under sustained degradation. Rows only have to clear a
      // 0.9 plausibility floor, so ~10% of the channel can be legitimately
      // absent and still served.
      //
      // "Absent from THIS list" is therefore not evidence the lot doesn't
      // exist. Returning null here 404s a live lot whose URL our own sitemap
      // publishes (sitemap.ts builds these slugs) — and Google treats 404 as
      // permanent and deindexes, while it treats 5xx as transient and retries.
      // Surface the degradation instead.
      throw new ReslabError(
        503,
        `Lot slug "${slug}" not found, but the ResLab location list is ` +
          `incomplete (${locations.length} lots) — cannot distinguish a missing ` +
          `lot from a thin list`,
      );
    }
    // Genuine not-found: the list is COMPLETE and no lot has this slug.
    // NB `stale` is deliberately NOT treated this way — a stale list is
    // complete, so a miss on it is a real miss. Throwing on stale would 500 the
    // site for the entire 24-72h window.
    return null;
  }

  return getLotFromReslab(match.id, fromDate, toDate, airportCoords);
}

/**
 * Get lot by ID (handles both reslab-{id} format and direct ID)
 */
export async function getLotById(
  id: string,
  fromDate: string,
  toDate: string,
  airportCoords?: AirportCoords
): Promise<UnifiedLot | null> {
  // Check if it's a reslab ID
  if (id.startsWith("reslab-")) {
    const locationId = parseInt(id.replace("reslab-", ""), 10);
    if (!isNaN(locationId)) {
      return getLotFromReslab(locationId, fromDate, toDate, airportCoords);
    }
  }

  // Try as a direct location ID
  const locationId = parseInt(id, 10);
  if (!isNaN(locationId)) {
    return getLotFromReslab(locationId, fromDate, toDate, airportCoords);
  }

  // Try as a slug
  return findLotBySlug(id, fromDate, toDate, airportCoords);
}
