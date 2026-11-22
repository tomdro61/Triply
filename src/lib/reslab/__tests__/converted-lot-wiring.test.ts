/**
 * Search results and the lot page for a lot ResLab prices in Canadian dollars,
 * with an exchange rate set: the wiring between ResLab's answer, the converter
 * and the lot the pages receive. The converter itself is tested in
 * currency.test.ts and fx/cad-usd.test.ts; these tests fail if a caller stops
 * converting, converts with one value and labels with another, or loses the
 * lot's "I am converted" marker when the lot has no price.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

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

beforeEach(() => {
  vi.clearAllMocks();
  cadRate.value = RATE;
  db.from.mockImplementation(() => ({ insert: () => ({ abortSignal: () => Promise.resolve({ error: null }) }) }));
  __resetLocationListCacheForTests();
  __resetAvailabilityLogWarnStateForTests();
  __resetSearchEventsLogWarnStateForTests();
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

  it("a CAD answer that will not convert is an unpriced lot: dropped from the results, the US lot still served, and reported", async () => {
    reslabMock.searchLocations.mockResolvedValue([location(1), location(558, CAD_LOT)]);
    reslabMock.getMinPrice.mockImplementation(async (id: number) => (id === 558 ? cadMinPrice({ grand_total: 130 }) : usMinPrice()));
    const r = await search();
    expect(r.results.map((l) => l.reslabLocationId)).toEqual([1]);
    expect(JSON.stringify(r.results)).not.toMatch(/130|107\.55/);
    expect(JSON.stringify(sentry.captureAPIError.mock.calls)).toContain("fx_parts_do_not_add_up");
    // Any lot NOT on the hidden list keeps this signal (only lot 242 is hidden by id).
    expect(r.degraded).toBe(true);
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
    // The report's text is in the Error's message, which JSON.stringify drops: read it.
    expect(sentry.captureAPIError.mock.calls.find(([e]) => /pricing degraded/.test(String(e)))).toBeUndefined();
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
    const reports = sentry.captureAPIError.mock.calls.filter((c) => String(c[0]).includes("could not be converted"));
    expect(reports).toHaveLength(1);
    expect(String(reports[0][0])).toContain("fx_parts_do_not_add_up");
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
