/**
 * Reservations Lab API Client
 *
 * This client handles all communication with the Reservations Lab API v1.10
 * API Docs: https://api.reservationslab.com
 */

const RESLAB_API_URL =
  process.env.RESLAB_API_URL || "https://api.reservationslab.com/v1";
const RESLAB_API_KEY = process.env.RESLAB_API_KEY || "";
const RESLAB_API_DOMAIN = process.env.RESLAB_API_DOMAIN || "triplypro.com";

// Token cache (server-side singleton)
let cachedToken: { token: string; expiry: number } | null = null;

// =============================================================================
// Types - Based on OpenAPI spec v1.10
// =============================================================================

export interface ReslabPhoto {
  id: number;
  filename: string;
  type: "facility" | "parking" | "room";
  featured: boolean | number;
  location_id?: number;
}

export interface ReslabAmenity {
  id: number;
  name: string;
  display_name: string;
  icon: string;
  type: "parking" | "facility" | "room";
  deleted_at: string | null;
}

export interface ReslabExtraField {
  id: number;
  name: string;
  label: string;
  type: "parking" | "room" | "both";
  input_type: "text" | "license_plate" | "number";
  per_car: boolean | number;
  value?: string; // Present in reservation responses
}

export interface ReslabCancellationPolicy {
  id: number;
  number_of_days: number;
  percentage: number;
  type: "parking" | "room";
}

export interface ReslabCountry {
  id: number;
  name: string;
  code: string;
}

export interface ReslabState {
  id: number;
  name: string;
  code: string;
  post_code: string | null;
}

export interface ReslabCurrency {
  id: number;
  name: string;
  code: string;
}

export interface ReslabTimezone {
  id: number;
  name: string;
  code: string;
}

export interface ReslabLocation {
  id: number;
  name: string;
  phone: string;
  address: string;
  city: string;
  zip_code: string;
  latitude: string;
  longitude: string;
  number_of_parkings: number;
  number_of_rooms?: number;
  description: string | null;
  directions: string | null;
  shuttle_info_summary: string | null;
  shuttle_info_details: string | null;
  special_conditions: string | null;
  front_desk_hours: string | null;
  minimum_booking_days: number;
  hours_before_reservation: number;
  tax_value: number;
  tax_type: "net" | "gross";
  daily_or_hourly: "daily" | "hourly";
  parking_due_at_location: boolean | number;
  room_due_at_location?: boolean | number;
  currency_id: number;
  country_id: number;
  state_id: number;
  printed_receipt: boolean | number;
  shuttle_available: boolean | number;
  parking_commission: number;
  parking_commission_type: "percentage" | "flat";
  port_type: "airport" | "port";
  reservations_count?: number;
  // Related data
  photos: ReslabPhoto[];
  facility_photos?: ReslabPhoto[];
  parking_photos?: ReslabPhoto[];
  amenities: ReslabAmenity[];
  extra_fields: ReslabExtraField[];
  cancellation_policies: ReslabCancellationPolicy[];
  country?: ReslabCountry;
  state?: ReslabState;
  currency?: ReslabCurrency;
  timezone?: ReslabTimezone;
  // Custom amenities
  facility_custom_amenities: string[];
  parking_custom_amenities: string[];
}

export interface ReslabParkingType {
  id: number;
  location_id: number;
  name: string;
  number_of_parkings: number;
}

export interface ReslabLocationTypes {
  parking: ReslabParkingType[];
}

export interface ReslabRate {
  id: number;
  location_parking_type_id?: number;
  price: number;
  from_date: string;
  to_date: string;
  number_of_days: number;
}

export interface ReslabFee {
  id: number;
  name: string;
  amount: number;
  calculation: "one_time" | "daily";
  type: "fixed" | "percentage";
  associated_to: "parking" | "room";
  description?: string;
  total: number;
  location_id?: number;
  channel_id?: number;
}

