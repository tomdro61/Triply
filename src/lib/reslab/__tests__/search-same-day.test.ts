/**
 * Same-day search pricing (2026-10-06). The search used to price every search
 * with a fixed 10:00 AM check-in; for a same-day search after 10 AM that time
 * was past, ResLab 422'd every lot ("Please choose a date in the future"), and
 * the customer got the "try again" panel. These tests run the REAL
 * searchParking() with only the ResLab client and Supabase mocked, and assert
 * the from_date ResLab is actually asked to price.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return { ...actual, after: (fn: () => unknown) => void fn() };
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
// The Recommended ranking reads booking counts from Supabase; these suites test
// other behaviour, so the counts are stubbed (empty, ok) rather than letting the
// shared DB fake fail and the capture throttle hide it.
vi.mock("@/lib/search/booking-popularity", () => ({
  getLotBookingCounts: vi.fn(async () => ({ ok: true, counts: new Map() })),
  isRecommendedRankingEnabled: () => true,
}));

const supabaseFrom = vi.hoisted(() => vi.fn());
vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: vi.fn(async () => ({ from: supabaseFrom })),
}));

import { searchParking, SearchDateError, __resetLocationListCacheForTests } from "../search";

// TEST-NY: single mapped location (195), America/New_York.
const AIRPORT = "TEST-NY";
const TODAY = "2026-10-06";

function fixtureLocation(id: number, hoursBeforeReservation = 0, timezoneCode?: string) {
  return {
    id,
    ...(timezoneCode ? { timezone: { id: 1, name: timezoneCode, code: timezoneCode } } : {}),
    name: `Lot ${id}`,
    address: "1 Airport Way",
    city: "Queens",
    zip_code: "11430",
    latitude: "40.6413",
    longitude: "-73.7781",
    minimum_booking_days: 1,
    hours_before_reservation: hoursBeforeReservation,
    tax_value: 0,
    tax_type: "net",
    daily_or_hourly: "daily",
    parking_due_at_location: false,
    photos: [],
    amenities: [],
    extra_fields: [],
    cancellation_policies: [],
    facility_custom_amenities: [],
    parking_custom_amenities: [],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function minPrice() {
  return {
    rates: [],
    reservation: {
      fees: [],
      due_at_location: 0,
      tax_total: 0,
      available_spots: 50,
      fees_total: 0,
      totals: { parking: { number_of_days: 3, sub_total: 90 } },
      sold_out: false,
      sub_total: 90,
      grand_total: 90,
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

/** from_date of every getMinPrice call, keyed by location id. */
function fromDates(): Record<number, string> {
  return Object.fromEntries(
    reslabMock.getMinPrice.mock.calls.map(([id, item]) => [id, item.from_date])
  );
}

function setNow(iso: string) {
  vi.setSystemTime(new Date(iso));
}

