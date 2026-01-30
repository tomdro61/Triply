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

  name: string;
  slug: string;
  address: string;
  city: string;
  state: string;
  zipCode?: string;
  latitude: number;
  longitude: number;

  description?: string;
  directions?: string;
  shuttleInfo?: ShuttleInfo;
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
    parkingTypes: ParkingType[];
  };

  availability: "available" | "limited" | "unavailable";

  minimumBookingDays?: number;
  hoursBeforeReservation?: number;
  dailyOrHourly?: "daily" | "hourly";
}

export interface SearchParams {
  airport: string;
  checkin: string;
  checkout: string;
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
