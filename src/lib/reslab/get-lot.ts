import {
  reslab,
  ReslabLocation,
  ReslabMinPriceResponse,
  stripHtml,
  getFeaturedPhoto,
} from "./client";
import { UnifiedLot } from "@/types/lot";

/**
 * Generate a URL-friendly slug from location name
 */
function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Transform ResLab location to UnifiedLot format with full pricing
 */
function transformLocationToLot(
  location: ReslabLocation,
  minPriceData: ReslabMinPriceResponse | null
): UnifiedLot {
  const lat = parseFloat(location.latitude);
  const lng = parseFloat(location.longitude);

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

  // Get parking type info from minPriceData if available
  const parkingTypeId = minPriceData?.parking_type?.id || 0;
  const parkingTypeName = minPriceData?.parking_type?.name || "Standard Parking";
  const numberOfDays = minPriceData?.reservation?.totals?.parking?.number_of_days || 1;
  const subtotal = minPriceData?.reservation?.sub_total || 0;
  const dailyRate = numberOfDays > 0 ? subtotal / numberOfDays : 0;

  // Create parking types array from the response
  const pricingParkingTypes = parkingTypeId ? [{
    id: parkingTypeId,
    name: parkingTypeName,
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

    distanceFromAirport: undefined,

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
  toDate: string
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

    return transformLocationToLot(location, minPriceData);
  } catch (error) {
    console.error("Error fetching lot from ResLab:", error);
    return null;
  }
}

/**
 * Find a lot by slug from ResLab
 * This searches all locations and matches by generated slug
 */
export async function findLotBySlug(
  slug: string,
  fromDate: string,
  toDate: string
): Promise<UnifiedLot | null> {
  try {
    // Get all locations in the channel
    const locationsData = await reslab.getAllLocations();
    const locations = locationsData.data;

    // Find by slug
    const matchingLocation = locations.find(
      (loc) => generateSlug(loc.name) === slug
    );

    if (!matchingLocation) {
      return null;
    }

    return getLotFromReslab(matchingLocation.id, fromDate, toDate);
  } catch (error) {
    console.error("Error finding lot by slug:", error);
    return null;
  }
}

/**
 * Get lot by ID (handles both reslab-{id} format and direct ID)
 */
export async function getLotById(
  id: string,
  fromDate: string,
  toDate: string
): Promise<UnifiedLot | null> {
  // Check if it's a reslab ID
  if (id.startsWith("reslab-")) {
    const locationId = parseInt(id.replace("reslab-", ""), 10);
    if (!isNaN(locationId)) {
      return getLotFromReslab(locationId, fromDate, toDate);
    }
  }

  // Try as a direct location ID
  const locationId = parseInt(id, 10);
  if (!isNaN(locationId)) {
    return getLotFromReslab(locationId, fromDate, toDate);
  }

  // Try as a slug
  return findLotBySlug(id, fromDate, toDate);
}
