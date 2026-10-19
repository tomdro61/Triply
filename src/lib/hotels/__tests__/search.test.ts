import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── externals: ResLab, the no-sweep list, the fingerprint, Sentry, LiteAPI env, telemetry spies ──
const getLocation = vi.fn();
const getMinPrice = vi.fn();
const getChannelLocationsNoSweep = vi.fn();
const getChannelLocationsCached = vi.fn();
const searchParking = vi.fn();
const fingerprint = vi.fn();
const captureAPIError = vi.fn();
const logAvailability = vi.fn();
const logSearchEvent = vi.fn();

vi.mock("@/lib/sentry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sentry")>();
  return { ...actual, captureAPIError: (...a: unknown[]) => captureAPIError(...a) };
});
vi.mock("@/lib/reslab/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/reslab/client")>();
  return {
    ...actual,
    reslab: { ...actual.reslab, getLocation: (...a: unknown[]) => getLocation(...a), getMinPrice: (...a: unknown[]) => getMinPrice(...a) },
  };
});
vi.mock("@/lib/reslab/search", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/reslab/search")>();
  return {
    ...actual,
    getChannelLocationsNoSweep: () => getChannelLocationsNoSweep(),
    getChannelLocationsCached: () => getChannelLocationsCached(),
    searchParking: (...a: unknown[]) => searchParking(...a),
  };
});
vi.mock("@/lib/reslab/location-snapshot", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/reslab/location-snapshot")>();
  return { ...actual, keyFingerprint: () => fingerprint() };
});
vi.mock("@/lib/availability/log", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/availability/log")>();
  return { ...actual, logAvailability: (...a: unknown[]) => logAvailability(...a) };
});
vi.mock("@/lib/search-events/log", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/search-events/log")>();
  return { ...actual, logSearchEvent: (...a: unknown[]) => logSearchEvent(...a) };
});
vi.mock("@/lib/hotels/liteapi/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/hotels/liteapi/env")>();
  return { ...actual, resolveHotelEnv: () => ({ mode: "sandbox", apiKey: "k", dataBaseUrl: "https://data.test", bookBaseUrl: "https://book.test" }) };
});

import { ReslabError } from "@/lib/reslab/client";
import { takeLiteApiCall, type BudgetTicket } from "../liteapi/budget";
import { LiteApiError } from "../liteapi/client";
import { HOTEL_LOTS, enabledHotelLotsFor, type HotelLotEntry } from "../hotel-lots";
import { __resetHotelLotResolveForTests } from "../hotel-lot-resolve";
import { validateParkStayWindow, type ParkStayWindow } from "../parking-window";
import { ParkStayUnavailableError, quoteParkStayHotel, searchParkStay, type ParkStayRunInput } from "../search";
import { PROD_FINGERPRINT, content, hotelRates, locationFor, minPrice, rate } from "./fixtures";
import type { LiteApiHotelContentWire, LiteApiHotelRates } from "../liteapi/rates";

const NY = "America/New_York";
const NOW = new Date("2026-10-20T16:00:00Z"); // Oct 20 noon in New York
const doubletree = HOTEL_LOTS.find((e) => e.key === "doubletree-jfk")!;
const hampton = HOTEL_LOTS.find((e) => e.key === "hampton-inn-jfk")!;
const JFK_ENTRIES = enabledHotelLotsFor("JFK");

function windowOf(over: Partial<{ night: string; arrivalTime: string; returnDate: string; returnTime: string }> = {}): ParkStayWindow {
  const r = validateParkStayWindow({
    night: over.night ?? "2026-11-10",
    arrivalTime: over.arrivalTime ?? "7:00 PM",
    returnDate: over.returnDate ?? "2026-11-14",
    returnTime: over.returnTime ?? "6:00 PM",
    airportTimeZone: NY,
    now: NOW,
  });
  if (!r.ok) throw new Error(r.error.code);
  return r.window;
}

async function ticket(): Promise<BudgetTicket> {
  return takeLiteApiCall("sandbox", "/hotels/rates", async () => ({ data: [{ allowed: true, calls: 1, denied: 0 }], error: null }));
}

async function input(w: ParkStayWindow = windowOf()): Promise<ParkStayRunInput> {
  return { airport: { code: "JFK", timezone: NY }, window: w, adults: 2, ticket: await ticket(), now: NOW, caller: "/api/park-stay/search" };
}

// ── LiteAPI over fetch ──
const fetchMock = vi.fn();
let liteResponse: { status: number; body: { data: LiteApiHotelRates[]; hotels?: LiteApiHotelContentWire[]; sandbox: boolean } };

