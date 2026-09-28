import { describe, it, expect, beforeEach, vi } from "vitest";

// Rank 31: the lot detail page renders a "Limited Spots" tag when
// availability === "limited", but get-lot.ts only ever produced "available" or
// "unavailable", so the tag could never fire. Search derived "limited" from
// available_spots. Both now go through deriveAvailability; these tests pin the
// mapping AND that the lot page actually reaches the "limited" state from the
// same ResLab response search sees.
const reslabMock = vi.hoisted(() => ({
  getLocation: vi.fn(),
  getMinPrice: vi.fn(),
}));
vi.mock("@/lib/reslab/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/reslab/client")>(
    "@/lib/reslab/client",
  );
  return { ...actual, reslab: reslabMock };
});

import { deriveAvailability, LIMITED_SPOTS_THRESHOLD } from "../availability";
import { getLotFromReslab } from "../get-lot";
import { transformLocation } from "../search";
import type { ReslabLocation, ReslabMinPriceResponse } from "@/lib/reslab/client";

const FROM = "2026-10-01 10:00:00";
const TO = "2026-10-05 14:00:00";

function location(id: number): ReslabLocation {
  return {
    id,
    name: "Park For U",
    phone: "555-0100",
    address: "1 Airport Rd",
    city: "Boston",
    zip_code: "02128",
    latitude: "42.0",
    longitude: "-71.0",
    number_of_parkings: 200,
    description: null,
    directions: null,
    shuttle_info_summary: null,
    shuttle_info_details: null,
    special_conditions: null,
    front_desk_hours: null,
    minimum_booking_days: 1,
    hours_before_reservation: 0,
    tax_value: 0,
    tax_type: "net",
    daily_or_hourly: "daily",
    parking_due_at_location: false,
    currency_id: 1,
    country_id: 1,
    state_id: 1,
    printed_receipt: false,
    shuttle_available: true,
    parking_commission: 0,
    parking_commission_type: "percentage",
    port_type: "airport",
    photos: [],
    amenities: [],
    extra_fields: [],
    cancellation_policies: [],
    facility_custom_amenities: [],
    parking_custom_amenities: [],
  };
}

function minPrice(reservation: {
  sold_out: boolean;
  available_spots: number;
}): ReslabMinPriceResponse {
  return {
    rates: [],
    reservation: {
      fees: [],
      due_at_location: 0,
      tax_total: 5,
      long_term_discount: 0,
      location_commission: 0,
      discount: 0,
      parking_sold_out: reservation.sold_out,
      fees_total: 3,
      totals: { parking: { number_of_days: 4, sub_total: 80 } },
      sub_total: 80,
      grand_total: 88,
      ...reservation,
    },
  };
}

describe("deriveAvailability", () => {
  it("sold_out wins over any spot count", () => {
    expect(deriveAvailability({ sold_out: true, available_spots: 3 })).toBe("unavailable");
    expect(deriveAvailability({ sold_out: true, available_spots: 500 })).toBe("unavailable");
  });

  it("a real count under the threshold is limited", () => {
    expect(deriveAvailability({ sold_out: false, available_spots: 1 })).toBe("limited");
    expect(
      deriveAvailability({ sold_out: false, available_spots: LIMITED_SPOTS_THRESHOLD - 1 }),
    ).toBe("limited");
    // ResLab says not sold out but zero left: preserved from search's old rule.
    expect(deriveAvailability({ sold_out: false, available_spots: 0 })).toBe("limited");
  });

  it("at or above the threshold is available", () => {
    expect(
      deriveAvailability({ sold_out: false, available_spots: LIMITED_SPOTS_THRESHOLD }),
    ).toBe("available");
    expect(deriveAvailability({ sold_out: false, available_spots: 250 })).toBe("available");
  });

  it("never invents scarcity from a missing or malformed count", () => {
    expect(deriveAvailability(null)).toBe("available");
    expect(deriveAvailability(undefined)).toBe("available");
    expect(deriveAvailability({ sold_out: false })).toBe("available");
    // `null < 10` is true in JS: the old search check would have badged this.
    expect(deriveAvailability({ sold_out: false, available_spots: null })).toBe("available");
    expect(deriveAvailability({ sold_out: false, available_spots: "3" })).toBe("available");
    expect(deriveAvailability({ sold_out: false, available_spots: Number.NaN })).toBe("available");
    expect(deriveAvailability({ sold_out: false, available_spots: -1 })).toBe("available");
    expect(deriveAvailability({ sold_out: false, available_spots: 2.5 })).toBe("available");
  });

  it("only a literal true sold_out means sold out", () => {
    expect(deriveAvailability({ sold_out: "true", available_spots: 50 })).toBe("available");
  });
});

describe("lot detail page matches search for the same ResLab response", () => {
  beforeEach(() => {
    reslabMock.getLocation.mockReset();
    reslabMock.getMinPrice.mockReset();
  });

  const cases: Array<[string, { sold_out: boolean; available_spots: number }, string]> = [
    ["nearly full", { sold_out: false, available_spots: 4 }, "limited"],
    ["plenty left", { sold_out: false, available_spots: 40 }, "available"],
    ["sold out", { sold_out: true, available_spots: 0 }, "unavailable"],
  ];

  it.each(cases)("%s", async (_label, reservation, expected) => {
    const data = minPrice(reservation);
    reslabMock.getLocation.mockResolvedValue(location(7));
    reslabMock.getMinPrice.mockResolvedValue(data);

    const lot = await getLotFromReslab(7, FROM, TO);
    const searchLot = transformLocation(location(7), data, 42.0, -71.0);

    expect(lot?.availability).toBe(expected);
    expect(searchLot.availability).toBe(expected);
    // No extra ResLab call: the lot page reads the pricing call it already makes.
    expect(reslabMock.getMinPrice).toHaveBeenCalledTimes(1);
  });

  it("stays available (no badge) when pricing failed", async () => {
    reslabMock.getLocation.mockResolvedValue(location(7));
    reslabMock.getMinPrice.mockRejectedValue(new Error("ResLab 502"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const lot = await getLotFromReslab(7, FROM, TO);

    expect(lot?.availability).toBe("available");
    errSpy.mockRestore();
  });
});
