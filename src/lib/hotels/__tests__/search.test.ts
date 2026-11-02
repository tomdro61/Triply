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
const warmToken = vi.fn(async (): Promise<void> => {});

vi.mock("@/lib/sentry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sentry")>();
  return { ...actual, captureAPIError: (...a: unknown[]) => captureAPIError(...a) };
});
vi.mock("@/lib/reslab/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/reslab/client")>();
  return {
    ...actual,
    warmReslabToken: () => warmToken(),
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
import { __resetHotelLotResolveForTests, lookupLot } from "../hotel-lot-resolve";
import { validateParkStayWindow, type ParkStayWindow } from "../parking-window";
import { ParkStayUnavailableError, prepareParkStay, quoteParkStayHotel, searchParkStay, type ParkStayRunInput } from "../search";
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

const prep = (entries: readonly HotelLotEntry[] = JFK_ENTRIES) => prepareParkStay(entries, "JFK", "/api/park-stay/search");

async function ticket(): Promise<BudgetTicket> {
  return takeLiteApiCall("sandbox", "/hotels/rates", async () => ({ data: [{ allowed: true, calls: 1, denied: 0 }], error: null }));
}

async function input(w: ParkStayWindow = windowOf()): Promise<ParkStayRunInput> {
  return { deadlineMs: Date.now() + 28_000, airport: { code: "JFK", timezone: NY }, window: w, adults: 2, ticket: await ticket(), now: NOW, caller: "/api/park-stay/search" };
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
  warmToken.mockReset();
  warmToken.mockResolvedValue(undefined);
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
    const out = await searchParkStay(prep(), i, () => {});
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
    // CX plan §3: each card carries ITS OWN lot's point (the map entry's ResLab coordinates) for the map pin.
    expect([dt.lot.latitude, dt.lot.longitude]).toEqual([doubletree.reslab.latitude, doubletree.reslab.longitude]);
    expect([hi.lot.latitude, hi.lot.longitude]).toEqual([hampton.reslab.latitude, hampton.reslab.longitude]);
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
    await searchParkStay(prep(), await input(), () => {});
    expect(getMinPrice.mock.calls.map((c) => c[0]).sort()).toEqual([132, 304]);
    for (const c of getMinPrice.mock.calls) expect(c[1]).toMatchObject({ from_date: "2026-11-10 19:00:00", to_date: "2026-11-14 18:00:00" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://data.test/hotels/rates");
    expect(liteBody()).toMatchObject({ hotelIds: ["lp27fe6", "lp3034d"], includeHotelData: true, margin: 0, checkin: "2026-11-10", checkout: "2026-11-11", occupancies: [{ adults: 2 }] });
  });

  it("writes no parking telemetry and never touches searchParking or the sweep (runtime spy)", async () => {
    await searchParkStay(prep(), await input(), () => {});
    expect(logAvailability).toHaveBeenCalledTimes(0);
    expect(logSearchEvent).toHaveBeenCalledTimes(0);
    expect(searchParking).not.toHaveBeenCalled();
    expect(getChannelLocationsCached).not.toHaveBeenCalled();
  });

  it("uses the no-sweep list when warm — no getLocation calls", async () => {
    getChannelLocationsNoSweep.mockResolvedValue([locationFor(doubletree), locationFor(hampton, { minimum_booking_days: 2, parking_commission: 80 })]);
    const out = await searchParkStay(prep(), await input(), () => {});
    expect(getLocation).not.toHaveBeenCalled();
    expect(out.kind === "results" && out.cards).toHaveLength(2);
  });

  it("minimum stay hides Hampton JFK on a one-day trip — not a 503, and no quote is asked for it", async () => {
    const out = await searchParkStay(prep(), await input(windowOf({ returnDate: "2026-11-11", returnTime: "6:00 PM" })), () => {});
    expect(out.kind === "results" && out.cards.map((c) => c.hotelKey)).toEqual(["doubletree-jfk"]);
    expect(out.kind === "results" && out.hidden.min_stay).toBe(1);
    expect(getMinPrice.mock.calls.map((c) => c[0])).toEqual([132]);
    expect(liteBody().hotelIds).toEqual(["lp27fe6"]);
  });

  it("when every hotel misses the notice period, answers notice_period with no supplier calls", async () => {
    const tonight = windowOf({ night: "2026-10-20", arrivalTime: "12:00 PM", returnDate: "2026-10-23" });
    const out = await searchParkStay(prep(), await input(tonight), () => {});
    expect(out).toEqual({ kind: "notice_period" });
    expect(getMinPrice).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("some lots transient → partial; every lot transient → unavailable (503)", async () => {
    getMinPrice.mockImplementation(async (id: number) => {
      if (id === 304) throw new ReslabError(502, "bad gateway");
      return minPrice({ grand: 120, sub: 110, tax: 10, lc: 93.5 });
    });
    const out = await searchParkStay(prep(), await input(), () => {});
    expect(out.kind === "results" && out.partial).toBe(true);
    expect(out.kind === "results" && out.cards.map((c) => c.hotelKey)).toEqual(["doubletree-jfk"]);

    __resetHotelLotResolveForTests();
    getMinPrice.mockRejectedValue(new ReslabError(503, "down"));
    await expect(searchParkStay(prep(), await input(), () => {})).rejects.toMatchObject({ reason: "no_reliable_result" });
  });

  it("a LiteAPI failure propagates (the route answers 503)", async () => {
    liteResponse = { status: 500, body: { data: [], sandbox: true } };
    await expect(searchParkStay(prep(), await input(), () => {})).rejects.toBeInstanceOf(LiteApiError);
  });

  it("an unknown ResLab account fails closed before any ResLab call", async () => {
    fingerprint.mockReturnValue("ffffffffffffffff");
    expect(() => prep()).toThrow(ParkStayUnavailableError);
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
    const out = await searchParkStay(prep(), await input(), () => {});
    const dt = out.kind === "results" ? out.cards.find((c) => c.hotelKey === "doubletree-jfk") : undefined;
    expect(dt).toBeDefined();
    expect(dt!.room.priceBasis).toBe("floor");
    // C = 0, F $6.60, P $120: floor = ceil(197,371,400 / 9310) = ceil(21,199.93) = 21,200 (SSP $201 is below it).
    expect(dt!.room.price.roomSellCents).toBe(21_200);
    await searchParkStay(prep(), await input(), () => {});
    expect(captureAPIError.mock.calls.filter((c) => (c[1] as { stage: string }).stage === "commission_unknown")).toHaveLength(1);
  });

  it("missing LiteAPI content: shown under the map's name with a placeholder, reported once", async () => {
    liteResponse.body.hotels = [content(hampton)];
    const out = await searchParkStay(prep(), await input(), () => {});
    const dt = out.kind === "results" ? out.cards.find((c) => c.hotelKey === "doubletree-jfk") : undefined;
    expect(dt).toMatchObject({ name: doubletree.liteapi.name, contentFromMap: true, photoUrl: null, stars: null });
    expect(captureAPIError.mock.calls.filter((c) => (c[1] as { stage: string }).stage === "liteapi_content")).toHaveLength(1);
  });

  it("LiteAPI content for a different hotel hides it and alerts", async () => {
    liteResponse.body.hotels = [content(doubletree, { name: "Radisson Hotel JFK Airport" }), content(hampton)];
    const out = await searchParkStay(prep(), await input(), () => {});
    expect(out.kind === "results" && out.cards.map((c) => c.hotelKey)).toEqual(["hampton-inn-jfk"]);
    expect(out.kind === "results" && out.hidden.liteapi_mismatch).toBe(1);
    expect(captureAPIError.mock.calls.some((c) => (c[1] as { stage: string }).stage === "park_stay_map_drift")).toBe(true);
  });

  it("a quote that fails a check, a non-USD hotel fee, and a missing lot each hide only that hotel", async () => {
    getMinPrice.mockImplementation(async (id: number) =>
      id === 132 ? minPrice({ grand: 120, sub: 110, tax: 10, due: 20, lc: 93.5 }) : minPrice({ grand: 90, sub: 80, tax: 10, lc: 64 })
    );
    let out = await searchParkStay(prep(), await input(), () => {});
    expect(out.kind === "results" && out.hidden.parking_quote_policy).toBe(1);
    expect(out.kind === "results" && out.cards.map((c) => c.hotelKey)).toEqual(["hampton-inn-jfk"]);

    __resetHotelLotResolveForTests();
    getMinPrice.mockImplementation(async (id: number) => (id === 132 ? minPrice({ grand: 120, sub: 110, tax: 10, lc: 93.5 }) : minPrice({ grand: 90, sub: 80, tax: 10, lc: 64 })));
    liteResponse.body.data[1] = hotelRates("lp3034d", [rate({ rateId: "x", net: 150, ssp: 170, atHotel: [{ amount: 10, currency: "CAD" }] })]);
    out = await searchParkStay(prep(), await input(), () => {});
    expect(out.kind === "results" && out.hidden.non_usd_collected_fee).toBe(1);

    __resetHotelLotResolveForTests();
    defaultLite();
    getLocation.mockImplementation(async (id: number) => {
      if (id === 304) throw new ReslabError(404, "not found");
      return locationFor(doubletree);
    });
    out = await searchParkStay(prep(), await input(), () => {});
    expect(out.kind === "results" && out.hidden.lot_missing).toBe(1);
    expect(captureAPIError.mock.calls.some((c) => String(c[0]).includes("not found"))).toBe(true);
  });

  it("an honest empty names the reason when every hotel was sold out", async () => {
    getMinPrice.mockResolvedValue(minPrice({ grand: 100, sub: 100, soldOut: true }));
    const out = await searchParkStay(prep(), await input(), () => {});
    expect(out).toMatchObject({ kind: "results", cards: [], emptyReason: "sold_out", partial: false });
  });
});

describe("quoteParkStayHotel — the hotel page", () => {
  it("lists the cheapest rate per room key (≤ 6), always including the leading refundable rate", async () => {
    const many = Array.from({ length: 8 }, (_, k) => rate({ rateId: `n${k}`, net: 100 + k, ssp: 120 + k, boardType: `B${k}` }));
    liteResponse.body.data[0] = hotelRates("lp27fe6", [...many, rate({ rateId: "rfn", net: 300, ssp: 330, refundable: true }), rate({ rateId: "n0-dup", net: 400, ssp: 450, boardType: "B0" })]);
    const out = await quoteParkStayHotel(prep([doubletree]), await input(), 6, () => {});
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
    expect(await quoteParkStayHotel(prep([doubletree]), await input(), 6, () => {})).toEqual({ kind: "unavailable", reason: "parking_sold_out" });
  });
});

describe("review pass 1 — pricing at search level (T1, M6)", () => {
  it("SSP null + KNOWN commission: each card's room price is the hand-computed order floor, or net when the floor is below it", async () => {
    // DoubleTree (lot keeps 85%): sub 110 + fees 5 − ltd 10 + tax 10 = grand 115; base 105; F = 6% of 115 = $6.90;
    //   C = round(10500 × 15%) − round(10500 × 5%) = 1575 − 525 = 1050.
    //   floor = ceil((20000·10000 − (690 + 1050)·10000 + 290·(11500 + 690) + 30·10000) / 9310) = ceil(20025.24) = 20026 ≥ net 20000.
    // Hampton (80%): sub 80 + fees 2 − ltd 4 + tax 8 = 86; base 78; F = $5.95 (minimum); C = 1560 − 390 = 1170.
    //   floor = ceil((15000·10000 − 1765·10000 + 290·9195 + 300000) / 9310) = ceil(14534.56) = 14535 < net 15000 → the net guard: 15000.
    getMinPrice.mockImplementation(async (id: number) =>
      id === 132
        ? minPrice({ grand: 115, sub: 110, fees: 5, ltd: 10, tax: 10, lc: 89.25 })
        : minPrice({ grand: 86, sub: 80, fees: 2, ltd: 4, tax: 8, lc: 62.4 })
    );
    liteResponse.body.data = [
      hotelRates("lp27fe6", [rate({ rateId: "dt", net: 200, ssp: null, refundable: true })]),
      hotelRates("lp3034d", [rate({ rateId: "hi", net: 150, ssp: null, refundable: true })]),
    ];
    const out = await searchParkStay(prep(), await input(), () => {});
    if (out.kind !== "results") throw new Error(out.kind);
    const dt = out.cards.find((c) => c.hotelKey === "doubletree-jfk")!;
    const hi = out.cards.find((c) => c.hotelKey === "hampton-inn-jfk")!;
    expect(dt.room.price).toMatchObject({ roomSellCents: 20_026, parkingOnlineCents: 11_500, serviceFeeCents: 690 });
    expect(dt.room.priceBasis).toBe("floor");
    expect(hi.room.price).toMatchObject({ roomSellCents: 15_000, parkingOnlineCents: 8_600, serviceFeeCents: 595 });
    expect(hi.room.priceBasis).toBe("net");
    expect(captureAPIError.mock.calls.filter((c) => (c[1] as { stage: string }).stage === "commission_unknown")).toHaveLength(0);
  });
});

describe("review pass 1 — degraded vs policy hides (H2, H5, M2, T4)", () => {
  it("an identity-mismatched quote is a DATA failure: hidden, reported, and the answer is partial (H5)", async () => {
    getMinPrice.mockImplementation(async (id: number) =>
      id === 132 ? minPrice({ grand: 150, sub: 110, tax: 10, lc: 93.5 }) : minPrice({ grand: 90, sub: 80, tax: 10, lc: 64 })
    );
    const out = await searchParkStay(prep(), await input(), () => {});
    expect(out).toMatchObject({ kind: "results", partial: true, hidden: { parking_quote_invalid: 1 } });
    expect(captureAPIError.mock.calls.some((c) => (c[1] as { stage: string }).stage === "parking_quote_invalid")).toBe(true);
  });

  it("a due-at-lot quote is POLICY: hidden, and the answer stays complete (H5)", async () => {
    getMinPrice.mockImplementation(async (id: number) =>
      id === 132 ? minPrice({ grand: 120, sub: 110, tax: 10, due: 20, lc: 93.5 }) : minPrice({ grand: 90, sub: 80, tax: 10, lc: 64 })
    );
    const out = await searchParkStay(prep(), await input(), () => {});
    expect(out).toMatchObject({ kind: "results", partial: false, hidden: { parking_quote_policy: 1 } });
  });

  it("a ResLab 401 is `auth`, reported EVERY time, and degrades the answer (H2)", async () => {
    getMinPrice.mockImplementation(async (id: number) => {
      if (id === 304) throw new ReslabError(401, "API request failed: unauthorised");
      return minPrice({ grand: 120, sub: 110, tax: 10, lc: 93.5 });
    });
    for (let i = 0; i < 2; i++) {
      __resetHotelLotResolveForTests();
      const out = await searchParkStay(prep(), await input(), () => {});
      expect(out).toMatchObject({ kind: "results", partial: true, hidden: { parking_auth: 1 } });
    }
    // reset clears the once-keys, so count only the auth stage: one per request
    expect(captureAPIError.mock.calls.filter((c) => (c[1] as { stage: string }).stage === "parking_auth")).toHaveLength(2);
  });

  it("transient per-lot failures reach Sentry throttled per lot, with the detail (H2)", async () => {
    getMinPrice.mockImplementation(async (id: number) => {
      if (id === 304) throw new ReslabError(502, "bad gateway");
      return minPrice({ grand: 120, sub: 110, tax: 10, lc: 93.5 });
    });
    await searchParkStay(prep(), await input(), () => {});
    await searchParkStay(prep(), await input(), () => {});
    const transient = captureAPIError.mock.calls.filter((c) => (c[1] as { stage: string }).stage === "parking_transient");
    expect(transient).toHaveLength(1);
    expect((transient[0][1] as { extra: { detail: string } }).extra.detail).toMatch(/502/);
  });

  it("our own throw while checking a quote is `unexpected` — reported, not 'transient' (H2)", async () => {
    getMinPrice.mockImplementation(async (id: number) => {
      if (id === 304) {
        return {
          get reservation(): never {
            throw new TypeError("boom");
          },
        };
      }
      return minPrice({ grand: 120, sub: 110, tax: 10, lc: 93.5 });
    });
    const out = await searchParkStay(prep(), await input(), () => {});
    expect(out).toMatchObject({ kind: "results", partial: true, hidden: { parking_unexpected: 1 } });
    expect(out.kind === "results" && out.hidden.parking_transient).toBeFalsy();
    expect(captureAPIError.mock.calls.some((c) => (c[1] as { stage: string }).stage === "parking_unexpected")).toBe(true);
  });

  it("T4a: getLocation 502 for every lot → 503 (no reliable result), LiteAPI never called, ticket unspent", async () => {
    getLocation.mockRejectedValue(new ReslabError(502, "bad gateway"));
    const i = await input();
    await expect(searchParkStay(prep(), i, () => {})).rejects.toMatchObject({ reason: "no_reliable_result" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(i.ticket.spent).toBe(false);
  });

  it("T4b / M2: one lot transient + one hidden for min_stay → no cards, partial, NO 'none available' reason", async () => {
    getMinPrice.mockImplementation(async () => {
      throw new ReslabError(503, "down");
    });
    const oneDay = windowOf({ returnDate: "2026-11-11", returnTime: "6:00 PM" }); // Hampton (min 2 days) hidden
    const out = await searchParkStay(prep(), await input(oneDay), () => {});
    expect(out).toMatchObject({ kind: "results", cards: [], partial: true, emptyReason: null, hidden: { min_stay: 1, parking_transient: 1 } });
  });

  it("M3: ResLab's own notice-period 4xx on every lot → the 'choose a later arrival time' answer", async () => {
    getMinPrice.mockRejectedValue(new ReslabError(400, 'API request failed: {"message":"Minimum number of hours before parking reservation is 24"}'));
    expect(await searchParkStay(prep(), await input(), () => {})).toEqual({ kind: "notice_period" });
    __resetHotelLotResolveForTests();
    expect(await quoteParkStayHotel(prep([doubletree]), await input(), 6, () => {})).toEqual({ kind: "notice_period" });
  });
});

describe("review pass 1 — hotel page list keeps the leading rate (M7)", () => {
  it("when the leading refundable rate shares its room key with a cheaper rate that SHOWS non-refundable, the leading rate takes the slot", async () => {
    const passed = rate({ rateId: "rfn-passed", net: 180, ssp: 190, refundable: true });
    const passedRate = {
      ...passed,
      cancellationPolicies: { refundableTag: "RFN", cancelPolicyInfos: [{ cancelTime: "2026-10-01 10:00:00", amount: 180, type: "amount", timezone: "GMT" }] },
    };
    liteResponse.body.data[0] = hotelRates("lp27fe6", [passedRate, rate({ rateId: "rfn-live", net: 220, ssp: 240, refundable: true })]);
    const out = await quoteParkStayHotel(prep([doubletree]), await input(), 6, () => {});
    if (out.kind !== "hotel") throw new Error(out.kind);
    expect(out.leading.offerRef.rateId).toBe("rfn-live");
    expect(out.rooms.map((r) => r.offerRef.rateId)).toEqual(["rfn-live"]);
  });
});

describe("review pass 2 — the request-wide deadline (H1)", () => {
  afterEach(() => vi.useRealTimers());

  /** A fetch that never answers but honours its AbortSignal, like a stalled LiteAPI. */
  function stalledFetch(_url: string | URL | Request, init?: RequestInit): Promise<Response> {
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    });
  }

  it("snapshot stalled + auth stalled + one lot cached, one stalled + LiteAPI stalled → done within the 28 s budget", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    // Prime: lot 132 cached from an earlier request; lot 304 will stall.
    expect((await lookupLot(132, null)).kind).toBe("found");
    getChannelLocationsNoSweep.mockReturnValue(new Promise(() => {}));
    warmToken.mockReturnValue(new Promise(() => {}));
    getLocation.mockReturnValue(new Promise(() => {}));
    getMinPrice.mockReturnValue(new Promise(() => {}));
    fetchMock.mockImplementation(stalledFetch);

    const started = Date.now();
    const i = { ...(await input()), deadlineMs: started + 28_000 };
    let settledAt: number | null = null;
    const p = searchParkStay(prep(), i, () => {}).then(
      () => "resolved",
      (e: unknown) => e
    );
    void p.then(() => (settledAt = Date.now()));
    for (let t = 0; t < 40 && settledAt === null; t++) await vi.advanceTimersByTimeAsync(1_000);
    expect(settledAt).not.toBeNull();
    expect((settledAt ?? Infinity) - started).toBeLessThanOrEqual(28_000);
    // LiteAPI was capped at what was left (~15 s here) and timed out → the route's 503.
    expect(await p).toBeInstanceOf(LiteApiError);
    expect(warmToken).toHaveBeenCalledTimes(1);
  });

  it("too little time left for LiteAPI → 503 (deadline) without calling it; the ticket stays unspent", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    getChannelLocationsNoSweep.mockReturnValue(new Promise(() => {}));
    warmToken.mockReturnValue(new Promise(() => {}));
    const started = Date.now();
    const i = { ...(await input()), deadlineMs: started + 10_000 };
    const p = searchParkStay(prep(), i, () => {}).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await p).toMatchObject({ name: "ParkStayUnavailableError", reason: "deadline" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(i.ticket.spent).toBe(false);
  });

  it("a ResLab auth refusal at the warm-up stops the request BEFORE the fan-out (M1)", async () => {
    warmToken.mockRejectedValue(new ReslabError(401, "Authentication failed"));
    await expect(searchParkStay(prep(), await input(), () => {})).rejects.toMatchObject({ reason: "reslab_auth" });
    expect(getLocation).not.toHaveBeenCalled();
    expect(getMinPrice).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("an unrecognised ResLab refusal is DEGRADED: partial, no confident 'none available' (M3)", async () => {
    getMinPrice.mockImplementation(async (id: number) => {
      if (id === 132) throw new ReslabError(422, 'API request failed: {"message":"Stay too short for this lot"}');
      return minPrice({ grand: 90, sub: 80, soldOut: true });
    });
    const out = await searchParkStay(prep(), await input(), () => {});
    expect(out).toMatchObject({ kind: "results", cards: [], partial: true, emptyReason: null, hidden: { parking_unknown_4xx: 1, parking_sold_out: 1 } });
    // and when it is the only answer there is, nothing reliable remains → 503
    __resetHotelLotResolveForTests();
    getMinPrice.mockRejectedValue(new ReslabError(422, 'API request failed: {"message":"Stay too short for this lot"}'));
    await expect(searchParkStay(prep(), await input(), () => {})).rejects.toMatchObject({ reason: "no_reliable_result" });
  });
});

describe("review pass 3", () => {
  afterEach(() => vi.useRealTimers());

  it("M1: a warm-up refused with a NON-401 status ('Authentication failed', 422) still stops the request before the fan-out", async () => {
    warmToken.mockRejectedValue(new ReslabError(422, "Authentication failed: invalid domain"));
    await expect(searchParkStay(prep(), await input(), () => {})).rejects.toMatchObject({ reason: "reslab_auth" });
    expect(getLocation).not.toHaveBeenCalled();
    expect(getMinPrice).not.toHaveBeenCalled();
  });

  it("M2: a hotel absent from LiteAPI's readable answer is no_rates_returned — never sold out — and the answer is not cacheable", async () => {
    liteResponse.body.data = [liteResponse.body.data[1]]; // Hampton only
    const out = await searchParkStay(prep(), await input(), () => {});
    expect(out).toMatchObject({ kind: "results", partial: false, cacheable: false, hidden: { no_rates_returned: 1 } });
    expect(out.kind === "results" && out.cards.map((c) => c.hotelKey)).toEqual(["hampton-inn-jfk"]);

    __resetHotelLotResolveForTests();
    liteResponse.body.data = [];
    const empty = await searchParkStay(prep(), await input(), () => {});
    expect(empty).toMatchObject({ kind: "results", cards: [], emptyReason: "none_available", cacheable: false });
    __resetHotelLotResolveForTests();
    expect(await quoteParkStayHotel(prep([doubletree]), await input(), 6, () => {})).toEqual({ kind: "unavailable", reason: "no_rates_returned" });
  });

  it("M2: an explicit empty room list for a hotel is still sold out", async () => {
    liteResponse.body.data = [hotelRates("lp27fe6", []), hotelRates("lp3034d", [])];
    const out = await searchParkStay(prep(), await input(), () => {});
    expect(out).toMatchObject({ kind: "results", cards: [], emptyReason: "sold_out", cacheable: true });
  });

  it("M3: a snapshot read that times out is reported (throttled) and the search continues on getLocation", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    getChannelLocationsNoSweep.mockReturnValue(new Promise(() => {}));
    const i = { ...(await input()), deadlineMs: Date.now() + 28_000 };
    const p = searchParkStay(prep(), i, () => {});
    await vi.advanceTimersByTimeAsync(5_001);
    const out = await p;
    expect(out.kind === "results" && out.cards).toHaveLength(2);
    expect(captureAPIError.mock.calls.filter((c) => (c[1] as { stage: string }).stage === "park_stay_snapshot_unavailable")).toHaveLength(1);
  });
});
