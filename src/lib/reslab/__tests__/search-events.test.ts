/**
 * search_events is now written from INSIDE searchParking, alongside
 * availability_log, sharing search_id/env/lead_days (see the PR-32 rework
 * and migration 027). This is the contract test for that design: it exercises
 * the REAL searchParking() code path (not a mocked-to-throw stand-in for it),
 * with only the ResLab client and the Supabase admin client mocked, and
 * asserts the actual inserted search_events payload — including that it
 * shares search_id with the availability_log rows from the same call.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// after() requires a live Next.js request scope, which vitest doesn't
// provide — forcing it to throw exercises the same fallback (plain
// fire-and-forget) a real unit test run hits anyway. Identical pattern to
// the old route-level test this replaces.
vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return {
    ...actual,
    after: (fn: () => unknown) => {
      // Run it anyway so the insert still fires for these tests, the way
      // the plain fire-and-forget fallback does.
      void fn();
    },
  };
});

const reslabMock = vi.hoisted(() => ({
  searchLocations: vi.fn(),
  getMinPrice: vi.fn(),
}));
vi.mock("@/lib/reslab/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/reslab/client")>(
    "@/lib/reslab/client"
  );
  return { ...actual, reslab: reslabMock };
});

vi.mock("@/lib/sentry", () => ({ captureAPIError: vi.fn() }));

interface InsertCall {
  table: string;
  rows: unknown;
}
const insertCalls: InsertCall[] = [];
const supabaseFrom = vi.hoisted(() => vi.fn());
vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: vi.fn(async () => ({ from: supabaseFrom })),
}));

import {
  searchParking,
  __resetLocationListCacheForTests,
} from "../search";
import { __resetAvailabilityLogWarnStateForTests } from "@/lib/availability/log";
import { __resetSearchEventsLogWarnStateForTests } from "@/lib/search-events/log";

// Minimal ResLab location — only the fields transformLocation/searchParking
// actually reads are populated; the rest is irrelevant to this contract.
function fixtureLocation(id: number) {
  return {
    id,
    name: `Lot ${id}`,
    phone: "555-0100",
    address: "1 Airport Way",
    city: "Queens",
    zip_code: "11430",
    latitude: "40.6413",
    longitude: "-73.7781",
    number_of_parkings: 1,
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
    shuttle_available: false,
    parking_commission: 0,
    parking_commission_type: "flat",
    port_type: "airport",
    photos: [],
    amenities: [],
    extra_fields: [],
    cancellation_policies: [],
    facility_custom_amenities: [],
    parking_custom_amenities: [],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function minPrice(opts: { soldOut?: boolean; grandTotal?: number; availableSpots?: number } = {}) {
  return {
    rates: [],
    reservation: {
      fees: [],
      due_at_location: 0,
      tax_total: 0,
      long_term_discount: 0,
      location_commission: 0,
      available_spots: opts.availableSpots ?? 50,
      discount: 0,
      parking_sold_out: opts.soldOut ?? false,
      fees_total: 0,
      totals: { parking: { number_of_days: 4, sub_total: opts.grandTotal ?? 100 } },
      sold_out: opts.soldOut ?? false,
      sub_total: opts.grandTotal ?? 100,
      grand_total: opts.grandTotal ?? 100,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

// TEST-NY: reslabLocationId 195, timezone America/New_York — single mapped
// location, so searchLocations({ locations: [195] }) is the path exercised,
// skipping the paginated geo-search build entirely (see location-list-cache
// tests for that path).
const AIRPORT = "TEST-NY";

function flush() {
  return new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  insertCalls.length = 0;
  reslabMock.searchLocations.mockReset();
  reslabMock.getMinPrice.mockReset();
  supabaseFrom.mockReset();
  supabaseFrom.mockImplementation((table: string) => ({
    insert: (rows: unknown) => {
      insertCalls.push({ table, rows });
      return {
        abortSignal: () => Promise.resolve({ error: null }),
      };
    },
  }));
  __resetLocationListCacheForTests();
  __resetAvailabilityLogWarnStateForTests();
  __resetSearchEventsLogWarnStateForTests();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  process.env.NEXT_PUBLIC_APP_ENV = "production";
});

afterEach(() => {
  delete process.env.NEXT_PUBLIC_APP_ENV;
});

describe("searchParking → search_events header row", () => {
  it("writes one search_events row sharing search_id with the availability_log rows from the same call", async () => {
    reslabMock.searchLocations.mockResolvedValue([fixtureLocation(1), fixtureLocation(2)]);
    reslabMock.getMinPrice
      .mockResolvedValueOnce(minPrice({ grandTotal: 150 }))
      .mockResolvedValueOnce(minPrice({ grandTotal: 90, soldOut: true }));

    await searchParking({
      airport: AIRPORT,
      checkin: "2026-10-10",
      checkout: "2026-10-14",
      source: "search",
      datesDefaulted: false,
      attribution: {
        utmSource: "google",
        utmMedium: "cpc",
        utmCampaign: "brand",
        gaClientId: "GA1.2.3",
      },
    });
    await flush();

    const availabilityInsert = insertCalls.find((c) => c.table === "availability_log");
    const searchEventInsert = insertCalls.find((c) => c.table === "search_events");
    expect(availabilityInsert).toBeDefined();
    expect(searchEventInsert).toBeDefined();

    const availabilityRows = availabilityInsert!.rows as Array<{ search_id: string }>;
    const searchEventRow = searchEventInsert!.rows as Record<string, unknown>;

    // The join key: every availability_log row from this search carries the
    // same search_id as the one search_events header row.
    expect(availabilityRows.every((r) => r.search_id === searchEventRow.search_id)).toBe(true);
    expect(searchEventRow).toMatchObject({
      env: "production",
      airport_code: "TEST-NY",
      check_in: "2026-10-10",
      check_out: "2026-10-14",
      stay_days: 4,
      dates_defaulted: false,
      results_count: 1, // one of the two lots sold out and is filtered
      sold_out_count: 1,
      degraded: false,
      stale: false,
      source: "search",
      utm_source: "google",
      utm_medium: "cpc",
      utm_campaign: "brand",
      ga_client_id: "GA1.2.3",
      // Cheapest priced total among lots that made it into the response
      // (the sold-out $90 lot is filtered out before this is computed).
      cheapest_price_cents: 15000,
    });
    expect(typeof searchEventRow.lead_days).toBe("number");
  });

  it("logs cheapest_price_cents NULL, not a partial minimum, when the result is degraded", async () => {
    reslabMock.searchLocations.mockResolvedValue([fixtureLocation(1), fixtureLocation(2)]);
    reslabMock.getMinPrice
      .mockResolvedValueOnce(minPrice({ grandTotal: 150 }))
      .mockRejectedValueOnce(new Error("ResLab pricing 502"));

    await searchParking({
      airport: AIRPORT,
      checkin: "2026-10-10",
      checkout: "2026-10-14",
      source: "search",
    });
    await flush();

    const searchEventRow = insertCalls.find((c) => c.table === "search_events")!
      .rows as Record<string, unknown>;
    expect(searchEventRow.degraded).toBe(true);
    expect(searchEventRow.cheapest_price_cents).toBeNull();
  });

  it("records a header row for a genuine zero-location result", async () => {
    reslabMock.searchLocations.mockResolvedValue([]);

    await searchParking({
      airport: AIRPORT,
      checkin: "2026-10-10",
      checkout: "2026-10-14",
      source: "chat",
    });
    await flush();

    expect(insertCalls.find((c) => c.table === "availability_log")).toBeUndefined();
    const searchEventRow = insertCalls.find((c) => c.table === "search_events")!
      .rows as Record<string, unknown>;
    expect(searchEventRow).toMatchObject({
      results_count: 0,
      cheapest_price_cents: null,
      sold_out_count: null,
      source: "chat",
    });
  });

  it("respects datesDefaulted and searchEventSource overrides (the featured-parking homepage widget)", async () => {
    reslabMock.searchLocations.mockResolvedValue([fixtureLocation(1)]);
    reslabMock.getMinPrice.mockResolvedValueOnce(minPrice({ grandTotal: 120 }));

    await searchParking({
      airport: AIRPORT,
      checkin: "2026-10-10",
      checkout: "2026-10-17",
      source: "search",
      searchEventSource: "homepage-featured",
      datesDefaulted: true,
    });
    await flush();

    const searchEventRow = insertCalls.find((c) => c.table === "search_events")!
      .rows as Record<string, unknown>;
    expect(searchEventRow.source).toBe("homepage-featured");
    expect(searchEventRow.dates_defaulted).toBe(true);
  });

  it("never throws and never blocks the search result when the search_events insert fails", async () => {
    reslabMock.searchLocations.mockResolvedValue([fixtureLocation(1)]);
    reslabMock.getMinPrice.mockResolvedValueOnce(minPrice({ grandTotal: 120 }));
    supabaseFrom.mockImplementation((table: string) => ({
      insert: (rows: unknown) => {
        insertCalls.push({ table, rows });
        if (table === "search_events") {
          return { abortSignal: () => Promise.reject(new Error("network down")) };
        }
        return { abortSignal: () => Promise.resolve({ error: null }) };
      },
    }));

    const result = await searchParking({
      airport: AIRPORT,
      checkin: "2026-10-10",
      checkout: "2026-10-14",
      source: "search",
    });
    await flush();

    expect(result.total).toBe(1);
    expect(console.warn).toHaveBeenCalledWith(
      "[search-events] insert failed (further failures reported to Sentry hourly):",
      "network down",
      ""
    );
  });
});
