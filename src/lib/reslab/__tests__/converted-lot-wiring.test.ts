/**
 * Search results and the lot page for a lot ResLab prices in Canadian dollars,
 * with an exchange rate set: the wiring between ResLab's answer, the converter
 * and the lot the pages receive. The converter itself is tested in
 * currency.test.ts and fx/cad-usd.test.ts; these tests fail if a caller stops
 * converting, converts with one value and labels with another, or loses the
 * lot's "I am converted" marker when the lot has no price.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return { ...actual, after: (fn: () => unknown) => { void fn(); } };
});

const reslabMock = vi.hoisted(() => ({ searchLocations: vi.fn(), getMinPrice: vi.fn(), getLocation: vi.fn() }));
vi.mock("@/lib/reslab/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/reslab/client")>("@/lib/reslab/client");
  return { ...actual, reslab: reslabMock };
});
const sentry = vi.hoisted(() => ({ captureAPIError: vi.fn() }));
vi.mock("@/lib/sentry", () => ({ captureAPIError: sentry.captureAPIError }));
vi.mock("@/lib/search/booking-popularity", () => ({
  getLotBookingCounts: vi.fn(async () => ({ ok: true, counts: new Map() })),
  isRecommendedRankingEnabled: () => true,
}));
const db = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createAdminClient: vi.fn(async () => db) }));

const { cadRate } = vi.hoisted(() => ({ cadRate: { value: null as { id: string; micros: number } | null } }));
vi.mock("@/lib/fx/cad-usd", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/fx/cad-usd")>()),
  currentCadRate: () => cadRate.value,
}));

import { searchParking, __resetLocationListCacheForTests } from "../search";
import { getLotFromReslab } from "../get-lot";
import { __resetAvailabilityLogWarnStateForTests } from "@/lib/availability/log";
import { __resetSearchEventsLogWarnStateForTests } from "@/lib/search-events/log";

const RATE = { id: "r1", micros: 725_000 };
const FROM = "2026-12-02 10:00:00";
const TO = "2026-12-10 10:00:00";
/** No Canadian-dollar figure of the fixture below, in dollars or cents. */
const CAD_FIGURES = /107\.55|125\.81|12\.88|5\.38|15\.98|98\.92|10755|12581/;