export interface ReslabMinPriceResponse {
  rates: ReslabRate[];
  reservation: {
    fees: ReslabFee[];
    due_at_location: number;
    tax_total: number;
    long_term_discount: number;
    location_commission: number;
    available_spots: number;
    discount: number;
    parking_sold_out: boolean;
    fees_total: number;
    totals: {
      parking: {
        number_of_days: number;
        sub_total: number;
      };
    };
    sold_out: boolean;
    sub_total: number;
    grand_total: number;
  };
  warning?: string;
  token?: string; // Search tracking token
}

export interface ReslabCostResponse {
  rates: ReslabRate[];
  reservation: {
    fees: ReslabFee[];
    due_at_location: number;
    tax_total: number;
    long_term_discount: number;
    location_commission: number;
    available_spots: number;
    discount: number;
    parking_sold_out: boolean;
    fees_total: number;
    totals: {
      parking: {
        number_of_days: number;
        sub_total: number;
      };
    };
    sold_out: boolean;
    sub_total: number;
    grand_total: number;
    total_after_cancellation_policy?: number;
  };
  old_reservation?: ReslabReservation;
  warning?: string;
  costs_token?: string; // Price guarantee token (5 min)
}

export interface ReslabReservationDate {
  id: number;
  reservation_history_id: number;
  type_id: number;
  type_type: string;
  from_date: string;
  to_date: string;
  check_in: boolean;
  check_out: boolean;
  check_in_time: string | null;
  check_out_time: string | null;
}

export interface ReslabReservationHistory {
  id: number;
  phone: string;
  email: string;
  address?: string;
  active: boolean;
  customer_address?: string;
  customer_city?: string;
  reserved_for: string;
  location_id: number;
  grand_total: number;
  subtotal: number;
  total_fees: number;
  total_tax: number;
  long_term_discount: number;
  due_at_location_total: number;
  dates: ReslabReservationDate[];
  fees: ReslabFee[];
  location: ReslabLocation;
  extra_fields?: ReslabExtraField[];
}

export interface ReslabReservation {
  reservation_number: string;
  channel_id: number;
  reserved_by: string;
  created_at: string;
  updated_at: string;
  cancelled: boolean;
  search_token?: string;
  testing: boolean;
  history: ReslabReservationHistory[];
}

// Request types
export interface MinPriceItem {
  type: "parking";
  reservation_type: "parking";
  from_date: string; // Format: "YYYY-MM-DD HH:mm:ss"
  to_date: string;
  number_of_spots: number;
}

export interface CostItem {
  type: "parking";
  reservation_type: "parking";
  type_id: number; // Parking type ID from /locations/{id}/types
  from_date: string;
  to_date: string;
  number_of_spots: number;
}

export interface CreateReservationRequest {
  location_id: number;
  reserved_by: string;
  reserved_for: string;
  phone: string;
  email: string;
  items: CostItem[];
  customer_address?: string;
  customer_city?: string;
  search_token?: string;
  costs_token?: string;
  // Extra fields are sent at the top level with their name as the key
  [key: string]: unknown;
}

// Paginated response wrapper
interface PaginatedResponse<T> {
  data: T[];
  first: string;
  last: string;
  prev: string | null;
  next: string | null;
  current_page: number;
  from: number;
  last_page: number;
  path: string;
  per_page: number;
  to: number;
  total: number;
}

// =============================================================================
// Authentication
// =============================================================================

