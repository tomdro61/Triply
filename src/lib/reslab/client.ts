/**
 * Reservations Lab API Client
 *
 * This client handles all communication with the Reservations Lab API.
 * See docs: outputs/triply_reslab_integration.md
 */

const RESLAB_API_URL = process.env.RESLAB_API_URL || "https://api.reservationslab.com";
const RESLAB_API_KEY = process.env.RESLAB_API_KEY || "";
const RESLAB_API_DOMAIN = process.env.RESLAB_API_DOMAIN || "triplypro.com";

// Token cache
let cachedToken: { token: string; expiry: number } | null = null;

/**
 * Get or refresh authentication token
 */
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
    throw new Error(`Authentication failed: ${response.status}`);
  }

  const data = await response.json();
  cachedToken = {
    token: data.token,
    expiry: Date.now() + 60 * 60 * 1000, // 60 minutes
  };

  return cachedToken.token;
}

/**
 * Make authenticated request to Reservations Lab API
 */
async function request<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const token = await getToken();

  const response = await fetch(`${RESLAB_API_URL}${endpoint}`, {
    ...options,
    headers: {
      ...options.headers,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });

  if (response.status === 401) {
    // Token expired, clear cache and retry once
    cachedToken = null;
    const newToken = await getToken();
    const retryResponse = await fetch(`${RESLAB_API_URL}${endpoint}`, {
      ...options,
      headers: {
        ...options.headers,
        Authorization: `Bearer ${newToken}`,
        "Content-Type": "application/json",
      },
    });

    if (!retryResponse.ok) {
      throw new Error(`API request failed: ${retryResponse.status}`);
    }
    return retryResponse.json();
  }

  if (!response.ok) {
    throw new Error(`API request failed: ${response.status}`);
  }

  return response.json();
}

// Types
export interface Location {
  id: number;
  name: string;
  phone: string;
  address: string;
  city: string;
  zip_code: string;
  latitude: string;
  longitude: string;
  number_of_parkings: number;
  description: string;
  directions: string;
  shuttle_info_summary: string;
  shuttle_info_details: string;
  minimum_booking_days: number;
  hours_before_reservation: number;
  tax_value: number;
  tax_type: "net" | "gross";
  daily_or_hourly: "daily" | "hourly";
  photos: { url: string; alt?: string }[];
  amenities: { id: number; name: string; display_name: string }[];
}

export interface ParkingType {
  id: number;
  location_id: number;
  name: string;
  number_of_parkings: number;
}

export interface MinPriceItem {
  type: "parking";
  from_date: string;
  to_date: string;
  number_of_spots: number;
}

export interface CostItem {
  type: "parking";
  type_id: number;
  from_date: string;
  to_date: string;
  number_of_spots: number;
}

export interface Cost {
  rates: {
    date: string;
    price: number;
  }[];
  reservation: {
    subtotal: number;
    total_fees: number;
    total_tax: number;
    long_term_discount: number;
    grand_total: number;
  };
  warning?: string;
}

export interface CreateReservationRequest {
  location_id: number;
  reserved_by: string;
  reserved_for: string;
  phone: string;
  email: string;
  items: CostItem[];
  extra_fields?: { name: string; value: string }[];
}

export interface Reservation {
  reservation_number: string;
  status: string;
  location: Location;
  // ... other fields
}

// API Methods
export const reslab = {
  /**
   * Search for parking locations near coordinates
   */
  async searchLocations(params: {
    lat?: string;
    lng?: string;
    amenities?: number[];
  }): Promise<Location[]> {
    const query = new URLSearchParams();
    if (params.lat) query.set("lat", params.lat);
    if (params.lng) query.set("lng", params.lng);
    if (params.amenities) {
      params.amenities.forEach((a) => query.append("amenities[]", String(a)));
    }

    return request<Location[]>(`/locations/search?${query}`);
  },

  /**
   * Get parking types for a location
   */
  async getLocationTypes(
    locationId: number
  ): Promise<{ parking: ParkingType[] }> {
    return request(`/locations/${locationId}/types`);
  },

  /**
   * Get minimum price for a location
   */
  async getMinPrice(
    locationId: number,
    item: MinPriceItem
  ): Promise<{ min_price: number }> {
    return request(`/locations/${locationId}/min-price`, {
      method: "POST",
      body: JSON.stringify({ items: [item] }),
    });
  },

  /**
   * Calculate full reservation cost
   */
  async getCost(items: CostItem[]): Promise<Cost> {
    return request("/cost", {
      method: "POST",
      body: JSON.stringify({ items }),
    });
  },

  /**
   * Create a new reservation
   */
  async createReservation(data: CreateReservationRequest): Promise<Reservation> {
    return request("/reservations", {
      method: "POST",
      body: JSON.stringify(data),
    });
  },

  /**
   * Get reservation by confirmation number
   */
  async getReservation(reservationNumber: string): Promise<Reservation> {
    return request(`/reservations/${reservationNumber}`);
  },

  /**
   * Cancel a reservation
   */
  async cancelReservation(reservationNumber: string): Promise<Reservation> {
    return request(`/reservations/${reservationNumber}/cancel`, {
      method: "PUT",
    });
  },

  /**
   * Get refund percentage for cancellation
   */
  async getRefundPercentage(
    reservationNumber: string
  ): Promise<{ percentage: number }> {
    return request(`/reservations/${reservationNumber}/refund-percentage`);
  },

  /**
   * Get all amenities
   */
  async getAmenities(
    locationId?: number
  ): Promise<{ id: number; name: string; display_name: string }[]> {
    const query = locationId ? `?location_id=${locationId}` : "?_all=true";
    return request(`/amenities${query}`);
  },
};
