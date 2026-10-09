/**
 * The direct-lot merge inside searchParking (plan A-22). Exercises the REAL
 * searchParking + the REAL direct store (only the ResLab client, the Supabase
 * admin client and Sentry are mocked) so the environment/visibility rule, the
 * twin suppression and the telemetry columns are tested where they live.
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

// DIRECT_BOOKING_OPEN is a compile-time constant (false until Phase 3); a
// getter lets the twin tests exercise both sides of it.
const flagState = vi.hoisted(() => ({ bookingOpen: false }));
vi.mock("@/lib/direct/flag", async () => {
  const actual = await vi.importActual<typeof import("@/lib/direct/flag")>("@/lib/direct/flag");
  return { ...actual, get DIRECT_BOOKING_OPEN() { return flagState.bookingOpen; } };
});

import { searchParking, __resetLocationListCacheForTests } from "../search";
import { __resetAvailabilityLogWarnStateForTests } from "@/lib/availability/log";
import { __resetSearchEventsLogWarnStateForTests } from "@/lib/search-events/log";
import { __resetCaptureThrottleForTests } from "@/lib/direct/store";
import { directLotRow } from "@/lib/direct/__tests__/fixtures";

const inserts: Array<{ table: string; rows: unknown }> = [];

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
function minPrice(grandTotal = 100) {
  return {
    rates: [],
    reservation: {
      fees: [], due_at_location: 0, tax_total: 0, long_term_discount: 0, location_commission: 0, available_spots: 50,
      discount: 0, parking_sold_out: false, fees_total: 0, totals: { parking: { number_of_days: 4, sub_total: grandTotal } },
      sold_out: false, sub_total: grandTotal, grand_total: grandTotal,
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

/** rpc("direct_lots") → rows, or a PostgREST-shaped error. */
function directRows(rows: unknown[] | null, error: { code: string; message: string } | null = null) {
  db.rpc.mockReturnValue({ abortSignal: async () => ({ data: rows, error }) });
}

// TEST-NY: single mapped ResLab location (195), so the list comes from
// searchLocations({ locations: [195] }) and no page sweep is involved.
const AIRPORT = "TEST-NY";
const search = (over: Partial<Parameters<typeof searchParking>[0]> = {}) =>
  searchParking({ airport: AIRPORT, checkin: "2026-10-10", checkout: "2026-10-14", source: "search", ...over });
const flush = () => new Promise((r) => setTimeout(r, 0));
const searchEventRow = () => inserts.find((c) => c.table === "search_events")?.rows as Record<string, unknown> | undefined;

beforeEach(() => {
  inserts.length = 0;
  reslabMock.searchLocations.mockReset();
  reslabMock.getMinPrice.mockReset();
  db.from.mockReset();
  db.rpc.mockReset();
  db.from.mockImplementation((table: string) => ({
    insert: (rows: unknown) => {
      inserts.push({ table, rows });
      return { abortSignal: () => Promise.resolve({ error: null }) };
    },
  }));
  __resetLocationListCacheForTests();
  __resetAvailabilityLogWarnStateForTests();
  __resetSearchEventsLogWarnStateForTests();
  __resetCaptureThrottleForTests();
  sentry.captureAPIError.mockClear();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  process.env.NEXT_PUBLIC_APP_ENV = "staging";
  process.env.ENABLE_DIRECT_LOTS = "true";
  flagState.bookingOpen = false;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-01T15:00:00Z"));
});
afterEach(() => {
  delete process.env.NEXT_PUBLIC_APP_ENV;
  delete process.env.ENABLE_DIRECT_LOTS;
  vi.useRealTimers();
});

describe("searchParking — direct lots OFF (the default)", () => {
  it("never reads direct inventory and logs direct_results_count NULL", async () => {
    delete process.env.ENABLE_DIRECT_LOTS;
    reslabMock.searchLocations.mockResolvedValue([fixtureLocation(1)]);
    reslabMock.getMinPrice.mockResolvedValue(minPrice());

    const result = await search();
    await flush();

    expect(db.rpc).not.toHaveBeenCalled();
    expect(result.results.map((l) => l.id)).toEqual(["reslab-1"]);
    expect("directCount" in result).toBe(false);
    expect("reslabUnavailable" in result).toBe(false);
    expect(searchEventRow()).toMatchObject({ direct_results_count: null, direct_skipped: false });
  });

  it("still propagates a ResLab failure (nothing to serve instead)", async () => {
    delete process.env.ENABLE_DIRECT_LOTS;
    reslabMock.searchLocations.mockRejectedValue(new Error("ResLab 502"));
    await expect(search()).rejects.toThrow("ResLab 502");
    expect(db.rpc).not.toHaveBeenCalled();
  });
});

