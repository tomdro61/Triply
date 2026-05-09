/**
 * Park Guard Partner Reservation Data API Client
 *
 * Forwards reservation data to Park Guard so customers who opted in to the
 * parking protection plan are recorded in their Coverage Hub. Park Guard
 * underwrites the protection product; Triply collects the premium and
 * forwards the reservation.
 *
 * Endpoints (per partner docs, v 2026-03-22):
 *   POST  /api/capture-reservation-data           — record a new reservation
 *   PATCH /api/update-reservation-data/<resId>    — modify or cancel
 *
 * Auth: Bearer <api_key>. IP whitelisting is currently disabled but can be
 * reinstated, in which case Vercel egress IPs would need a static-IP proxy.
 *
 * Compliance: never use the words "insurance", "coverage", "supplemental",
 * "settlement" in consumer-facing surfaces tied to this product.
 */

const PARKGUARD_API_URL =
  process.env.PARKGUARD_API_URL || "https://api.pgbacklot.com";
const PARKGUARD_API_KEY = process.env.PARKGUARD_API_KEY || "";

// =============================================================================
// Plan configuration — single tier at launch
// =============================================================================

export const PROTECTION_PLAN = {
  /** Name sent to Park Guard in `protection_plan` field. */
  name: "$1,000 Protection",
  /** Customer-facing premium charged at checkout. */
  price: 9.99,
  /** Damage/theft limit, used in marketing copy and internal records. */
  limitDollars: 1000,
} as const;

// =============================================================================
// Types — matches Park Guard partner API spec
// =============================================================================

export interface CaptureReservationRequest {
  /** Unique reservation ID — Triply uses the Supabase `bookings.id` UUID. */
  reservation_id: string;
  /** YYYY-MM-DD */
  reservation_start_date: string;
  /** YYYY-MM-DD */
  reservation_end_date: string;
  /** YYYY-MM-DD — when the booking was made */
  booking_date: string;
  parking_street_address: string;
  parking_city: string;
  parking_state: string;
  parking_zipcode: string;
  /** Plan name string — must match a plan configured on Park Guard's side. */
  protection_plan: string;
  // Optional fields
  email?: string;
  first_name?: string;
  last_name?: string;
  phone_number?: string;
  /** hh:mm:ss */
  reservation_start_time?: string;
  /** hh:mm:ss */
  reservation_end_time?: string;
  car_make?: string;
  car_model?: string;
  car_year?: number;
  protection_plan_price?: number;
  /** "cancelled" etc. */
  status?: string;
  number_of_plans?: number;
  booking_site?: string;
}

export interface CaptureReservationResponse {
  pg_identifier: string;
  message: string;
}

export interface UpdateReservationResponse {
  pg_identifier: string;
  message: string;
}

// =============================================================================
// Errors
// =============================================================================

/**
 * Sentinel statusCodes used by ParkGuardError when there is no HTTP response
 * to attach. Distinct values let Sentry alerts filter "config" vs "network"
 * without inspecting the message string.
 */
export const PARKGUARD_STATUS = {
  MISCONFIGURED: -2,
  UNREACHABLE: -1,
  /**
   * Permanent skip — required input data was missing, retrying won't help.
   * Reconciliation jobs should NOT pick these up; ops investigate manually.
   */
  MISSING_DATA: -3,
} as const;

export class ParkGuardError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = "ParkGuardError";
  }
}

// =============================================================================
// Request helper — single retry on network/5xx, throw on persistent failure.
// Mirrors the CMS hardening pattern in src/lib/cms.ts.
// =============================================================================

async function fetchOnce(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(8000) });
}

async function request<T>(path: string, init: RequestInit): Promise<T> {
  if (!PARKGUARD_API_KEY) {
    throw new ParkGuardError(
      PARKGUARD_STATUS.MISCONFIGURED,
      "PARKGUARD_API_KEY is not configured"
    );
  }

  const url = `${PARKGUARD_API_URL}${path}`;
  // Spread caller headers FIRST so Authorization (set last) can never be overridden.
  const headers: Record<string, string> = {
    ...((init.headers as Record<string, string>) ?? {}),
    "Content-Type": "application/json",
    Authorization: `Bearer ${PARKGUARD_API_KEY}`,
  };

  let res: Response;
  try {
    res = await fetchOnce(url, { ...init, headers });
    if (res.status >= 500) throw new Error(`Park Guard ${res.status}`);
  } catch (firstErr) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      res = await fetchOnce(url, { ...init, headers });
    } catch (retryErr) {
      throw new ParkGuardError(
        PARKGUARD_STATUS.UNREACHABLE,
        `Park Guard unreachable: ${path}`,
        { cause: retryErr }
      );
    }
    if (res.status >= 500) {
      throw new ParkGuardError(
        res.status,
        `Park Guard ${res.status} after retry: ${path}`
      );
    }
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ParkGuardError(res.status, `Park Guard ${res.status}: ${body}`);
  }

  return res.json() as Promise<T>;
}

// =============================================================================
// Client
// =============================================================================

export const parkGuard = {
  /**
   * Record a new reservation in Park Guard's Coverage Hub.
   * Returns Park Guard's pg_identifier which should be persisted on the booking.
   */
  async captureReservation(
    data: CaptureReservationRequest
  ): Promise<CaptureReservationResponse> {
    return request<CaptureReservationResponse>(
      "/api/capture-reservation-data",
      {
        method: "POST",
        body: JSON.stringify(data),
      }
    );
  },

  /**
   * Update a previously-captured reservation. The realistic mutations are
   * cancellation (`status: "cancelled"`), date/time changes, and number_of_plans.
   * Address/customer/vehicle fields are immutable post-capture.
   */
  async updateReservation(
    reservationId: string,
    data: Partial<
      Pick<
        CaptureReservationRequest,
        | "status"
        | "reservation_start_date"
        | "reservation_end_date"
        | "reservation_start_time"
        | "reservation_end_time"
        | "number_of_plans"
        | "protection_plan_price"
      >
    >
  ): Promise<UpdateReservationResponse> {
    return request<UpdateReservationResponse>(
      `/api/update-reservation-data/${encodeURIComponent(reservationId)}`,
      {
        method: "PATCH",
        body: JSON.stringify(data),
      }
    );
  },
};

// Format a Date as YYYY-MM-DD using LOCAL components, not toISOString.
// toISOString shifts to UTC and silently corrupts dates around midnight,
// which is exactly the regression class CLAUDE.md flags.
export function formatPgDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