function defaultLite() {
  liteResponse = {
    status: 200,
    body: {
      sandbox: true,
      data: [
        hotelRates("lp27fe6", [rate({ rateId: "dt-nrfn", net: 200, ssp: 230 }), rate({ rateId: "dt-rfn", net: 210, ssp: 250, refundable: true })]),
        hotelRates("lp3034d", [rate({ rateId: "hi-nrfn", net: 150, ssp: 170, atHotel: [{ amount: 10, currency: "USD" }] })]),
      ],
      hotels: [content(doubletree), content(hampton)],
    },
  };
}

const LOTS: Record<number, HotelLotEntry> = { 132: doubletree, 304: hampton };

beforeEach(() => {
  __resetHotelLotResolveForTests();
  for (const m of [getLocation, getMinPrice, getChannelLocationsNoSweep, getChannelLocationsCached, searchParking, fingerprint, captureAPIError, logAvailability, logSearchEvent, fetchMock]) m.mockReset();
  fingerprint.mockReturnValue(PROD_FINGERPRINT);
  getChannelLocationsNoSweep.mockResolvedValue(null);
  getLocation.mockImplementation(async (id: number) => {
    const entry = LOTS[id];
    if (!entry) throw new ReslabError(404, "not found");
    return locationFor(entry, id === 304 ? { minimum_booking_days: 2, parking_commission: 80 } : {});
  });
  getMinPrice.mockImplementation(async (id: number) =>
    id === 132 ? minPrice({ grand: 120, sub: 110, tax: 10, lc: 93.5 }) : minPrice({ grand: 90, sub: 80, tax: 10, lc: 64 })
  );
  defaultLite();
  fetchMock.mockImplementation(async () => new Response(JSON.stringify(liteResponse.body), { status: liteResponse.status }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function liteBody(): { hotelIds: string[]; includeHotelData: boolean; margin: number; checkin: string; checkout: string; occupancies: { adults: number }[] } {
  const init = fetchMock.mock.calls[0][1] as RequestInit;
  return JSON.parse(String(init.body));
}

describe("searchParkStay — each hotel with its own lot (M1, M3)", () => {
  it("prices each hotel with ITS OWN lot's quote, leads with the cheapest refundable, sorts by headline", async () => {
    const i = await input();
    const out = await searchParkStay(JFK_ENTRIES, i, () => {});
    expect(out.kind).toBe("results");
    if (out.kind !== "results") return;
    expect(out.cards.map((c) => c.hotelKey)).toEqual(["hampton-inn-jfk", "doubletree-jfk"]);
    const [hi, dt] = out.cards;
    // Hampton: parking $90 + fee $5.95 + room at SSP $170 + $10 at the hotel.
    expect(hi.room.price).toMatchObject({ parkingOnlineCents: 9_000, serviceFeeCents: 595, roomSellCents: 17_000, propertyFeesDueAtHotelCents: 1_000, headlineTotalCents: 27_595 });
    expect(hi.lot.reslabLotId).toBe(304);
    // DoubleTree: the refundable rate leads although a non-refundable one is cheaper (D5).
    expect(dt.room.offerRef.rateId).toBe("dt-rfn");
    expect(dt.room.price).toMatchObject({ parkingOnlineCents: 12_000, serviceFeeCents: 660, roomSellCents: 25_000, headlineTotalCents: 37_660 });
    expect(dt.room.priceBasis).toBe("ssp");
    expect(dt.lot.reslabLotId).toBe(132);
    expect(dt.room.offerRef).toEqual({
      hotelKey: "doubletree-jfk",
      roomKey: "rt-lp27fe6|RO|RFN",
      offerId: "offer-lp27fe6",
      rateId: "dt-rfn",
      parking: { reslabLotId: 132, from: "2026-11-10 19:00:00", to: "2026-11-14 18:00:00" },
      parts: { roomSell: 25_000, parking: 12_000, serviceFee: 660, atHotel: 0 },
    });
    expect(out.partial).toBe(false);
    expect(out.sandbox).toBe(true);
    expect(i.ticket.spent).toBe(true);
  });

  it("asks ResLab only for the mapped lots, with the customer's own window, and LiteAPI once for the mapped hotels", async () => {
    await searchParkStay(JFK_ENTRIES, await input(), () => {});
    expect(getMinPrice.mock.calls.map((c) => c[0]).sort()).toEqual([132, 304]);
    for (const c of getMinPrice.mock.calls) expect(c[1]).toMatchObject({ from_date: "2026-11-10 19:00:00", to_date: "2026-11-14 18:00:00" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://data.test/hotels/rates");
    expect(liteBody()).toMatchObject({ hotelIds: ["lp27fe6", "lp3034d"], includeHotelData: true, margin: 0, checkin: "2026-11-10", checkout: "2026-11-11", occupancies: [{ adults: 2 }] });
  });

  it("writes no parking telemetry and never touches searchParking or the sweep (runtime spy)", async () => {
    await searchParkStay(JFK_ENTRIES, await input(), () => {});
    expect(logAvailability).toHaveBeenCalledTimes(0);
    expect(logSearchEvent).toHaveBeenCalledTimes(0);
    expect(searchParking).not.toHaveBeenCalled();
    expect(getChannelLocationsCached).not.toHaveBeenCalled();
  });

  it("uses the no-sweep list when warm — no getLocation calls", async () => {
    getChannelLocationsNoSweep.mockResolvedValue([locationFor(doubletree), locationFor(hampton, { minimum_booking_days: 2, parking_commission: 80 })]);
    const out = await searchParkStay(JFK_ENTRIES, await input(), () => {});
    expect(getLocation).not.toHaveBeenCalled();
    expect(out.kind === "results" && out.cards).toHaveLength(2);
  });

  it("minimum stay hides Hampton JFK on a one-day trip — not a 503, and no quote is asked for it", async () => {
    const out = await searchParkStay(JFK_ENTRIES, await input(windowOf({ returnDate: "2026-11-11", returnTime: "6:00 PM" })), () => {});
    expect(out.kind === "results" && out.cards.map((c) => c.hotelKey)).toEqual(["doubletree-jfk"]);
    expect(out.kind === "results" && out.hidden.min_stay).toBe(1);
    expect(getMinPrice.mock.calls.map((c) => c[0])).toEqual([132]);
    expect(liteBody().hotelIds).toEqual(["lp27fe6"]);
  });

  it("when every hotel misses the notice period, answers notice_period with no supplier calls", async () => {
    const tonight = windowOf({ night: "2026-10-20", arrivalTime: "12:00 PM", returnDate: "2026-10-23" });
    const out = await searchParkStay(JFK_ENTRIES, await input(tonight), () => {});
    expect(out).toEqual({ kind: "notice_period" });
    expect(getMinPrice).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("some lots transient → partial; every lot transient → unavailable (503)", async () => {
    getMinPrice.mockImplementation(async (id: number) => {
      if (id === 304) throw new ReslabError(502, "bad gateway");
      return minPrice({ grand: 120, sub: 110, tax: 10, lc: 93.5 });
    });
    const out = await searchParkStay(JFK_ENTRIES, await input(), () => {});
    expect(out.kind === "results" && out.partial).toBe(true);
    expect(out.kind === "results" && out.cards.map((c) => c.hotelKey)).toEqual(["doubletree-jfk"]);

    __resetHotelLotResolveForTests();
    getMinPrice.mockRejectedValue(new ReslabError(503, "down"));
    await expect(searchParkStay(JFK_ENTRIES, await input(), () => {})).rejects.toMatchObject({ reason: "all_parking_transient" });
  });

  it("a LiteAPI failure propagates (the route answers 503)", async () => {
    liteResponse = { status: 500, body: { data: [], sandbox: true } };
    await expect(searchParkStay(JFK_ENTRIES, await input(), () => {})).rejects.toBeInstanceOf(LiteApiError);
  });

  it("an unknown ResLab account fails closed before any ResLab call", async () => {
    fingerprint.mockReturnValue("ffffffffffffffff");
    await expect(searchParkStay(JFK_ENTRIES, await input(), () => {})).rejects.toBeInstanceOf(ParkStayUnavailableError);
    expect(getLocation).not.toHaveBeenCalled();
    expect(getMinPrice).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("unknown commission → C = 0: the hotel is still shown, priced above SSP if the floor binds, reported once", async () => {
    // The quote's lot share disagrees with the lot's 85 % → cross-check fails.
    getMinPrice.mockImplementation(async (id: number) =>
      id === 132 ? minPrice({ grand: 120, sub: 110, tax: 10, lc: 50 }) : minPrice({ grand: 90, sub: 80, tax: 10, lc: 64 })
    );
    liteResponse.body.data[0] = hotelRates("lp27fe6", [rate({ rateId: "dt", net: 200, ssp: 201, refundable: true })]);
    const out = await searchParkStay(JFK_ENTRIES, await input(), () => {});
    const dt = out.kind === "results" ? out.cards.find((c) => c.hotelKey === "doubletree-jfk") : undefined;
    expect(dt).toBeDefined();
    expect(dt!.room.priceBasis).toBe("floor");
    expect(dt!.room.price.roomSellCents).toBeGreaterThan(20_100);
    await searchParkStay(JFK_ENTRIES, await input(), () => {});
    expect(captureAPIError.mock.calls.filter((c) => (c[1] as { stage: string }).stage === "commission_unknown")).toHaveLength(1);
  });

  it("missing LiteAPI content: shown under the map's name with a placeholder, reported once", async () => {
    liteResponse.body.hotels = [content(hampton)];
    const out = await searchParkStay(JFK_ENTRIES, await input(), () => {});
    const dt = out.kind === "results" ? out.cards.find((c) => c.hotelKey === "doubletree-jfk") : undefined;
    expect(dt).toMatchObject({ name: doubletree.liteapi.name, contentFromMap: true, photoUrl: null, stars: null });
    expect(captureAPIError.mock.calls.filter((c) => (c[1] as { stage: string }).stage === "liteapi_content")).toHaveLength(1);
  });

  it("LiteAPI content for a different hotel hides it and alerts", async () => {
    liteResponse.body.hotels = [content(doubletree, { name: "Radisson Hotel JFK Airport" }), content(hampton)];
    const out = await searchParkStay(JFK_ENTRIES, await input(), () => {});
    expect(out.kind === "results" && out.cards.map((c) => c.hotelKey)).toEqual(["hampton-inn-jfk"]);
    expect(out.kind === "results" && out.hidden.liteapi_mismatch).toBe(1);
    expect(captureAPIError.mock.calls.some((c) => (c[1] as { stage: string }).stage === "park_stay_map_drift")).toBe(true);
  });

  it("a quote that fails a check, a non-USD hotel fee, and a missing lot each hide only that hotel", async () => {
    getMinPrice.mockImplementation(async (id: number) =>
      id === 132 ? minPrice({ grand: 120, sub: 110, tax: 10, due: 20, lc: 93.5 }) : minPrice({ grand: 90, sub: 80, tax: 10, lc: 64 })
    );
    let out = await searchParkStay(JFK_ENTRIES, await input(), () => {});
    expect(out.kind === "results" && out.hidden.parking_quote_check).toBe(1);
    expect(out.kind === "results" && out.cards.map((c) => c.hotelKey)).toEqual(["hampton-inn-jfk"]);

    __resetHotelLotResolveForTests();
    getMinPrice.mockImplementation(async (id: number) => (id === 132 ? minPrice({ grand: 120, sub: 110, tax: 10, lc: 93.5 }) : minPrice({ grand: 90, sub: 80, tax: 10, lc: 64 })));
    liteResponse.body.data[1] = hotelRates("lp3034d", [rate({ rateId: "x", net: 150, ssp: 170, atHotel: [{ amount: 10, currency: "CAD" }] })]);
    out = await searchParkStay(JFK_ENTRIES, await input(), () => {});
    expect(out.kind === "results" && out.hidden.non_usd_collected_fee).toBe(1);

    __resetHotelLotResolveForTests();
    defaultLite();
    getLocation.mockImplementation(async (id: number) => {
      if (id === 304) throw new ReslabError(404, "not found");
      return locationFor(doubletree);
    });
    out = await searchParkStay(JFK_ENTRIES, await input(), () => {});
    expect(out.kind === "results" && out.hidden.lot_missing).toBe(1);
    expect(captureAPIError.mock.calls.some((c) => String(c[0]).includes("not found"))).toBe(true);
  });

  it("an honest empty names the reason when every hotel was sold out", async () => {
    getMinPrice.mockResolvedValue(minPrice({ grand: 100, sub: 100, soldOut: true }));
    const out = await searchParkStay(JFK_ENTRIES, await input(), () => {});
    expect(out).toMatchObject({ kind: "results", cards: [], emptyReason: "sold_out", partial: false });
  });
});

describe("quoteParkStayHotel — the hotel page", () => {
  it("lists the cheapest rate per room key (≤ 6), always including the leading refundable rate", async () => {
    const many = Array.from({ length: 8 }, (_, k) => rate({ rateId: `n${k}`, net: 100 + k, ssp: 120 + k, boardType: `B${k}` }));
    liteResponse.body.data[0] = hotelRates("lp27fe6", [...many, rate({ rateId: "rfn", net: 300, ssp: 330, refundable: true }), rate({ rateId: "n0-dup", net: 400, ssp: 450, boardType: "B0" })]);
    const out = await quoteParkStayHotel(doubletree, await input(), 6, () => {});
    expect(out.kind).toBe("hotel");
    if (out.kind !== "hotel") return;
    expect(out.rooms).toHaveLength(6);
    expect(new Set(out.rooms.map((r) => r.roomKey)).size).toBe(6);
    expect(out.rooms.some((r) => r.offerRef.rateId === "rfn")).toBe(true);
    expect(out.rooms[0].offerRef.rateId).toBe("n0");
    expect(out.leading.offerRef.rateId).toBe("rfn");
    expect(getMinPrice.mock.calls.map((c) => c[0])).toEqual([132]);
    expect(liteBody().hotelIds).toEqual(["lp27fe6"]);
  });

  it("an unavailable hotel says why", async () => {
    getMinPrice.mockResolvedValue(minPrice({ grand: 100, sub: 100, soldOut: true }));
    expect(await quoteParkStayHotel(doubletree, await input(), 6, () => {})).toEqual({ kind: "unavailable", reason: "parking_sold_out" });
  });
});