describe("searchParking — direct lots ON", () => {
  it("merges the airport's direct lots, priced for the searched window, beside the ResLab lots", async () => {
    reslabMock.searchLocations.mockResolvedValue([fixtureLocation(1)]);
    reslabMock.getMinPrice.mockResolvedValue(minPrice(100));
    directRows([directLotRow()]);

    const result = await search({ sort: "price_asc" });
    await flush();

    expect(db.rpc).toHaveBeenCalledWith("direct_lots_v2", { p_airport_code: AIRPORT, p_id: null });
    expect(result.total).toBe(2);
    const direct = result.results.find((l) => l.source === "direct")!;
    expect(direct).toMatchObject({ id: "direct-1", slug: "the-parking-point-jfk", airportCode: "JFK" });
    // 10 Oct 10:00 → 14 Oct 14:00 = 100 h = 5 days × $9.95 + 10.375 % tax
    expect(direct.pricing).toMatchObject({ numberOfDays: 5, subtotal: 49.75, grandTotal: 54.91 });
    // cheapest first: $54.91 direct before the $100 ResLab lot
    expect(result.results[0].id).toBe("direct-1");
    // the ResLab lot now carries the airport it was found for
    expect(result.results.find((l) => l.source === "reslab")?.airportCode).toBe(AIRPORT);
    expect(result).toMatchObject({ degraded: false, reslabUnavailable: false, directUnavailable: false, directCount: 1 });
    // results_count stays ResLab-only; direct lots have their own column
    expect(searchEventRow()).toMatchObject({ results_count: 1, direct_results_count: 1, direct_skipped: false, degraded: false });
  });

  it("answers 200 (degraded, reslabUnavailable) with the direct lots when ResLab throws", async () => {
    reslabMock.searchLocations.mockRejectedValue(new Error("ResLab 502"));
    directRows([directLotRow()]);

    const result = await search();
    await flush();

    expect(result.results.map((l) => l.id)).toEqual(["direct-1"]);
    expect(result).toMatchObject({ degraded: true, reslabUnavailable: true, total: 1 });
    expect(result.message).toBeUndefined();
    // the capture the route would have made is kept
    expect(sentry.captureAPIError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "ResLab 502" }),
      expect.objectContaining({ stage: "reslab_unavailable_direct_served" }),
    );
    expect(searchEventRow()).toMatchObject({ results_count: 0, direct_results_count: 1, degraded: true });
  });

  it("rethrows the ResLab failure when the airport has no direct lots (identical to flag off)", async () => {
    reslabMock.searchLocations.mockRejectedValue(new Error("ResLab 502"));
    directRows([]);
    await expect(search()).rejects.toThrow("ResLab 502");
  });

  it("a direct-only airport is a result, not 'No parking locations found'", async () => {
    reslabMock.searchLocations.mockResolvedValue([]);
    directRows([directLotRow()]);

    const result = await search();

    expect(result.total).toBe(1);
    expect(result.locationsConsidered).toBe(1);
    expect(result.message).toBeUndefined();
    expect(reslabMock.getMinPrice).not.toHaveBeenCalled();
  });

  it("once direct booking is open, suppresses the ResLab twin before pricing — no getMinPrice for the suppressed id", async () => {
    flagState.bookingOpen = true;
    reslabMock.searchLocations.mockResolvedValue([fixtureLocation(1), fixtureLocation(2)]);
    reslabMock.getMinPrice.mockResolvedValue(minPrice());
    directRows([directLotRow({ reslab_location_id: 1 })]);

    const result = await search();

    expect(result.results.map((l) => l.id).sort()).toEqual(["direct-1", "reslab-2"]);
    // The suppressed twin is not counted twice: reslab-2 + direct-1.
    expect(result.locationsConsidered).toBe(2);
    expect(reslabMock.getMinPrice).toHaveBeenCalledTimes(1);
    expect(reslabMock.getMinPrice).toHaveBeenCalledWith(2, expect.anything());
  });

  it("until direct booking is open, a direct lot with a declared twin is hidden and its ResLab listing sells as today (review M3) — no duplicate card", async () => {
    reslabMock.searchLocations.mockResolvedValue([fixtureLocation(1), fixtureLocation(2)]);
    reslabMock.getMinPrice.mockResolvedValue(minPrice());
    directRows([directLotRow({ reslab_location_id: 1 }), directLotRow({ id: 2, slug: "untwinned" })]);

    const result = await search();

    expect(result.results.map((l) => l.id).sort()).toEqual(["direct-2", "reslab-1", "reslab-2"]);
    expect(reslabMock.getMinPrice).toHaveBeenCalledTimes(2);
  });

  it("flags reslabUnavailable when ResLab listed lots but priced NONE of them (TRIPLY-13) — the ISR pages must not bake a direct-only page (review H1)", async () => {
    reslabMock.searchLocations.mockResolvedValue([fixtureLocation(1), fixtureLocation(2)]);
    reslabMock.getMinPrice.mockRejectedValue(new Error("pricing 502"));
    directRows([directLotRow()]);

    const result = await search();

    expect(result.results.map((l) => l.id)).toEqual(["direct-1"]);
    expect(result).toMatchObject({ degraded: true, reslabUnavailable: true, listIncomplete: false });
  });

  it("a direct lot whose window does not price cannot mask a ResLab outage as 'no parking' (review L1)", async () => {
    reslabMock.searchLocations.mockRejectedValue(new Error("ResLab 502"));
    directRows([directLotRow()]);

    // Same-day search with reversed TIMES passes the date checks but prices to 0 days.
    await expect(
      search({ checkin: "2026-10-10", checkout: "2026-10-10", checkinTime: "3:00 PM", checkoutTime: "10:00 AM" }),
    ).rejects.toThrow("ResLab 502");
    expect(sentry.captureAPIError).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ stage: "reslab_unavailable_direct_served" }),
    );
  });

  it("a failed direct read skips the branch: ResLab lots intact, directUnavailable, NOT degraded, direct_skipped logged", async () => {
    reslabMock.searchLocations.mockResolvedValue([fixtureLocation(1)]);
    reslabMock.getMinPrice.mockResolvedValue(minPrice());
    directRows(null, { code: "42501", message: "permission denied for function direct_lots" });

    const result = await search();
    await flush();

    expect(result.results.map((l) => l.id)).toEqual(["reslab-1"]);
    expect(result).toMatchObject({ degraded: false, directUnavailable: true, directCount: 0, reslabUnavailable: false });
    expect(searchEventRow()).toMatchObject({ direct_results_count: 0, direct_skipped: true, degraded: false });
    // reported once by the store (throttled), tagged as the direct read
    expect(sentry.captureAPIError).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ stage: "direct_lots_read" }));
  });

  it("a staging_only lot never appears in a production result", async () => {
    process.env.NEXT_PUBLIC_APP_ENV = "production";
    reslabMock.searchLocations.mockResolvedValue([fixtureLocation(1)]);
    reslabMock.getMinPrice.mockResolvedValue(minPrice());
    directRows([directLotRow({ visibility: "staging_only" }), directLotRow({ id: 2, slug: "prod-lot", visibility: "production" })]);

    const result = await search();

    expect(result.results.map((l) => l.id).sort()).toEqual(["direct-2", "reslab-1"]);
    expect(result.directCount).toBe(1);
  });

  it("does not 502 when every ResLab lot failed to price but a direct lot can be shown", async () => {
    reslabMock.searchLocations.mockResolvedValue([fixtureLocation(1)]);
    reslabMock.getMinPrice.mockRejectedValue(new Error("pricing 502"));
    directRows([directLotRow()]);

    const result = await search();

    expect(result.results.map((l) => l.id)).toEqual(["direct-1"]);
    expect(result.degraded).toBe(true);
  });

  it("still 502s on an all-pricing failure when there is nothing direct to show", async () => {
    reslabMock.searchLocations.mockResolvedValue([fixtureLocation(1)]);
    reslabMock.getMinPrice.mockRejectedValue(new Error("pricing 502"));
    directRows([]);
    await expect(search()).rejects.toThrow(/pricing unavailable for all/);
  });
});