async function getToken(): Promise<string> {
  // Return cached token if still valid (5 min buffer)
  if (cachedToken && Date.now() < cachedToken.expiry - 5 * 60 * 1000) {
    return cachedToken.token;
  }

  const response = await fetch(`${RESLAB_API_URL}/authenticate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      key: RESLAB_API_KEY,
      domain: RESLAB_API_DOMAIN,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new ReslabError(response.status, `Authentication failed: ${error}`);
  }

  const data = await response.json();
  cachedToken = {
    token: data.token,
    expiry: Date.now() + 60 * 60 * 1000, // 60 minutes
  };

  return cachedToken.token;
}

// =============================================================================
// Error Handling
// =============================================================================

export class ReslabError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public details?: unknown
  ) {
    super(message);
    this.name = "ReslabError";
  }
}

// =============================================================================
// Request Helper
// =============================================================================

async function request<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const token = await getToken();

  const headers: HeadersInit = {
    ...options.headers,
    Authorization: `Bearer ${token}`,
  };

  // Only set Content-Type for requests with a body
  if (options.body) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(`${RESLAB_API_URL}${endpoint}`, {
    ...options,
    headers,
  });

  if (response.status === 401) {
    // Token expired, clear cache and retry once
    cachedToken = null;
    const newToken = await getToken();
    const retryHeaders: HeadersInit = {
      ...options.headers,
      Authorization: `Bearer ${newToken}`,
    };
    if (options.body) {
      retryHeaders["Content-Type"] = "application/json";
    }
    const retryResponse = await fetch(`${RESLAB_API_URL}${endpoint}`, {
      ...options,
      headers: retryHeaders,
    });

    if (!retryResponse.ok) {
      const error = await retryResponse.text();
      throw new ReslabError(retryResponse.status, `API request failed: ${error}`);
    }
    return retryResponse.json();
  }

  if (!response.ok) {
    const error = await response.text();
    throw new ReslabError(response.status, `API request failed: ${error}`);
  }

  return response.json();
}

// =============================================================================
// API Client
// =============================================================================

export const reslab = {
  /**
   * Search for parking locations near coordinates (within 15km radius)
   */
  async searchLocations(params: {
    lat?: string;
    lng?: string;
    amenities?: number[];
    locations?: number[];
  }): Promise<ReslabLocation[]> {
    const query = new URLSearchParams();
    if (params.lat) query.set("lat", params.lat);
    if (params.lng) query.set("lng", params.lng);
    if (params.amenities) {
      params.amenities.forEach((a) => query.append("amenities[]", String(a)));
    }
    if (params.locations) {
      params.locations.forEach((l) => query.append("locations[]", String(l)));
    }

    const result = await request<{ data: ReslabLocation[] } | ReslabLocation[]>(
      `/locations/search?${query}`
    );

    // Handle both possible response formats
    if (Array.isArray(result)) {
      return result;
    }
    if (result && typeof result === "object" && "data" in result) {
      return result.data || [];
    }
    console.error("Unexpected searchLocations response format:", result);
    return [];
  },

  /**
   * Get all locations in the channel (paginated)
   */
  async getAllLocations(
    page: number = 1
  ): Promise<PaginatedResponse<ReslabLocation>> {
    return request(`/locations?page=${page}`);
  },

  /**
   * Get a single location by ID
   */
  async getLocation(locationId: number): Promise<ReslabLocation> {
    return request(`/locations/${locationId}`);
  },

  /**
   * Get parking types for a location (covered, uncovered, valet, etc.)
   */
  async getLocationTypes(locationId: number): Promise<ReslabLocationTypes> {
    return request(`/locations/${locationId}/types`);
  },

  /**
   * Get minimum price at a location for given dates
   * Returns the lowest available price across all parking types
   */
  async getMinPrice(
    locationId: number,
    item: MinPriceItem
  ): Promise<ReslabMinPriceResponse> {
    return request(`/locations/${locationId}/min-price`, {
      method: "POST",
      body: JSON.stringify({ items: [item] }),
    });
  },

  /**
   * Calculate full reservation cost for a specific parking type
   * Returns detailed breakdown with fees, taxes, discounts
   */
  async getCost(
    locationId: number,
    items: CostItem[],
    reservationNumber?: string
  ): Promise<ReslabCostResponse> {
    const body = {
      items,
      location_id: locationId,
      reservation_type: "parking", // Required at top level
    };

    const endpoint = reservationNumber
      ? `/cost?reservation_number=${reservationNumber}`
      : "/cost";

    return request(endpoint, {
      method: "POST",
      body: JSON.stringify(body),
    });
  },

  /**
   * Create a new reservation
   * Use costs_token from getCost() to guarantee the price for 5 minutes
   */
  async createReservation(
    data: CreateReservationRequest
  ): Promise<ReslabReservation> {
    return request("/reservations", {
      method: "POST",
      body: JSON.stringify(data),
    });
  },

  /**
   * Get all reservations (paginated)
   */
  async getAllReservations(
    page: number = 1
  ): Promise<PaginatedResponse<ReslabReservation>> {
    return request(`/reservations?page=${page}`);
  },

  /**
   * Get a reservation by confirmation number
   */
  async getReservation(reservationNumber: string): Promise<ReslabReservation> {
    return request(`/reservations/${reservationNumber}`);
  },

  /**
   * Update a reservation
   */
  async updateReservation(
    reservationNumber: string,
    data: Omit<CreateReservationRequest, "reserved_by">
  ): Promise<ReslabReservation> {
    return request(`/reservations/${reservationNumber}`, {
      method: "PUT",
      body: JSON.stringify(data),
    });
  },

  /**
   * Delete a reservation (only within 1 minute of creation)
   * Does not apply cancellation policy
   */
  async deleteReservation(reservationNumber: string): Promise<ReslabReservation> {
    return request(`/reservations/${reservationNumber}`, {
      method: "DELETE",
    });
  },

  /**
   * Cancel a reservation (applies cancellation policy)
   * Reservation must not be started or checked in
   */
  async cancelReservation(reservationNumber: string): Promise<ReslabReservation> {
    return request(`/reservations/${reservationNumber}/cancel`, {
      method: "PUT",
    });
  },

  /**
   * Roll back the last change (within 90 seconds)
   */
  async rollbackReservation(
    reservationNumber: string
  ): Promise<ReslabReservation> {
    return request(`/reservations/${reservationNumber}/rollback`, {
      method: "PUT",
    });
  },

  /**
   * Get refund percentage based on cancellation policy
   */
  async getRefundPercentage(
    reservationNumber: string
  ): Promise<{ refund_percentage: number }> {
    return request(`/reservations/${reservationNumber}/refund-percentage`);
  },

  /**
   * Get all amenities or amenities for a specific location
   */
  async getAmenities(locationId?: number): Promise<ReslabAmenity[]> {
    const query = locationId ? `?location_id=${locationId}` : "?_all=true";
    return request(`/amenities${query}`);
  },

  /**
   * Get all available currencies
   */
  async getCurrencies(): Promise<ReslabCurrency[]> {
    return request("/currencies");
  },

  /**
   * Validate license plate format
   */
  async validateLicensePlate(
    value: string
  ): Promise<{ valid: boolean }> {
    return request("/v1/validate-reservation-input", {
      method: "POST",
      body: JSON.stringify({ type: "license_plate", value }),
    });
  },
};

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Format date for ResLab API (YYYY-MM-DD HH:mm:ss)
 */
export function formatReslabDate(date: Date, time: string = "10:00"): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day} ${time}:00`;
}

/**
 * Parse ResLab date string to Date object
 */
export function parseReslabDate(dateStr: string): Date {
  return new Date(dateStr.replace(" ", "T"));
}

/**
 * Calculate number of days between two dates
 */
export function calculateDays(
  fromDate: string,
  toDate: string,
  dailyOrHourly: "daily" | "hourly"
): number {
  const from = parseReslabDate(fromDate);
  const to = parseReslabDate(toDate);

  if (dailyOrHourly === "hourly") {
    // 24-hour blocks from check-in time
    const diffMs = to.getTime() - from.getTime();
    return Math.ceil(diffMs / (24 * 60 * 60 * 1000));
  } else {
    // Calendar days
    const fromDay = new Date(from.getFullYear(), from.getMonth(), from.getDate());
    const toDay = new Date(to.getFullYear(), to.getMonth(), to.getDate());
    const diffMs = toDay.getTime() - fromDay.getTime();
    return Math.ceil(diffMs / (24 * 60 * 60 * 1000)) + 1;
  }
}

/**
 * Get the featured photo URL from a location
 */
export function getFeaturedPhoto(location: ReslabLocation): string | null {
  const featured = location.photos.find((p) => p.featured);
  if (featured) return featured.filename;
  if (location.photos.length > 0) return location.photos[0].filename;
  return null;
}

/**
 * Strip HTML tags from description text
 */
export function stripHtml(html: string | null): string {
  if (!html) return "";
  return html.replace(/<[^>]*>/g, "").trim();
}