beforeEach(() => {
  reslabMock.searchLocations.mockReset();
  reslabMock.getMinPrice.mockReset();
  reslabMock.getMinPrice.mockImplementation(async () => minPrice());
  supabaseFrom.mockReset();
  supabaseFrom.mockImplementation(() => ({
    insert: () => ({ abortSignal: () => Promise.resolve({ error: null }) }),
  }));
  __resetLocationListCacheForTests();
  sentry.captureAPIError.mockClear();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.useFakeTimers({ toFake: ["Date"] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("searchParking same-day pricing", () => {
  it("prices a same-day search at the earliest open slot, not a past 10:00 AM", async () => {
    setNow("2026-10-06T17:29:00Z"); // 1:29 PM in New York
    reslabMock.searchLocations.mockResolvedValue([fixtureLocation(1)]);

    const result = await searchParking({ airport: AIRPORT, checkin: TODAY, checkout: "2026-10-09" });

    expect(reslabMock.getMinPrice).toHaveBeenCalledWith(1, expect.objectContaining({
      from_date: "2026-10-06 14:00:00",
      to_date: "2026-10-09 14:00:00",
    }));
    expect(result.total).toBe(1);
    expect(result.degraded).toBe(false);
    expect(result.checkinTime).toBe("2:00 PM");
  });

  it("keeps 10:00 AM for a future check-in date", async () => {
    setNow("2026-10-06T17:29:00Z");
    reslabMock.searchLocations.mockResolvedValue([fixtureLocation(1)]);

    await searchParking({ airport: AIRPORT, checkin: "2026-10-07", checkout: "2026-10-09" });

    expect(fromDates()[1]).toBe("2026-10-07 10:00:00");
  });

  it("passes times the caller supplied through untouched", async () => {
    setNow("2026-10-06T17:29:00Z");
    reslabMock.searchLocations.mockResolvedValue([fixtureLocation(1, 6)]);

    await searchParking({
      airport: AIRPORT,
      checkin: TODAY,
      checkout: "2026-10-09",
      checkinTime: "9:00 PM",
      checkoutTime: "9:00 AM",
    });

    // 9 PM clears the lot's 6 h notice (earliest 7:30 PM), so it's used as given.
    expect(reslabMock.getMinPrice).toHaveBeenCalledWith(1, expect.objectContaining({
      from_date: "2026-10-06 21:00:00",
      to_date: "2026-10-09 09:00:00",
    }));
  });

  it("honours each lot's notice period and skips lots closed for today without counting a failure", async () => {
    setNow("2026-10-06T17:29:00Z"); // 1:29 PM
    reslabMock.searchLocations.mockResolvedValue([
      fixtureLocation(1, 0), // 30 min → 2:00 PM
      fixtureLocation(2, 3), // 3 h → 4:30 PM
      fixtureLocation(3, 12), // 12 h → past midnight: closed today
    ]);

    const result = await searchParking({ airport: AIRPORT, checkin: TODAY, checkout: "2026-10-09" });

    expect(fromDates()).toEqual({ 1: "2026-10-06 14:00:00", 2: "2026-10-06 16:30:00" });
    expect(result.total).toBe(2);
    expect(result.degraded).toBe(false);
    expect(sentry.captureAPIError).not.toHaveBeenCalled();
  });

  it("answers an empty, non-degraded result with a message when every lot is closed for today", async () => {
    setNow("2026-10-06T17:29:00Z");
    reslabMock.searchLocations.mockResolvedValue([fixtureLocation(3, 12)]);

    const result = await searchParking({ airport: AIRPORT, checkin: TODAY, checkout: "2026-10-09" });

    expect(reslabMock.getMinPrice).not.toHaveBeenCalled();
    expect(result.total).toBe(0);
    expect(result.degraded).toBe(false);
    expect(result.message).toMatch(/rest of today/);
    expect(sentry.captureAPIError).not.toHaveBeenCalled();
  });

  it("a closed-today lot never hides a real pricing failure next to it", async () => {
    setNow("2026-10-06T17:29:00Z");
    reslabMock.getMinPrice.mockImplementation(async (id: number) => {
      if (id === 2) throw new Error("ResLab 502");
      return minPrice();
    });

    // (a) one priced, one failing, one closed → partial, degraded, reported.
    reslabMock.searchLocations.mockResolvedValue([
      fixtureLocation(1),
      fixtureLocation(2),
      fixtureLocation(3, 12),
    ]);
    const partial = await searchParking({ airport: AIRPORT, checkin: TODAY, checkout: "2026-10-09" });
    expect(partial.total).toBe(1);
    expect(partial.degraded).toBe(true);
    expect(partial.message).toBeUndefined();
    expect(sentry.captureAPIError).toHaveBeenCalledTimes(1);

    // (b) one failing, one closed → still the outage throw, not a quiet
    // "nothing open for the rest of today" 200.
    __resetLocationListCacheForTests();
    reslabMock.searchLocations.mockResolvedValue([fixtureLocation(2), fixtureLocation(3, 12)]);
    await expect(
      searchParking({ airport: AIRPORT, checkin: TODAY, checkout: "2026-10-09" })
    ).rejects.toMatchObject({ statusCode: 502 });
  });

  it("judges a same-day lot in the lot's own timezone, falling back to the airport's when invalid", async () => {
    setNow("2026-10-06T17:29:00Z"); // 1:29 PM New York = 12:29 PM Chicago = 2:29 AM Oct 7 Tokyo
    reslabMock.searchLocations.mockResolvedValue([
      fixtureLocation(1, 0, "America/Chicago"),
      fixtureLocation(2, 3, "Not/AZone"),
      fixtureLocation(3, 0, "Asia/Tokyo"),
    ]);

    const result = await searchParking({ airport: AIRPORT, checkin: TODAY, checkout: "2026-10-09" });

    expect(fromDates()).toEqual({
      1: "2026-10-06 13:00:00", // 12:29 CT + 30 min → 1:00 PM
      2: "2026-10-06 16:30:00", // invalid zone → airport (NY) + 3 h notice
      // 3: Oct 6 is already past in Tokyo → skipped, no ResLab call
    });
    expect(result.total).toBe(2);
    expect(result.degraded).toBe(false);
  });

  it("puts a same-date return after each lot's own check-in", async () => {
    setNow("2026-10-06T17:29:00Z");
    reslabMock.searchLocations.mockResolvedValue([fixtureLocation(1, 0), fixtureLocation(2, 3)]);

    await searchParking({ airport: AIRPORT, checkin: TODAY, checkout: TODAY });

    const calls = Object.fromEntries(
      reslabMock.getMinPrice.mock.calls.map(([id, item]) => [id, [item.from_date, item.to_date]])
    );
    expect(calls).toEqual({
      1: ["2026-10-06 14:00:00", "2026-10-06 15:00:00"],
      2: ["2026-10-06 16:30:00", "2026-10-06 17:30:00"],
    });
  });

  it("prices from the earliest open slot when a supplied same-day time has already passed", async () => {
    setNow("2026-10-06T17:29:00Z"); // 1:29 PM — chat relayed "9:00 AM"
    reslabMock.searchLocations.mockResolvedValue([fixtureLocation(1)]);

    const result = await searchParking({
      airport: AIRPORT,
      checkin: TODAY,
      checkout: "2026-10-09",
      checkinTime: "9:00 AM",
    });

    expect(fromDates()[1]).toBe("2026-10-06 14:00:00");
    expect(result.total).toBe(1);
    expect(sentry.captureAPIError).not.toHaveBeenCalled();
  });

  it("flags closedForToday when every lot is closed for the rest of today", async () => {
    setNow("2026-10-06T17:29:00Z");
    reslabMock.searchLocations.mockResolvedValue([fixtureLocation(3, 12)]);

    const result = await searchParking({ airport: AIRPORT, checkin: TODAY, checkout: "2026-10-09" });

    expect(result.closedForToday).toBe(true);
  });

  it("still records 'parking tonight' demand in search_events when no slot is left today", async () => {
    setNow("2026-10-07T03:20:00Z"); // 11:20 PM Oct 6 in New York
    const tables: string[] = [];
    supabaseFrom.mockImplementation((table: string) => {
      tables.push(table);
      return { insert: () => ({ abortSignal: () => Promise.resolve({ error: null }) }) };
    });
    reslabMock.searchLocations.mockResolvedValue([fixtureLocation(1)]);

    await expect(
      searchParking({ airport: AIRPORT, checkin: TODAY, checkout: "2026-10-09" })
    ).rejects.toBeInstanceOf(SearchDateError);
    await new Promise((r) => setTimeout(r, 0));

    expect(tables).toContain("search_events");
  });

  it("throws SearchDateError(same_day_too_late) when no slot is left today", async () => {
    setNow("2026-10-07T03:20:00Z"); // 11:20 PM Oct 6 in New York
    reslabMock.searchLocations.mockResolvedValue([fixtureLocation(1)]);

    const err = await searchParking({ airport: AIRPORT, checkin: TODAY, checkout: "2026-10-09" }).catch((e) => e);

    expect(err).toBeInstanceOf(SearchDateError);
    expect(err.code).toBe("same_day_too_late");
    expect(reslabMock.getMinPrice).not.toHaveBeenCalled();
  });

  it("throws SearchDateError(checkin_in_past) for a check-in already past at the airport", async () => {
    // 2:00 AM UTC Oct 7 is 10 PM Oct 6 in New York: Oct 5 is past either way.
    setNow("2026-10-07T02:00:00Z");
    reslabMock.searchLocations.mockResolvedValue([fixtureLocation(1)]);

    const err = await searchParking({ airport: AIRPORT, checkin: "2026-10-05", checkout: "2026-10-09" }).catch((e) => e);

    expect(err).toBeInstanceOf(SearchDateError);
    expect(err.code).toBe("checkin_in_past");
  });
});
