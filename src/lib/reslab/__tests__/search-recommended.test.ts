/**
 * searchParking end to end on the GEO path (a real airport, lots from the
 * channel list sweep) — own-airport results, the Recommended order and badges.
 * Every other search suite uses TEST-NY's single mapped location, which the
 * own-airport rule deliberately skips.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return { ...actual, after: (fn: () => unknown) => { void fn(); } };
});

const reslabMock = vi.hoisted(() => ({ getAllLocations: vi.fn(), getMinPrice: vi.fn(), searchLocations: vi.fn() }));
vi.mock("@/lib/reslab/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/reslab/client")>("@/lib/reslab/client");
  return { ...actual, reslab: reslabMock };
});

const sentry = vi.hoisted(() => ({ captureAPIError: vi.fn() }));
vi.mock("@/lib/sentry", () => ({ captureAPIError: sentry.captureAPIError }));

const popularity = vi.hoisted(() => ({
  getLotBookingCounts: vi.fn(),
}));
vi.mock("@/lib/search/booking-popularity", () => ({
  getLotBookingCounts: popularity.getLotBookingCounts,
  isRecommendedRankingEnabled: () => process.env.SEARCH_RECOMMENDED_RANKING !== "off",
}));

const db = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createAdminClient: vi.fn(async () => db) }));

import { searchParking, __resetLocationListCacheForTests } from "../search";
import { __resetAvailabilityLogWarnStateForTests } from "@/lib/availability/log";
import { __resetSearchEventsLogWarnStateForTests } from "@/lib/search-events/log";

// Real coordinates (production ResLab list, 2026-10-08); prices ≈ a 7-day stay.
const LOTS: Record<number, { lat: string; lng: string; total: number }> = {
  275: { lat: "40.6637560", lng: "-73.8152580", total: 76.65 }, // PARK AC (JFK)
  561: { lat: "40.6659081", lng: "-73.7855037", total: 139.65 }, // A1 JFK Park
  428: { lat: "40.6636", lng: "-73.7900", total: 209.65 }, // Safe Park JFK
  159: { lat: "40.7589732", lng: "-73.8323536", total: 76.0 }, // Hyatt Place Flushing (LGA)
  112: { lat: "40.7609223", lng: "-73.8300252", total: 69.65 }, // Queens Crossing (LGA)
  388: { lat: "40.7680051", lng: "-73.8752667", total: 85.0 }, // Carvia (LGA) — within 1.25x the median
};

function location(id: number) {
  return {
    id, name: `Lot ${id}`, phone: "", address: "", city: "Queens", zip_code: "11430",
    latitude: LOTS[id].lat, longitude: LOTS[id].lng, number_of_parkings: 1, description: null, directions: null,
    shuttle_info_summary: null, shuttle_info_details: null, special_conditions: null, front_desk_hours: null,
    minimum_booking_days: 1, hours_before_reservation: 0, tax_value: 0, tax_type: "net", daily_or_hourly: "daily",
    parking_due_at_location: false, currency_id: 1, country_id: 1, state_id: 1, printed_receipt: false,
    shuttle_available: false, parking_commission: 0, parking_commission_type: "flat", port_type: "airport",
    photos: [], amenities: [], extra_fields: [], cancellation_policies: [], facility_custom_amenities: [], parking_custom_amenities: [],
  };
}
function minPrice(total: number, soldOut = false) {
  return {
    rates: [],
    reservation: {
      fees: [], due_at_location: 0, tax_total: 0, long_term_discount: 0, location_commission: 0,
      available_spots: soldOut ? 0 : 50, discount: 0, parking_sold_out: soldOut, fees_total: 0,
      totals: { parking: { number_of_days: 7, sub_total: total } },
      sold_out: soldOut, sub_total: total, grand_total: total,
    },
  };
}

const ids = Object.keys(LOTS).map(Number);
const inserted: Array<{ table: string; row: Record<string, unknown> }> = [];
const searchEventRow = () => inserted.find((i) => i.table === "search_events")?.row;
const search = (airport: string, sort?: "popularity" | "price_asc") =>
  searchParking({ airport, checkin: "2026-10-10", checkout: "2026-10-17", source: "search", ...(sort ? { sort } : {}) });
const order = (r: Awaited<ReturnType<typeof search>>) => r.results.map((l) => l.reslabLocationId);
const badgesOf = (r: Awaited<ReturnType<typeof search>>, id: number) =>
  r.results.find((l) => l.reslabLocationId === id)?.badges ?? [];

beforeEach(() => {
  reslabMock.getAllLocations.mockReset();
  reslabMock.getAllLocations.mockResolvedValue({
    data: ids.map(location), last_page: 1, current_page: 1, per_page: 100, total: ids.length,
  });
  reslabMock.getMinPrice.mockReset();
  reslabMock.getMinPrice.mockImplementation(async (id: number) => minPrice(LOTS[id].total));
  popularity.getLotBookingCounts.mockReset();
  popularity.getLotBookingCounts.mockResolvedValue({ ok: true, counts: new Map([[275, 11], [561, 3], [388, 4]]) });
  db.from.mockReset();
  inserted.length = 0;
  db.from.mockImplementation((table: string) => ({
    insert: (row: Record<string, unknown>) => {
      inserted.push({ table, row });
      return { abortSignal: () => Promise.resolve({ error: null }) };
    },
  }));
  __resetLocationListCacheForTests();
  __resetAvailabilityLogWarnStateForTests();
  __resetSearchEventsLogWarnStateForTests();
  sentry.captureAPIError.mockClear();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  delete process.env.ENABLE_DIRECT_LOTS;
  delete process.env.SEARCH_OWN_AIRPORT_FILTER;
  delete process.env.SEARCH_RECOMMENDED_RANKING;
  delete process.env.VERCEL_ENV;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-01T15:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("searchParking — own-airport results", () => {
  it("JFK lists only JFK lots: the Flushing lots LGA is closer to are gone", async () => {
    const r = await search("JFK");
    expect(order(r)).toEqual([275, 561, 428]);
  });

  it("LGA lists only LGA lots: no JFK lots", async () => {
    const r = await search("LGA");
    expect(new Set(order(r))).toEqual(new Set([112, 159, 388]));
  });

  it("if the airport's own lots are all sold out, the full list is shown as before (no lost sale) — flagged, and no other airport's lot is badged 'Most booked'", async () => {
    reslabMock.getMinPrice.mockImplementation(async (id: number) =>
      minPrice(LOTS[id].total, [112, 159, 388].includes(id))
    );
    const r = await search("LGA");
    expect(new Set(order(r))).toEqual(new Set([275, 561, 428]));
    expect(r.ownAirportFallback).toBe(true);
    expect(r.results.some((l) => l.badges?.includes("most_booked"))).toBe(false);
  });

  it("the fallback writes one structured log line per airport (not a Sentry event)", async () => {
    vi.mocked(console.warn).mockClear();
    reslabMock.getMinPrice.mockImplementation(async (id: number) =>
      minPrice(LOTS[id].total, [112, 159, 388].includes(id))
    );
    await search("LGA");
    await search("LGA");
    const lines = vi.mocked(console.warn).mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.includes("own_airport_fallback"));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual({ event: "own_airport_fallback", airport: "LGA", ownLots: 3, ownSoldOut: 3, ownPricingErrors: 0 });
    expect(sentry.captureAPIError).not.toHaveBeenCalled();
  });

  it("a HIDDEN other-airport lot failing to price does not cost the shown list its 'Lowest total' badge or its telemetry", async () => {
    reslabMock.getMinPrice.mockImplementation(async (id: number) => {
      if (id === 159) throw new Error("ResLab 502"); // an LGA lot, hidden at JFK
      return minPrice(LOTS[id].total);
    });
    const r = await search("JFK");
    expect(r.degraded).toBe(true); // caching stays conservative
    expect(badgesOf(r, 275)).toContain("lowest_total");
    expect(searchEventRow()?.degraded).toBe(false);
    expect(searchEventRow()?.cheapest_price_cents).toBe(7665);
  });

  it("the normal case is not flagged as a fallback", async () => {
    expect((await search("JFK")).ownAirportFallback).toBeUndefined();
  });

  it("with the filter switched off, LGA still never pins JFK's leader", async () => {
    process.env.SEARCH_OWN_AIRPORT_FILTER = "off";
    const r = await search("LGA");
    expect(order(r)).toContain(275);
    expect(badgesOf(r, 275)).not.toContain("most_booked");
    expect(order(r)[0]).toBe(388); // LGA's own leader
  });

  it("search_events describes the lots shown: results_count, cheapest and sold-out from the same set", async () => {
    reslabMock.getMinPrice.mockImplementation(async (id: number) => minPrice(LOTS[id].total, id === 112));
    await search("JFK");
    const row = searchEventRow();
    expect(row?.results_count).toBe(3);
    expect(row?.cheapest_price_cents).toBe(7665); // PARK AC, not the cheaper LGA lot
    expect(row?.sold_out_count).toBe(0); // LGA's sold-out lot is not JFK's
  });

  it("SEARCH_OWN_AIRPORT_FILTER=off restores the plain radius list", async () => {
    process.env.SEARCH_OWN_AIRPORT_FILTER = "off";
    const r = await search("JFK");
    expect(new Set(order(r))).toEqual(new Set([275, 561, 428, 159, 112]));
  });
});

describe("searchParking — Recommended order and badges", () => {
  it("JFK: PARK AC pinned first with both badges, then cheapest-first", async () => {
    const r = await search("JFK");
    expect(order(r)).toEqual([275, 561, 428]);
    expect(badgesOf(r, 275)).toEqual(["most_booked", "lowest_total"]);
    expect(badgesOf(r, 561)).toEqual([]);
    expect(r.rankingDegraded).toBeUndefined();
  });

  it("a leader from another airport's lots is not considered (LGA's leader is Carvia, not PARK AC)", async () => {
    const r = await search("LGA");
    expect(order(r)[0]).toBe(388);
    expect(badgesOf(r, 388)).toEqual(["most_booked"]);
    expect(badgesOf(r, 112)).toEqual(["lowest_total"]);
  });

  it("counts unavailable → cheapest-first, no 'Most booked', flagged rankingDegraded (short CDN TTL)", async () => {
    popularity.getLotBookingCounts.mockResolvedValue({ ok: false });
    const r = await search("JFK");
    expect(order(r)).toEqual([275, 561, 428]);
    expect(badgesOf(r, 275)).toEqual(["lowest_total"]);
    expect(r.rankingDegraded).toBe(true);
  });

  it("a lot that failed to price → the result is degraded and gets no 'Lowest total'", async () => {
    reslabMock.getMinPrice.mockImplementation(async (id: number) => {
      if (id === 428) throw new Error("ResLab 502");
      return minPrice(LOTS[id].total);
    });
    const r = await search("JFK");
    expect(r.degraded).toBe(true);
    expect(r.results.some((l) => l.badges?.includes("lowest_total"))).toBe(false);
  });

  it("the leader sold out for these dates → nobody is pinned or badged 'Most booked'", async () => {
    reslabMock.getMinPrice.mockImplementation(async (id: number) => minPrice(LOTS[id].total, id === 275));
    const r = await search("JFK");
    expect(order(r)).toEqual([561, 428]);
    expect(r.results.some((l) => l.badges?.includes("most_booked"))).toBe(false);
  });

  it("SEARCH_RECOMMENDED_RANKING=off → the old distance order and no badges", async () => {
    process.env.SEARCH_RECOMMENDED_RANKING = "off";
    const r = await search("JFK");
    expect(r.results.every((l) => !l.badges)).toBe(true);
    const distances = r.results.map((l) => l.distanceFromAirport ?? 0);
    expect(distances).toEqual([...distances].sort((a, b) => a - b));
  });

  it("the airport-page caller never reads booking counts and gets no badges", async () => {
    const r = await searchParking({ airport: "JFK", checkin: "2026-10-10", checkout: "2026-10-17", source: "airport-page", sort: "price_asc" });
    expect(popularity.getLotBookingCounts).not.toHaveBeenCalled();
    expect(r.results.every((l) => !l.badges)).toBe(true);
  });

  it("a Vercel preview never reads production booking counts (staging ResLab ids differ)", async () => {
    process.env.VERCEL_ENV = "preview";
    const r = await search("JFK");
    expect(popularity.getLotBookingCounts).not.toHaveBeenCalled();
    expect(r.results.some((l) => l.badges?.includes("most_booked"))).toBe(false);
    expect(r.rankingDegraded).toBeUndefined();
  });

  it("price sort: badges still shown, the booking leader is not forced first", async () => {
    popularity.getLotBookingCounts.mockResolvedValue({ ok: true, counts: new Map([[561, 9]]) });
    const r = await search("JFK", "price_asc");
    expect(order(r)).toEqual([275, 561, 428]);
    expect(badgesOf(r, 561)).toEqual(["most_booked"]);
    expect(badgesOf(r, 275)).toEqual(["lowest_total"]);
  });

  it("counts unavailable on a price sort → still flagged rankingDegraded (the badge is missing)", async () => {
    popularity.getLotBookingCounts.mockResolvedValue({ ok: false });
    expect((await search("JFK", "price_asc")).rankingDegraded).toBe(true);
  });
});
