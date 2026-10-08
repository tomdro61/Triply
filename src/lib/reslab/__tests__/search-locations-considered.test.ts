/**
 * searchParking's `locationsConsidered`: how many lots we list near the airport
 * before pricing. The airport pages use it to tell "we list nothing here"
 * (0 → "coming soon") from "we serve it, all booked" (> 0 with no results).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return { ...actual, after: (fn: () => unknown) => { void fn(); } };
});

const reslabMock = vi.hoisted(() => ({ searchLocations: vi.fn(), getMinPrice: vi.fn() }));
vi.mock("@/lib/reslab/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/reslab/client")>("@/lib/reslab/client");
  return { ...actual, reslab: reslabMock };
});

const sentry = vi.hoisted(() => ({ captureAPIError: vi.fn() }));
vi.mock("@/lib/sentry", () => ({ captureAPIError: sentry.captureAPIError }));
// The Recommended ranking reads booking counts from Supabase; these suites test
// other behaviour, so the counts are stubbed (empty, ok) rather than letting the
// shared DB fake fail and the capture throttle hide it.
vi.mock("@/lib/search/booking-popularity", () => ({
  getLotBookingCounts: vi.fn(async () => ({ ok: true, counts: new Map() })),
  isRecommendedRankingEnabled: () => true,
}));

const db = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createAdminClient: vi.fn(async () => db) }));

import { searchParking, __resetLocationListCacheForTests } from "../search";
import { __resetAvailabilityLogWarnStateForTests } from "@/lib/availability/log";
import { __resetSearchEventsLogWarnStateForTests } from "@/lib/search-events/log";

function fixtureLocation(id: number) {
  return {
    id, name: `Lot ${id}`, phone: "555-0100", address: "1 Airport Way", city: "Queens", zip_code: "11430",
    latitude: "40.6413", longitude: "-73.7781", number_of_parkings: 1, description: null, directions: null,
    shuttle_info_summary: null, shuttle_info_details: null, special_conditions: null, front_desk_hours: null,
    minimum_booking_days: 1, hours_before_reservation: 0, tax_value: 0, tax_type: "net", daily_or_hourly: "daily",
    parking_due_at_location: false, currency_id: 1, country_id: 1, state_id: 1, printed_receipt: false,
    shuttle_available: false, parking_commission: 0, parking_commission_type: "flat", port_type: "airport",
    photos: [], amenities: [], extra_fields: [], cancellation_policies: [], facility_custom_amenities: [], parking_custom_amenities: [],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}
function minPrice({ soldOut = false, grandTotal = 100 } = {}) {
  return {
    rates: [],
    reservation: {
      fees: [], due_at_location: 0, tax_total: 0, long_term_discount: 0, location_commission: 0,
      available_spots: soldOut ? 0 : 50, discount: 0, parking_sold_out: soldOut, fees_total: 0,
      totals: { parking: { number_of_days: 4, sub_total: grandTotal } },
      sold_out: soldOut, sub_total: grandTotal, grand_total: grandTotal,
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

// TEST-NY maps to a single ResLab location id, so the list comes from
// searchLocations() and no page sweep is involved; the mock returns whatever
// locations each case needs.
const search = () =>
  searchParking({ airport: "TEST-NY", checkin: "2026-10-10", checkout: "2026-10-14", source: "search" });

beforeEach(() => {
  reslabMock.searchLocations.mockReset();
  reslabMock.getMinPrice.mockReset();
  db.from.mockReset();
  db.from.mockImplementation(() => ({
    insert: () => ({ abortSignal: () => Promise.resolve({ error: null }) }),
  }));
  __resetLocationListCacheForTests();
  __resetAvailabilityLogWarnStateForTests();
  __resetSearchEventsLogWarnStateForTests();
  sentry.captureAPIError.mockClear();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  delete process.env.ENABLE_DIRECT_LOTS;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-01T15:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("searchParking — locationsConsidered", () => {
  it("counts every listed lot when all price", async () => {
    reslabMock.searchLocations.mockResolvedValue([fixtureLocation(1), fixtureLocation(2)]);
    reslabMock.getMinPrice.mockResolvedValue(minPrice());
    const r = await search();
    expect(r.total).toBe(2);
    expect(r.locationsConsidered).toBe(2);
  });

  it("still counts sold-out lots: all booked → total 0 but locationsConsidered > 0", async () => {
    reslabMock.searchLocations.mockResolvedValue([fixtureLocation(1), fixtureLocation(2)]);
    reslabMock.getMinPrice.mockResolvedValue(minPrice({ soldOut: true }));
    const r = await search();
    expect(r.total).toBe(0);
    expect(r.locationsConsidered).toBe(2);
  });

  it("one lot failing to price and the rest sold out throws — the page never decides copy on a partial answer", async () => {
    reslabMock.searchLocations.mockResolvedValue([fixtureLocation(1), fixtureLocation(2)]);
    reslabMock.getMinPrice.mockImplementation(async (id: number) => {
      if (id === 1) throw new Error("ResLab 502");
      return minPrice({ soldOut: true });
    });
    await expect(search()).rejects.toThrow(/pricing unavailable/);
  });

  it("excludes blocked lots (BLOCKED_RESLAB_LOCATION_IDS)", async () => {
    reslabMock.searchLocations.mockResolvedValue([fixtureLocation(1), fixtureLocation(416)]);
    reslabMock.getMinPrice.mockResolvedValue(minPrice());
    const r = await search();
    expect(r.locationsConsidered).toBe(1);
  });

  it("is 0 when no lots are listed near the airport", async () => {
    reslabMock.searchLocations.mockResolvedValue([]);
    const r = await search();
    expect(r.total).toBe(0);
    expect(r.locationsConsidered).toBe(0);
  });
});
