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
// provide. Here it is mocked to CALL THROUGH (not to throw), so the inserts
// this file asserts on actually fire — these are contract tests about the
// ROW, not about the scheduling. The throw-and-fall-back-to-a-dangling-
// promise branch is covered in src/lib/search-events/__tests__/log.test.ts
// (and its availability_log twin), which mock after() to throw.
vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return {
    ...actual,
    after: (fn: () => unknown) => {
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

const sentry = vi.hoisted(() => ({ captureAPIError: vi.fn() }));
vi.mock("@/lib/sentry", () => ({ captureAPIError: sentry.captureAPIError }));

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

// 11am Eastern on Oct 1 2026 — mid-day in the airport's own zone, so no
// UTC/local day boundary is in play except where a test deliberately moves
// the clock across one.
const NOW_UTC = "2026-10-01T15:00:00Z";

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
  sentry.captureAPIError.mockClear();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  process.env.NEXT_PUBLIC_APP_ENV = "production";
  // Pin "now" (Date only — the loggers' fire-and-forget hand-off and flush()
  // need real timers). Not cosmetic: lead_days is now GATED before the
  // insert (027's lead_days >= -1), so with a real clock every fixture date
  // below silently stops being written once that date is a fortnight past,
  // and this whole file would start passing vacuously in 2027.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW_UTC));
});

afterEach(() => {
  delete process.env.NEXT_PUBLIC_APP_ENV;
  vi.useRealTimers();
});

/** The one search_events row this call wrote, or undefined. */
function latestSearchEvent(): Record<string, unknown> | undefined {
  const call = insertCalls.find((c) => c.table === "search_events");
  return call ? (call.rows as Record<string, unknown>) : undefined;
}

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
      // Exact, against the pinned clock: Oct 1 -> Oct 10 is 9 days out.
      // (A `typeof … === "number"` assertion here would pass on the UTC
      // baseline this design exists to avoid — see the timezone-boundary
      // block below, which pins that down on this same real code path.)
      lead_days: 9,
    });
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

describe("timezone boundary — lead_days is the AIRPORT's today, not UTC's", () => {
  // Date is already faked by beforeEach; these just move it.
  const atUtc = (iso: string) => vi.setSystemTime(new Date(iso));

  it("logs lead_days against the airport's local day for a US evening search", async () => {
    // 9:30pm Eastern on Oct 10 is already Oct 11 in UTC. TEST-NY is
    // America/New_York, so "today" is Oct 10 and a check-in on Oct 15 is 5
    // days out — a UTC baseline would record 4 and under-count every US
    // evening search by a day, forever, with nothing to say it had.
    atUtc("2026-10-11T01:30:00Z");
    reslabMock.searchLocations.mockResolvedValue([fixtureLocation(1)]);
    reslabMock.getMinPrice.mockResolvedValue(minPrice({ grandTotal: 120 }));

    await searchParking({
      airport: AIRPORT,
      checkin: "2026-10-15",
      checkout: "2026-10-18",
      source: "search",
    });
    await flush();

    expect(latestSearchEvent()!.lead_days).toBe(5);
    expect(new Date().toISOString().slice(0, 10)).toBe("2026-10-11"); // UTC would say 4
  });

  it("agrees with UTC when no day boundary is crossed", async () => {
    atUtc("2026-10-11T15:00:00Z"); // 11am ET, Oct 11 in both
    reslabMock.searchLocations.mockResolvedValue([fixtureLocation(1)]);
    reslabMock.getMinPrice.mockResolvedValue(minPrice({ grandTotal: 120 }));

    await searchParking({
      airport: AIRPORT,
      checkin: "2026-10-15",
      checkout: "2026-10-18",
      source: "search",
    });
    await flush();

    expect(latestSearchEvent()!.lead_days).toBe(4);
  });

  it("writes the SAME lead_days to both tables for one search", async () => {
    atUtc("2026-10-11T01:30:00Z");
    reslabMock.searchLocations.mockResolvedValue([fixtureLocation(1)]);
    reslabMock.getMinPrice.mockResolvedValue(minPrice({ grandTotal: 120 }));

    await searchParking({
      airport: AIRPORT,
      checkin: "2026-10-15",
      checkout: "2026-10-18",
      source: "search",
    });
    await flush();

    const availabilityRows = insertCalls.find((c) => c.table === "availability_log")!
      .rows as Array<{ lead_days: number }>;
    expect(availabilityRows.every((r) => r.lead_days === 5)).toBe(true);
    expect(latestSearchEvent()!.lead_days).toBe(5);
  });
});

