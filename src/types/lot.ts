export interface ShuttleInfo {
  summary: string;
  details: string;
  frequency?: string;
  operatingHours?: string;
}

export interface Photo {
  id: string;
  url: string;
  alt?: string;
  width?: number;
  height?: number;
}

export interface ParkingType {
  id: number;
  name: string;
  description?: string;
  price: number;
  originalPrice?: number;
  spotsAvailable?: number;
}

export interface Amenity {
  id: number;
  name: string;
  displayName: string;
  icon?: string;
}

export type LotBadge = "most_booked" | "lowest_total";

export interface UnifiedLot {
  id: string;
  source: "reslab" | "direct";
  sourceId: string;
  reslabLocationId?: number; // ResLab location ID for API calls
  /**
   * IATA code of the airport this lot was found for. Set by searchParking on
   * every result and by the direct-lot adapter always; a lot loaded by id
   * alone (the checkout API) may not carry it. Replaces the old
   * `lot.id.split("-")[0]` derivation, which only ever yielded "RESLAB".
   */
  airportCode?: string;

  name: string;
  slug: string;
  address: string;
  city: string;
  state: string;
  zipCode?: string;
  country?: string;
  latitude: number;
  longitude: number;

  description?: string;
  directions?: string;
  shuttleInfo?: ShuttleInfo;
  specialConditions?: string;
  phone?: string;

  amenities: Amenity[];
  photos: Photo[];

  rating?: number;
  reviewCount?: number;

  distanceFromAirport?: number;

  pricing?: {
    minPrice: number;
    maxPrice?: number;
    currency: string;
    currencyCode?: string;
    parkingTypes: ParkingType[];
    taxValue?: number;
    taxType?: "net" | "gross";
    grandTotal?: number;
    subtotal?: number;
    feesTotal?: number;
    taxTotal?: number;
    numberOfDays?: number;
  };

  availability: "available" | "limited" | "unavailable";

  /**
   * Set by searchParking on search results only (src/lib/search/ranking.ts):
   * "most_booked" = the airport's clear booking leader over the last 90 days;
   * "lowest_total" = the lowest total for the searched dates, never on a
   * degraded/partial result.
   */
  badges?: LotBadge[];

  minimumBookingDays?: number;
  hoursBeforeReservation?: number;
  dailyOrHourly?: "daily" | "hourly";

  // Payment handling
  dueAtLocation?: boolean; // If true, customer pays at the lot
  dueAtLocationAmount?: number;

  /**
   * DIRECT lots only: oversized-vehicle surcharges, PAID AT THE LOT and never
   * charged online (never part of dueAtLocation/dueAtLocationAmount, which
   * describe the booking's own price split). Empty = the lot has none.
   */
  vehicleSurcharges?: { code: string; label: string; dailyRateCents: number }[];
  /**
   * DIRECT lots only: whether this deployment lets the lot be checked out
   * (isDirectCheckoutOpen — DIRECT_BOOKING_OPEN, or the Preview-only flag).
   * Set server-side by the adapter: the flag is a server env var, so the
   * Reserve buttons read it from here. ResLab lots leave it undefined.
   */
  checkoutOpen?: boolean;

  // Extra fields required by location
  extraFields?: {
    id: number;
    name: string;
    label: string;
    type: string;
    inputType: string;
    perCar: boolean;
  }[];

  // Cancellation policy
  cancellationPolicies?: {
    numberOfDays: number;
    percentage: number;
  }[];
}

export interface SearchParams {
  airport: string;
  checkin: string;
  checkout: string;
  checkinTime?: string; // Format: "HH:mm" or "10:00 AM"
  checkoutTime?: string;
  spots?: number;
}

export interface SearchFilters {
  priceMin?: number;
  priceMax?: number;
  distance?: number;
  parkingType?: string[];
  amenities?: string[];
  rating?: number;
  shuttle?: boolean;
}

export type SortOption =
  | "price_asc"
  | "price_desc"
  | "distance"
  | "rating"
  | "popularity";