function location(id: number, over: Record<string, unknown> = {}) {
  return {
    id, name: `Lot ${id}`, phone: "555-0100", address: "1 Airport Way", city: "Queens", zip_code: "11430",
    latitude: "40.6413", longitude: "-73.7781", number_of_parkings: 1, description: null, directions: null,
    shuttle_info_summary: null, shuttle_info_details: null, special_conditions: null, front_desk_hours: null,
    minimum_booking_days: 1, hours_before_reservation: 0, tax_value: 0, tax_type: "net", daily_or_hourly: "daily",
    parking_due_at_location: false, currency_id: 1, country_id: 1, state_id: 1, printed_receipt: false,
    shuttle_available: false, parking_commission: 0, parking_commission_type: "flat", port_type: "airport",
    photos: [], amenities: [], extra_fields: [], cancellation_policies: [], facility_custom_amenities: [], parking_custom_amenities: [],
    ...over,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}
const CAD_LOT = { currency: { id: 1, name: "Canadian Dollar", code: "CAD" }, country: { code: "CA" } };

/** Montreal, 8 days, as ResLab answers it: Canadian dollars. */
function cadMinPrice(over: Record<string, unknown> = {}) {
  return {
    rates: [{ id: 9, location_parking_type_id: 44, price: 15.98, from_date: FROM, to_date: TO, number_of_days: 8 }],
    reservation: {
      fees: [{ id: 1, name: "Channel fee", amount: 5, calculation: "one_time", type: "percentage", associated_to: "parking", total: 5.38 }],
      due_at_location: 0, tax_total: 12.88, long_term_discount: 0, location_commission: 98.92, available_spots: 50, discount: 0,
      parking_sold_out: false, fees_total: 5.38, totals: { parking: { number_of_days: 8, sub_total: 107.55 } },
      sold_out: false, sub_total: 107.55, grand_total: 125.81,
      ...over,
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}
function usMinPrice() {
  return {
    rates: [{ id: 1, location_parking_type_id: 7, price: 12.5, from_date: FROM, to_date: TO, number_of_days: 8 }],
    reservation: {
      fees: [], due_at_location: 0, tax_total: 5, long_term_discount: 0, location_commission: 0, available_spots: 50, discount: 0,
      parking_sold_out: false, fees_total: 0, totals: { parking: { number_of_days: 8, sub_total: 100 } },
      sold_out: false, sub_total: 100, grand_total: 105,
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

/** Rows handed to the database, by table (the search_events header row is one object). */
const inserts: { table: string; rows: unknown }[] = [];
const searchEventRow = () => inserts.find((c) => c.table === "search_events")?.rows as Record<string, unknown> | undefined;
/** The loggers hand off fire-and-forget: let them run. */
const flush = () => new Promise((r) => setTimeout(r, 0));
/** Reports by message. The text is in the Error, which JSON.stringify drops: read it. */
const reports = (pattern: RegExp) => sentry.captureAPIError.mock.calls.filter(([e]) => pattern.test(String(e)));
const UNCONVERTIBLE = /could not be converted/;
const DEGRADED = /pricing degraded/;

beforeEach(() => {
  vi.clearAllMocks();
  cadRate.value = RATE;
  inserts.length = 0;
  db.from.mockImplementation((table: string) => ({
    insert: (rows: unknown) => {
      inserts.push({ table, rows });
      return { abortSignal: () => Promise.resolve({ error: null }) };
    },
  }));
  __resetLocationListCacheForTests();
  __resetAvailabilityLogWarnStateForTests();
  __resetSearchEventsLogWarnStateForTests();
  // Pin "now" (Date only; the loggers need real timers): the fixture stay is
  // Dec 2 to Dec 10, 2026, and a lot is not priced for a date already past.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-22T15:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("searchParking with an exchange rate set", () => {
  const search = () => searchParking({ airport: "TEST-NY", checkin: "2026-12-02", checkout: "2026-12-10", source: "search" });
  const lots = () => {
    reslabMock.searchLocations.mockResolvedValue([location(1), location(558, CAD_LOT)]);
    reslabMock.getMinPrice.mockImplementation(async (id: number) => (id === 558 ? cadMinPrice() : usMinPrice()));
  };

  it("a CAD lot is priced in US dollars and says it is converted; a US lot is untouched and carries no marker", async () => {
    lots();
    const r = await search();
    const cad = r.results.find((l) => l.reslabLocationId === 558);
    const us = r.results.find((l) => l.reslabLocationId === 1);
    expect(cad?.fxRateId).toBe("r1");
    expect(cad?.pricing).toMatchObject({ currency: "$", currencyCode: "USD", grandTotal: 91.21, subtotal: 77.97, feesTotal: 3.9, taxTotal: 9.34, numberOfDays: 8 });
    // The per-day price is the converted (subtotal + fees) / days.
    expect(cad?.pricing?.minPrice).toBeCloseTo((77.97 + 3.9) / 8, 10);
    expect(cad?.dueAtLocationAmount).toBe(0);
    expect(JSON.stringify(cad)).not.toMatch(CAD_FIGURES);
    expect(us?.pricing).toMatchObject({ currency: "$", currencyCode: "USD", grandTotal: 105, subtotal: 100 });
    expect(us).not.toHaveProperty("fxRateId");
  });

  /** Lot 1 is a US lot; lot 558 answers in Canadian dollars with `cadOver` applied. */
  const withCadAnswer = (cadOver: Record<string, unknown>, others: Record<number, () => unknown> = {}) => {
    reslabMock.getMinPrice.mockImplementation(async (id: number) => {
      if (id === 558) return cadMinPrice(cadOver);
      return others[id] ? others[id]() : usMinPrice();
    });
  };
  const NOT_ADDING_UP = { grand_total: 130 };

  it("a CAD price that will not convert: the lot is left out, the search is NOT degraded, and the lot is reported in its own issue", async () => {
    reslabMock.searchLocations.mockResolvedValue([location(1), location(558, CAD_LOT)]);
    withCadAnswer(NOT_ADDING_UP);
    const r = await search();
    await flush();
    expect(r.results.map((l) => l.reslabLocationId)).toEqual([1]);
    expect(JSON.stringify(r.results)).not.toMatch(/130|107\.55/);
    expect(r.degraded).toBe(false);
    expect(reports(DEGRADED)).toHaveLength(0);
    const own = reports(UNCONVERTIBLE);
    expect(own).toHaveLength(1);
    expect(String(own[0][0])).toContain("lot 558");
    expect(String(own[0][0])).toContain("fx_parts_do_not_add_up");
    expect(own[0][1]).toMatchObject({
      endpoint: "searchParking",
      stage: "price_unconvertible",
      fingerprint: ["reslab-price-unconvertible", "558", "fx_parts_do_not_add_up"],
      extra: { airport: "TEST-NY", source: "search" },
    });
    // Reported as an error (the one alert rule ignores warnings).
    expect(own[0][1]).not.toHaveProperty("level");
    // The record of the search agrees: complete, with a real cheapest price.
    expect(searchEventRow()).toMatchObject({ degraded: false, results_count: 1, cheapest_price_cents: 10500 });
    // The lot is still an observation in the availability log: looked at, nothing known.
    const availability = inserts.find((c) => c.table === "availability_log")?.rows as Record<string, unknown>[];
    expect(availability.find((row) => row.reslab_location_id === 558)).toMatchObject({ sold_out: null, available_spots: null, grand_total_cents: null });
  });

  it("the result beside a left-out lot is complete: the 'Lowest total' badge is shown", async () => {
    reslabMock.searchLocations.mockResolvedValue([location(1), location(558, CAD_LOT)]);
    withCadAnswer(NOT_ADDING_UP);
    const r = await search();
    expect(r.results.find((l) => l.reslabLocationId === 1)?.badges).toContain("lowest_total");
  });

  it("two lots left out in one search are each reported, under their own keys", async () => {
    reslabMock.searchLocations.mockResolvedValue([location(1), location(558, CAD_LOT), location(559, CAD_LOT)]);
    reslabMock.getMinPrice.mockImplementation(async (id: number) => (id === 1 ? usMinPrice() : cadMinPrice(NOT_ADDING_UP)));
    await search();
    await search();
    expect(reports(UNCONVERTIBLE).map((c) => c[1].fingerprint[1]).sort()).toEqual(["558", "559"]);
  });

  it("a report that throws never fails the search it describes", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    reslabMock.searchLocations.mockResolvedValue([location(1), location(558, CAD_LOT)]);
    withCadAnswer(NOT_ADDING_UP);
    sentry.captureAPIError.mockImplementationOnce(() => { throw new Error("sentry down"); });
    const r = await search();
    expect(r.results.map((l) => l.reslabLocationId)).toEqual([1]);
    expect(r.degraded).toBe(false);
  });

  it.each([
    ["a discount and a missing amount", { discount: 5, tax_total: undefined }],
    ["a discount sent as text", { discount: "0" }],
    ["a discount that is not a number", { discount: Number.NaN }],
  ])("a malformed answer stays a pricing failure even when it mentions a discount: %s", async (_n, over) => {
    reslabMock.searchLocations.mockResolvedValue([location(1), location(558, CAD_LOT)]);
    withCadAnswer(over);
    const r = await search();
    expect(r.results.map((l) => l.reslabLocationId)).toEqual([1]);
    expect(r.degraded).toBe(true);
    expect(reports(UNCONVERTIBLE)).toHaveLength(0);
    expect(String(reports(DEGRADED)[0]?.[0])).toContain("fx_bad_amount");
  });

  it.each([
    ["a discount", { discount: 5 }, "fx_discount"],
    ["a pay-at-lot share", { due_at_location: 20 }, "fx_pay_at_lot"],
  ])("%s on a CAD price is also the lot's own price: left out, not degraded", async (_n, over, reason) => {
    reslabMock.searchLocations.mockResolvedValue([location(1), location(558, CAD_LOT)]);
    withCadAnswer(over);
    const r = await search();
    expect(r.results.map((l) => l.reslabLocationId)).toEqual([1]);
    expect(r.degraded).toBe(false);
    expect(reports(UNCONVERTIBLE).map((c) => c[1].fingerprint)).toEqual([["reslab-price-unconvertible", "558", reason]]);
  });

  it("a malformed CAD answer (an amount missing) is still a pricing failure: degraded, in the shared report", async () => {
    reslabMock.searchLocations.mockResolvedValue([location(1), location(558, CAD_LOT)]);
    withCadAnswer({ tax_total: undefined });
    const r = await search();
    expect(r.results.map((l) => l.reslabLocationId)).toEqual([1]);
    expect(r.degraded).toBe(true);
    expect(reports(UNCONVERTIBLE)).toHaveLength(0);
    const shared = reports(DEGRADED);
    expect(shared).toHaveLength(1);
    expect(String(shared[0][0])).toContain("1/2 TEST-NY");
    expect(String(shared[0][0])).toContain("fx_bad_amount");
  });

  it("a real failure beside an unconvertible lot: degraded, and the shared report counts only the failure", async () => {
    reslabMock.searchLocations.mockResolvedValue([location(1), location(2), location(558, CAD_LOT)]);
    withCadAnswer(NOT_ADDING_UP, { 2: () => { throw new Error("ResLab 502"); } });
    const r = await search();
    expect(r.results.map((l) => l.reslabLocationId)).toEqual([1]);
    expect(r.degraded).toBe(true);
    const shared = reports(DEGRADED);
    expect(shared).toHaveLength(1);
    expect(String(shared[0][0])).toContain("1/3 TEST-NY");
    expect(String(shared[0][0])).not.toContain("fx_");
    expect(reports(UNCONVERTIBLE)).toHaveLength(1);
  });

  it("nothing priced because the only lot will not convert: the same 502 as before, recorded as degraded", async () => {
    reslabMock.searchLocations.mockResolvedValue([location(558, CAD_LOT)]);
    withCadAnswer(NOT_ADDING_UP);
    await expect(search()).rejects.toThrow(/pricing unavailable for all 1 TEST-NY location\(s\); 1 failed \(fx_parts_do_not_add_up ×1\)/);
    await flush();
    expect(searchEventRow()).toMatchObject({ degraded: true, results_count: 0, sold_out_count: null });
    // The lot's own issue opens here too, not only the route's report of the 502.
    expect(reports(UNCONVERTIBLE)).toHaveLength(1);
  });

  it("nothing priced: the other lot is sold out and one will not convert: still the 502, still recorded as degraded", async () => {
    const soldOut = () => ({ ...usMinPrice(), reservation: { ...usMinPrice().reservation, sold_out: true, parking_sold_out: true, available_spots: 0 } });
    reslabMock.searchLocations.mockResolvedValue([location(1), location(558, CAD_LOT)]);
    withCadAnswer(NOT_ADDING_UP, { 1: soldOut });
    await expect(search()).rejects.toThrow(/pricing unavailable for all 2 TEST-NY location\(s\); 1 failed/);
    await flush();
    expect(searchEventRow()).toMatchObject({ degraded: true, results_count: 0, sold_out_count: 1 });
    expect(reports(UNCONVERTIBLE)).toHaveLength(1);
  });

  it("the lot's report is sent once per reason, not on every search; a new reason is a new report", async () => {
    reslabMock.searchLocations.mockResolvedValue([location(1), location(558, CAD_LOT)]);
    withCadAnswer(NOT_ADDING_UP);
    await search();
    await search();
    expect(reports(UNCONVERTIBLE)).toHaveLength(1);
    withCadAnswer({ discount: 5 });
    await search();
    expect(reports(UNCONVERTIBLE).map((c) => c[1].fingerprint[2])).toEqual(["fx_parts_do_not_add_up", "fx_discount"]);
    // After the quiet period the first reason is reported again.
    vi.setSystemTime(new Date("2026-11-22T15:06:00Z"));
    withCadAnswer(NOT_ADDING_UP);
    await search();
    expect(reports(UNCONVERTIBLE)).toHaveLength(3);
  });

  it("lot 242 (tax outside its total) is on the hidden list: never priced, so it cannot mark the search degraded", async () => {
    reslabMock.searchLocations.mockResolvedValue([location(1), location(242, CAD_LOT)]);
    // What ResLab answers for 242: 95.70 + 4.79 = 100.49, the 12.44 tax not in the sum.
    const taxOutside = cadMinPrice({ sub_total: 95.7, fees_total: 4.79, tax_total: 12.44, grand_total: 100.49 });
    reslabMock.getMinPrice.mockImplementation(async (id: number) => (id === 242 ? taxOutside : usMinPrice()));
    const r = await search();
    expect(reslabMock.getMinPrice.mock.calls.map((c) => c[0])).toEqual([1]);
    expect(r.results.map((l) => l.reslabLocationId)).toEqual([1]);
    expect(r.locationsConsidered).toBe(1);
    expect(r.degraded).toBe(false);
    expect(reports(DEGRADED)).toHaveLength(0);
    expect(reports(UNCONVERTIBLE)).toHaveLength(0);
  });

  it.each([
    ["no rate is set", () => { cadRate.value = null; }, CAD_LOT],
    ["the lot collects at the counter", () => {}, { ...CAD_LOT, parking_due_at_location: 1 }],
    ["a lot in Canada states no currency", () => {}, { country: { code: "CA" } }],
  ])("%s → the lot is not listed and never priced", async (_n, arrange, fields) => {
    arrange();
    reslabMock.searchLocations.mockResolvedValue([location(1), location(558, fields)]);
    reslabMock.getMinPrice.mockResolvedValue(usMinPrice());
    const r = await search();
    expect(r.locationsConsidered).toBe(1);
    expect(reslabMock.getMinPrice.mock.calls.map((c) => c[0])).toEqual([1]);
  });
});

describe("getLotFromReslab with an exchange rate set", () => {
  beforeEach(() => {
    reslabMock.getLocation.mockResolvedValue(location(330, CAD_LOT));
    reslabMock.getMinPrice.mockResolvedValue(cadMinPrice());
  });

  it("a CAD lot: US-dollar pricing, the parking type id kept (checkout cannot price without it), and the rate id on the lot", async () => {
    const lot = await getLotFromReslab(330, FROM, TO);
    expect(lot?.fxRateId).toBe("r1");
    expect(lot?.pricing).toMatchObject({ currency: "$", currencyCode: "USD", grandTotal: 91.21, subtotal: 77.97, feesTotal: 3.9, taxTotal: 9.34 });
    expect(lot?.pricing?.parkingTypes?.[0]?.id).toBe(44);
    expect(lot?.dueAtLocationAmount).toBe(0);
    expect(JSON.stringify(lot)).not.toMatch(CAD_FIGURES);
  });

  it.each([
    ["the min-price call fails", () => { reslabMock.getMinPrice.mockRejectedValue(new Error("ResLab 502")); }, undefined],
    ["the lot cannot take a booking today (no pricing window)", () => {}, () => null],
    ["the answer will not convert", () => { reslabMock.getMinPrice.mockResolvedValue(cadMinPrice({ grand_total: 130 })); }, undefined],
  ])("%s → the lot renders unpriced but STILL says it is converted (so its live quote is never raw Canadian dollars)", async (_n, arrange, windowFor) => {
    arrange();
    const lot = await getLotFromReslab(330, FROM, TO, undefined, windowFor);
    expect(lot).not.toBeNull();
    expect(lot?.pricing).toBeUndefined();
    expect(lot?.fxRateId).toBe("r1");
  });

  it("an answer that will not convert is reported once, not on every render", async () => {
    reslabMock.getLocation.mockResolvedValue(location(331, CAD_LOT));
    reslabMock.getMinPrice.mockResolvedValue(cadMinPrice({ grand_total: 130 }));
    await getLotFromReslab(331, FROM, TO);
    await getLotFromReslab(331, FROM, TO);
    await getLotFromReslab(331, FROM, TO);
    const sent = reports(UNCONVERTIBLE);
    expect(sent).toHaveLength(1);
    expect(String(sent[0][0])).toContain("fx_parts_do_not_add_up");
    // The same issue a search opens for this lot and reason.
    expect(sent[0][1].fingerprint).toEqual(["reslab-price-unconvertible", "331", "fx_parts_do_not_add_up"]);
    // A different reason on the same lot is a different issue: reported, not throttled away.
    reslabMock.getMinPrice.mockResolvedValue(cadMinPrice({ discount: 5 }));
    await getLotFromReslab(331, FROM, TO);
    expect(reports(UNCONVERTIBLE).map((c) => c[1].fingerprint[2])).toEqual(["fx_parts_do_not_add_up", "fx_discount"]);
  });

  it.each([
    ["no rate is set", () => { cadRate.value = null; }, CAD_LOT],
    ["the lot collects at the counter", () => {}, { ...CAD_LOT, parking_due_at_location: 1 }],
    ["a lot in Canada states no currency", () => {}, { country: { code: "CA" } }],
    ["a third currency", () => {}, { currency: { code: "EUR" } }],
  ])("%s → not found, and ResLab is never asked for a price", async (_n, arrange, fields) => {
    arrange();
    reslabMock.getLocation.mockResolvedValue(location(330, fields));
    expect(await getLotFromReslab(330, FROM, TO)).toBeNull();
    expect(reslabMock.getMinPrice).not.toHaveBeenCalled();
  });

  it("a US lot is exactly as before: raw figures, no marker", async () => {
    reslabMock.getLocation.mockResolvedValue(location(7, { currency: { code: "USD" }, country: { code: "US" } }));
    reslabMock.getMinPrice.mockResolvedValue(usMinPrice());
    const lot = await getLotFromReslab(7, FROM, TO);
    expect(lot?.pricing).toMatchObject({ grandTotal: 105, subtotal: 100, taxTotal: 5 });
    expect(lot).not.toHaveProperty("fxRateId");
  });
});