describe("the production path rejects dates Postgres would bounce", () => {
  it("drops the header row for a calendar-invalid check-in, and reports it on its own signature", async () => {
    // "2026-02-30" passes /api/search's shape regex and dayDiff returns a
    // number for it (Date.parse rolls it to Mar 2) — nothing upstream stops
    // it. 027's date column rejects it as 22008.
    reslabMock.searchLocations.mockResolvedValue([fixtureLocation(1)]);
    reslabMock.getMinPrice.mockResolvedValue(minPrice({ grandTotal: 120 }));

    const result = await searchParking({
      airport: AIRPORT,
      checkin: "2026-02-30",
      checkout: "2026-03-05",
      source: "search",
    });
    await flush();

    // The customer still gets their search.
    expect(result.total).toBe(1);
    expect(latestSearchEvent()).toBeUndefined();
    const dropReports = sentry.captureAPIError.mock.calls.filter(
      (c) => c[1]?.endpoint === "search_events.dropped_row"
    );
    expect(dropReports).toHaveLength(1);
  });

  it("drops the header row for a reversed range", async () => {
    reslabMock.searchLocations.mockResolvedValue([fixtureLocation(1)]);
    reslabMock.getMinPrice.mockResolvedValue(minPrice({ grandTotal: 120 }));

    await searchParking({
      airport: AIRPORT,
      checkin: "2026-10-14",
      checkout: "2026-10-10",
      source: "search",
    });
    await flush();

    expect(latestSearchEvent()).toBeUndefined();
    expect(
      sentry.captureAPIError.mock.calls.some(
        (c) => c[1]?.endpoint === "search_events.dropped_row"
      )
    ).toBe(true);
  });

  it("drops the header row for a long-past check-in (027's lead_days >= -1)", async () => {
    vi.setSystemTime(new Date("2026-10-11T15:00:00Z"));
    reslabMock.searchLocations.mockResolvedValue([fixtureLocation(1)]);
    reslabMock.getMinPrice.mockResolvedValue(minPrice({ grandTotal: 120 }));

    await searchParking({
      airport: AIRPORT,
      checkin: "2026-09-01",
      checkout: "2026-09-05",
      source: "search",
    });
    await flush();

    expect(latestSearchEvent()).toBeUndefined();
  });

  it("still writes the header row for a same-day (0-night) stay", async () => {
    vi.setSystemTime(new Date("2026-10-11T15:00:00Z"));
    reslabMock.searchLocations.mockResolvedValue([fixtureLocation(1)]);
    reslabMock.getMinPrice.mockResolvedValue(minPrice({ grandTotal: 120 }));

    await searchParking({
      airport: AIRPORT,
      checkin: "2026-10-12",
      checkout: "2026-10-12",
      source: "search",
    });
    await flush();

    expect(latestSearchEvent()).toMatchObject({ stay_days: 0, lead_days: 1 });
  });
});

describe("sold_out_count is NULL, not 0, when nothing priced", () => {
  it("records the header row with sold_out_count NULL when every ResLab pricing call fails", async () => {
    // Total pricing outage: searchParking throws a 502 so the route can serve
    // an uncacheable error — but the demand was real, and the header row is
    // written BEFORE the throw (same as availability_log's own rows).
    reslabMock.searchLocations.mockResolvedValue([fixtureLocation(1), fixtureLocation(2)]);
    reslabMock.getMinPrice.mockRejectedValue(new Error("ResLab 502"));

    await expect(
      searchParking({
        airport: AIRPORT,
        checkin: "2026-10-10",
        checkout: "2026-10-14",
        source: "search",
      })
    ).rejects.toThrow(/pricing unavailable/);
    await flush();

    expect(latestSearchEvent()).toMatchObject({
      results_count: 0,
      // Never 0 here: 0 would read as "we looked and nothing was sold out".
      sold_out_count: null,
      cheapest_price_cents: null,
      degraded: true,
    });
  });

  it("still reports 0 when lots priced and none were sold out", async () => {
    reslabMock.searchLocations.mockResolvedValue([fixtureLocation(1)]);
    reslabMock.getMinPrice.mockResolvedValue(minPrice({ grandTotal: 120 }));

    await searchParking({
      airport: AIRPORT,
      checkin: "2026-10-10",
      checkout: "2026-10-14",
      source: "search",
    });
    await flush();

    expect(latestSearchEvent()!.sold_out_count).toBe(0);
  });
});
