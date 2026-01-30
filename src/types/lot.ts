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

export interface UnifiedLot {
  id: string;
  source: "reslab" | "direct";
  sourceId: string;
  reslabLocationId?: number; // ResLab location ID for API calls

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

  minimumBookingDays?: number;
  hoursBeforeReservation?: number;
  dailyOrHourly?: "daily" | "hourly";

  // Payment handling
  dueAtLocation?: boolean; // If true, customer pays at the lot
  dueAtLocationAmount?: number;

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
