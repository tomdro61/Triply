import { NextRequest, NextResponse } from "next/server";
import { getAirportByCode } from "@/config/airports";
import {
  reslab,
  ReslabLocation,
  ReslabMinPriceResponse,
  formatReslabDate,
  stripHtml,
  getFeaturedPhoto,
} from "@/lib/reslab/client";
import { UnifiedLot, SortOption } from "@/types/lot";
import { calculateDistance } from "@/lib/utils/geo";

/**
 * Convert 12-hour time format to 24-hour format
 * "10:00 AM" -> "10:00"
 * "2:30 PM" -> "14:30"
 */
function convertTo24Hour(time12h: string): string {
  const [time, modifier] = time12h.split(" ");
  let [hours, minutes] = time.split(":");

  if (hours === "12") {
    hours = modifier === "AM" ? "00" : "12";
  } else if (modifier === "PM") {
    hours = String(parseInt(hours, 10) + 12);
  }

  return `${hours.padStart(2, "0")}:${minutes}`;
}

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
 * Transform ResLab location to UnifiedLot format
 */
function transformLocation(
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

    // We don't have ratings from ResLab - could add later from reviews
    rating: undefined,
    reviewCount: undefined,

    distanceFromAirport: distance,

    pricing: minPriceData
      ? {
          minPrice:
            minPriceData.reservation.grand_total /
            (minPriceData.reservation.totals?.parking?.number_of_days || 1),
          currency: currencyCode === "USD" ? "$" : currencyCode,
          currencyCode,
          parkingTypes: [], // Will be populated on lot detail page
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
function sortLots(lots: UnifiedLot[], sortBy: SortOption): UnifiedLot[] {
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
      // For now, sort by distance as a proxy for popularity
      sorted.sort(
        (a, b) =>
          (a.distanceFromAirport ?? 999) - (b.distanceFromAirport ?? 999)
      );
      break;
  }

  return sorted;
}

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const airport = searchParams.get("airport") || "JFK";
  // Default dates use tomorrow (ResLab requires advance booking)
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const checkin = searchParams.get("checkin") || tomorrow.toISOString().split("T")[0];
  const checkout =
    searchParams.get("checkout") ||
    new Date(Date.now() + 8 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
  const checkinTime = searchParams.get("checkinTime") || "10:00 AM";
  const checkoutTime = searchParams.get("checkoutTime") || "2:00 PM";
  const sort = (searchParams.get("sort") || "popularity") as SortOption;

  // Validate airport
  const airportInfo = getAirportByCode(airport);
  if (!airportInfo) {
    return NextResponse.json(
      { error: "Invalid airport code" },
      { status: 400 }
    );
  }

  try {
    // Convert times to 24-hour format
    const checkinTime24 = convertTo24Hour(checkinTime);
    const checkoutTime24 = convertTo24Hour(checkoutTime);

    // Format dates for ResLab API (YYYY-MM-DD HH:mm:ss)
    const fromDate = `${checkin} ${checkinTime24}:00`;
    const toDate = `${checkout} ${checkoutTime24}:00`;

    // Search for locations near the airport
    let locations: ReslabLocation[] = [];

    try {
      // If airport has a direct ResLab location ID, use that
      if (airportInfo.reslabLocationId) {
        // For test airports, search by location ID
        const result = await reslab.searchLocations({
          locations: [airportInfo.reslabLocationId],
        });
        locations = result || [];
      } else {
        // For production airports, search by coordinates
        const result = await reslab.searchLocations({
          lat: String(airportInfo.latitude),
          lng: String(airportInfo.longitude),
        });
        locations = result || [];
      }
    } catch (searchError) {
      console.error("Error searching locations:", searchError);
      locations = [];
    }

    // If no locations found, return empty results
    if (!locations || locations.length === 0) {
      return NextResponse.json({
        airport: airportInfo,
        checkin,
        checkout,
        checkinTime,
        checkoutTime,
        results: [],
        total: 0,
        message: "No parking locations found near this airport",
      });
    }

    // Get minimum price for each location
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
        } catch (error) {
          console.error(
            `Error getting min price for location ${location.id}:`,
            error
          );
        }

        return transformLocation(
          location,
          minPriceData,
          airportInfo.latitude,
          airportInfo.longitude
        );
      })
    );

    // Filter out unavailable lots (optional - you might want to show them)
    const availableLots = lotsWithPricing.filter(
      (lot) => lot.availability !== "unavailable"
    );

    // Sort lots
    const sortedLots = sortLots(availableLots, sort);

    return NextResponse.json(
      {
        airport: airportInfo,
        checkin,
        checkout,
        checkinTime,
        checkoutTime,
        results: sortedLots,
        total: sortedLots.length,
      },
      {
        headers: {
          "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600",
        },
      }
    );
  } catch (error) {
    console.error("Search API error:", error);
    return NextResponse.json(
      {
        error: "Failed to search for parking",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
