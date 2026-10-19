/**
 * Shared Park & Stay test fixtures (not a test file). Shapes follow the
 * 18 Oct production location snapshot and the 19 Oct sandbox `/hotels/rates`
 * response (V2, `includeHotelData: true`).
 */
import type { ReslabLocation, ReslabMinPriceResponse } from "@/lib/reslab/client";
import type { HotelLotEntry } from "../hotel-lots";
import type { LiteApiHotelRates, LiteApiHotelContentWire, LiteApiRate } from "../liteapi/rates";

export const PROD_FINGERPRINT = "f5d7c11622bdb289";

/** Minutes → "YYYY-MM-DD" helpers live in dates.ts; tests use fixed instants. */
export function locationFor(entry: HotelLotEntry, over: Partial<ReslabLocation> = {}): ReslabLocation {
  const id = entry.reslab.ids.production ?? 0;
  return {
    id,
    name: entry.reslab.name,
    phone: "000",
    address: `${id} Test Street`,
    city: "Test",
    zip_code: "00000",
    latitude: String(entry.reslab.latitude),
    longitude: String(entry.reslab.longitude),
    number_of_parkings: 100,
    description: null,
    directions: null,
    shuttle_info_summary: "<p>24/7 every 30 minutes</p>",
    shuttle_info_details: null,
    special_conditions: "<p>Oversized vehicles pay at the lot.</p>",
    front_desk_hours: "24/7",
    minimum_booking_days: 0,
    hours_before_reservation: 0,
    tax_value: 0,
    tax_type: "net",
    daily_or_hourly: "hourly",
    parking_due_at_location: 0,
    currency_id: 1,
    country_id: 1,
    state_id: 1,
    printed_receipt: 0,
    shuttle_available: 1,
    parking_commission: 85,
    parking_commission_type: "percentage",
    port_type: "airport",
    type: "parking_room",
    checkin_time: "16:00",
    checkout_time: "11:00",
    free_shuttle: 1,
    port_code: entry.airport,
    photos: [],
    amenities: [],
    extra_fields: [],
    cancellation_policies: [{ id: 1, number_of_days: 0, percentage: 100, type: "parking" }],
    timezone: { id: 1, name: "Eastern", code: "America/New_York" },
    facility_custom_amenities: [],
    parking_custom_amenities: [],
    ...over,
  };
}

export function minPrice(o: {
  grand: number;
  sub: number;
  fees?: number;
  ltd?: number;
  tax?: number;
  due?: number;
  discount?: number;
  lc?: number;
  soldOut?: boolean;
}): ReslabMinPriceResponse {
  return {
    rates: [],
    reservation: {
      fees: [],
      due_at_location: o.due ?? 0,
      tax_total: o.tax ?? 0,
      long_term_discount: o.ltd ?? 0,
      location_commission: o.lc ?? 0,
      available_spots: 20,
      discount: o.discount ?? 0,
      parking_sold_out: false,
      fees_total: o.fees ?? 0,
      totals: { parking: { number_of_days: 1, sub_total: o.sub } },
      sold_out: o.soldOut ?? false,
      sub_total: o.sub,
      grand_total: o.grand,
    },
  };
}

export function rate(o: {
  rateId: string;
  net: number;
  ssp?: number | null;
  refundable?: boolean;
  boardType?: string;
  atHotel?: { amount: number; currency?: string; description?: string }[];
}): LiteApiRate {
  return {
    rateId: o.rateId,
    name: `Room ${o.rateId}`,
    boardType: o.boardType ?? "RO",
    boardName: "Room Only",
    retailRate: {
      total: [{ amount: o.net, currency: "USD" }],
      suggestedSellingPrice: o.ssp === null || o.ssp === undefined ? undefined : [{ amount: o.ssp, currency: "USD", source: "providerDirect" }],
      taxesAndFees: (o.atHotel ?? []).map((f) => ({ included: false, amount: f.amount, currency: f.currency, description: f.description ?? "City tax" })),
    },
    cancellationPolicies: o.refundable
      ? { refundableTag: "RFN", cancelPolicyInfos: [{ cancelTime: "2026-11-10 15:00:00", amount: o.net, currency: "USD", type: "amount", timezone: "America/New_York" }] }
      : { refundableTag: "NRFN", cancelPolicyInfos: [] },
    paymentTypes: ["NUITEE_PAY"],
  };
}

export function hotelRates(hotelId: string, rates: LiteApiRate[], roomTypeId = `rt-${hotelId}`): LiteApiHotelRates {
  return { hotelId, roomTypes: [{ roomTypeId, offerId: `offer-${hotelId}`, rates }] };
}

export function content(entry: HotelLotEntry, over: Partial<LiteApiHotelContentWire> = {}): LiteApiHotelContentWire {
  return {
    id: entry.liteapi.hotelId,
    name: entry.liteapi.name,
    main_photo: `https://static.cupid.travel/hotels/${entry.liteapi.hotelId}.jpg`,
    address: "1 Hotel Way",
    city_name: "Test",
    latitude: entry.liteapi.latitude,
    longitude: entry.liteapi.longitude,
    rating: 8,
    stars: 3,
    review_count: 100,
    ...over,
  };
}
