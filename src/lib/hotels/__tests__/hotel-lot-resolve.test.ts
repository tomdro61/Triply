import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getLocation = vi.fn();
const getMinPrice = vi.fn();
const captureAPIError = vi.fn();

vi.mock("@/lib/sentry", () => ({ captureAPIError: (...a: unknown[]) => captureAPIError(...a) }));
vi.mock("@/lib/reslab/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/reslab/client")>();
  return {
    ...actual,
    warmReslabToken: async () => {},
    reslab: { ...actual.reslab, getLocation: (...a: unknown[]) => getLocation(...a), getMinPrice: (...a: unknown[]) => getMinPrice(...a) },
  };
});

import { ReslabError } from "@/lib/reslab/client";
import {
  __resetHotelLotResolveForTests,
  classifyCallError,
  classifyParkingRefusal,
  guardHotelContent,
  guardLot,
  lookupLot,
  lotDisplay,
  quoteLotParking,
  reportOnce,
  reportThrottled,
} from "../hotel-lot-resolve";
import { HOTEL_LOTS } from "../hotel-lots";
import { mapHotelContent } from "../liteapi/rates";
import { RESLAB_MIN_PRICE_TIMEOUT_MS, RESLAB_LOCATION_BACKOFF_MS, RESLAB_LOCATION_TIMEOUT_BACKOFF_MS } from "../plans";
import { BoundedTimeoutError } from "@/lib/utils/bounded";
import { content, locationFor, minPrice } from "./fixtures";

const doubletree = HOTEL_LOTS[0];
const hyatt = HOTEL_LOTS.find((e) => e.key === "hyatt-place-flushing-lga")!;

beforeEach(() => {
  __resetHotelLotResolveForTests();
  getLocation.mockReset();
  getMinPrice.mockReset();
  captureAPIError.mockReset();
});
afterEach(() => vi.useRealTimers());

describe("guardLot — checks 1–3 (§3.4)", () => {
  it("passes the hotel's own, suitable lot", () => {
    expect(guardLot(doubletree, 132, locationFor(doubletree))).toEqual({ ok: true });
  });
  it("accepts a punctuation/case-only name difference", () => {
    expect(guardLot(doubletree, 132, locationFor(doubletree, { name: "DOUBLETREE  by-Hilton" })).ok).toBe(true);
  });
  it.each([
    ["blocked", { id: 416 }, 416],
    ["wrong_id", { id: 999 }, 132],
    ["renamed", { name: "Radisson JFK" }, 132],
    ["moved", { latitude: "40.6800000" }, 132],
    ["moved", { latitude: "not a number" }, 132],
    ["wrong_type", { type: "parking" }, 132],
    ["wrong_type", { type: undefined }, 132],
    ["due_at_location", { parking_due_at_location: 1 }, 132],
    ["refund", { cancellation_policies: [{ id: 1, number_of_days: 0, percentage: 80, type: "parking" as const }] }, 132],
    ["refund", { cancellation_policies: [] }, 132],
  ])("%s", (reason, over, expectedId) => {
    const g = guardLot(doubletree, expectedId, locationFor(doubletree, over));
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.reason).toBe(reason);
  });
});

describe("guardHotelContent — check 4", () => {
  it("ok when name tokens match and the point is within 300 m", () => {
    expect(guardHotelContent(doubletree, mapHotelContent(content(doubletree), new Set()))).toEqual({ kind: "ok" });
    expect(guardHotelContent(hyatt, mapHotelContent(content(hyatt, { name: "Hyatt Place  Flushing / LaGuardia Airport" }), new Set()))).toEqual({ kind: "ok" });
  });
  it("a different name is positive evidence of the wrong hotel → mismatch (hidden)", () => {
    expect(guardHotelContent(doubletree, mapHotelContent(content(doubletree, { name: "Radisson Hotel JFK Airport" }), new Set())).kind).toBe("mismatch");
  });
  it("a hotel more than 300 m from the recorded point → mismatch", () => {
    expect(guardHotelContent(doubletree, mapHotelContent(content(doubletree, { latitude: doubletree.liteapi.latitude + 0.01 }), new Set())).kind).toBe("mismatch");
  });
  it("absent content is NOT evidence → absent (shown under the map's name)", () => {
    expect(guardHotelContent(doubletree, undefined)).toEqual({ kind: "absent" });
  });
  it("name matches but no coordinates → shown, flagged", () => {
    expect(guardHotelContent(doubletree, mapHotelContent(content(doubletree, { latitude: undefined }), new Set()))).toEqual({ kind: "ok_no_coordinates" });
  });
});

describe("lookupLot", () => {
  it("uses the no-sweep list when present; absence from a complete list is a definite miss", async () => {
    const list = [locationFor(doubletree)];
    expect((await lookupLot(132, list)).kind).toBe("found");
    expect((await lookupLot(304, list)).kind).toBe("missing");
    expect(getLocation).not.toHaveBeenCalled();
  });

  it("falls back to getLocation, caches 4 h, and shares one in-flight call", async () => {
    getLocation.mockResolvedValue(locationFor(doubletree));
    const [a, b] = await Promise.all([lookupLot(132, null, 1_000), lookupLot(132, null, 1_000)]);
    expect(a.kind).toBe("found");
    expect(b.kind).toBe("found");
    expect((await lookupLot(132, null, 1_000 + 60_000)).kind).toBe("found");
    expect(getLocation).toHaveBeenCalledTimes(1);
  });

  it("a ResLab 404 is a definite miss with NO backoff", async () => {
    getLocation.mockRejectedValue(new ReslabError(404, "API request failed: not found"));
    expect((await lookupLot(132, null, 0)).kind).toBe("missing");
    expect((await lookupLot(132, null, 1)).kind).toBe("missing");
    expect(getLocation).toHaveBeenCalledTimes(2);
  });

  it("a transient failure backs off for 10 minutes", async () => {
    getLocation.mockRejectedValue(new ReslabError(502, "bad gateway"));
    expect((await lookupLot(132, null, 0)).kind).toBe("transient");
    expect((await lookupLot(132, null, RESLAB_LOCATION_BACKOFF_MS - 1)).kind).toBe("transient");
    expect(getLocation).toHaveBeenCalledTimes(1);
    getLocation.mockResolvedValue(locationFor(doubletree));
    expect((await lookupLot(132, null, RESLAB_LOCATION_BACKOFF_MS + 1)).kind).toBe("found");
  });
});

describe("quoteLotParking — classification, bounds and cache", () => {
  const from = "2026-11-10 19:00:00";
  const to = "2026-11-14 18:00:00";

  it("prices a clean quote and caches it for 5 minutes", async () => {
    getMinPrice.mockResolvedValue(minPrice({ grand: 100, sub: 100, lc: 85 }));
    expect((await quoteLotParking(132, from, to, 0)).kind).toBe("priced");
    expect((await quoteLotParking(132, from, to, 60_000)).kind).toBe("priced");
    expect(getMinPrice).toHaveBeenCalledTimes(1);
    expect(getMinPrice.mock.calls[0]).toEqual([132, { type: "parking", reservation_type: "parking", from_date: from, to_date: to, number_of_spots: 1 }]);
  });

  it("classifies known and unknown 4xx; 429 and 5xx are transient and never cached", async () => {
    getMinPrice.mockRejectedValueOnce(new ReslabError(400, 'API request failed: {"message":"Minimum number of hours before parking reservation is 24"}'));
    expect(await quoteLotParking(1, from, to)).toMatchObject({ kind: "known_4xx", reason: "notice_period" });
    getMinPrice.mockRejectedValueOnce(new ReslabError(422, "API request failed: Bookings only accepted within 100 days"));
    expect(await quoteLotParking(2, from, to)).toMatchObject({ kind: "known_4xx", reason: "booking_window" });
    getMinPrice.mockRejectedValueOnce(new ReslabError(422, 'API request failed: {"message":"Something new"}'));
    expect(await quoteLotParking(3, from, to)).toMatchObject({ kind: "unknown_4xx", status: 422, message: "Something new" });
    getMinPrice.mockRejectedValueOnce(new ReslabError(429, "slow down"));
    expect((await quoteLotParking(4, from, to)).kind).toBe("transient");
    getMinPrice.mockRejectedValueOnce(new ReslabError(502, "bad gateway"));
    expect((await quoteLotParking(5, from, to)).kind).toBe("transient");
    getMinPrice.mockResolvedValueOnce(minPrice({ grand: 100, sub: 100 }));
    expect((await quoteLotParking(5, from, to)).kind).toBe("priced");
  });

  it("a min-price call that hangs times out at 8 s and counts as transient", async () => {
    vi.useFakeTimers();
    getMinPrice.mockReturnValue(new Promise(() => {}));
    const p = quoteLotParking(132, from, to);
    await vi.advanceTimersByTimeAsync(RESLAB_MIN_PRICE_TIMEOUT_MS - 1);
    let settled = false;
    void p.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(await p).toMatchObject({ kind: "transient" });
  });

  it("a failed quote check is reported by the caller, not cached", async () => {
    getMinPrice.mockResolvedValue(minPrice({ grand: 100, sub: 100, due: 10 }));
    expect(await quoteLotParking(9, from, to, 0)).toMatchObject({ kind: "check_failed", reason: "due_at_location" });
    await quoteLotParking(9, from, to, 1);
    expect(getMinPrice).toHaveBeenCalledTimes(2);
  });
});

describe("classifyParkingRefusal", () => {
  it.each([
    ["Minimum number of hours before parking reservation is 2", "notice_period"],
    ["Please choose a date in the future", "notice_period"],
    ["Bookings only accepted within 100 days", "booking_window"],
    ["Minimum booking days is 2", "min_stay"],
    ["Reservation must be at least 2 days", "min_stay"],
    ["Invalid Flight Number", null],
  ])("%s → %s", (msg, expected) => {
    expect(classifyParkingRefusal(msg)).toBe(expected);
  });
});

describe("lotDisplay and reportOnce", () => {
  it("strips ResLab HTML and omits a missing front desk (Hyatt)", () => {
    const d = lotDisplay(locationFor(hyatt, { front_desk_hours: null, shuttle_info_summary: "<p>7 AM - 10 PM on top of hour</p>", checkin_time: "15:00" }));
    expect(d).toMatchObject({ shuttleSummary: "7 AM - 10 PM on top of hour", frontDeskHours: null, roomCheckinTime: "3:00 PM", shuttleAvailable: true });
  });
  it("reports once per key per process", () => {
    reportOnce("k", "m", { caller: "/x", stage: "s" });
    reportOnce("k", "m", { caller: "/x", stage: "s" });
    expect(captureAPIError).toHaveBeenCalledTimes(1);
  });
});

describe("review pass 1 — failure classification and the cold start (H2, M1)", () => {
  it("classifyCallError: 401/403 auth, 404 not found, 5xx/429/timeout/network transient, anything else unexpected", () => {
    expect(classifyCallError(new ReslabError(401, "x")).kind).toBe("auth");
    expect(classifyCallError(new ReslabError(403, "x")).kind).toBe("auth");
    expect(classifyCallError(new ReslabError(404, "x")).kind).toBe("not_found");
    expect(classifyCallError(new ReslabError(422, "x")).kind).toBe("client_4xx");
    for (const e of [new ReslabError(502, "x"), new ReslabError(429, "x"), new ReslabError(0, "x"), new TypeError("fetch failed")]) {
      expect(classifyCallError(e)).toMatchObject({ kind: "transient", timeout: false });
    }
    expect(classifyCallError(new BoundedTimeoutError("x", 1))).toMatchObject({ kind: "transient", timeout: true });
    expect(classifyCallError(new TypeError("Cannot read properties of undefined")).kind).toBe("unexpected");
    expect(classifyCallError("a string").kind).toBe("unexpected");
  });

  it("getLocation 401 → auth, backed off 60 s (no call per request); a body for another lot → unexpected, backed off too", async () => {
    getLocation.mockRejectedValueOnce(new ReslabError(401, "unauthorised"));
    expect((await lookupLot(132, null, 0)).kind).toBe("auth");
    expect((await lookupLot(132, null, 59_999)).kind).toBe("auth");
    expect(getLocation).toHaveBeenCalledTimes(1);
    getLocation.mockResolvedValueOnce(locationFor(HOTEL_LOTS[1]));
    expect((await lookupLot(132, null, 60_001)).kind).toBe("unexpected");
    expect((await lookupLot(132, null, 61_000)).kind).toBe("unexpected");
    expect(getLocation).toHaveBeenCalledTimes(2);
  });

  it("min-price auth / unexpected outcomes are negatively cached for 60 s; a min-price 404 is unexpected, never a confident exclusion", async () => {
    getMinPrice.mockRejectedValueOnce(new ReslabError(401, "unauthorised"));
    expect((await quoteLotParking(1, "a", "b", 0)).kind).toBe("auth");
    expect((await quoteLotParking(1, "a", "b", 59_999)).kind).toBe("auth");
    expect(getMinPrice).toHaveBeenCalledTimes(1);
    getMinPrice.mockRejectedValueOnce(new ReslabError(404, "API request failed: not found"));
    expect((await quoteLotParking(2, "a", "b", 0)).kind).toBe("unexpected");
  });

  it("OUR 4 s bound firing backs off only 60 s, and the late answer fills the cache (M1)", async () => {
    vi.useFakeTimers();
    let resolveLate: (v: ReturnType<typeof locationFor>) => void = () => {};
    getLocation.mockReturnValueOnce(new Promise((r) => (resolveLate = r)));
    const p = lookupLot(132, null, 0);
    await vi.advanceTimersByTimeAsync(4_001);
    expect(await p).toMatchObject({ kind: "transient" });
    // inside the 60 s timeout backoff: no new call
    expect((await lookupLot(132, null, 30_000)).kind).toBe("transient");
    expect(getLocation).toHaveBeenCalledTimes(1);
    // the slow first call answers after all → cached, found with no new call
    resolveLate(locationFor(doubletree));
    await vi.advanceTimersByTimeAsync(0);
    expect((await lookupLot(132, null, 30_001)).kind).toBe("found");
    expect(getLocation).toHaveBeenCalledTimes(1);
  });

  it("after the 60 s timeout backoff a retry is allowed; a real 5xx still backs off 10 min", async () => {
    vi.useFakeTimers();
    getLocation.mockReturnValueOnce(new Promise(() => {}));
    const p = lookupLot(132, null, 0);
    await vi.advanceTimersByTimeAsync(4_001);
    await p;
    getLocation.mockResolvedValueOnce(locationFor(doubletree));
    expect((await lookupLot(132, null, RESLAB_LOCATION_TIMEOUT_BACKOFF_MS + 1)).kind).toBe("found");
    getLocation.mockRejectedValueOnce(new ReslabError(503, "down"));
    expect((await lookupLot(304, null, 0)).kind).toBe("transient");
    expect((await lookupLot(304, null, RESLAB_LOCATION_TIMEOUT_BACKOFF_MS + 1)).kind).toBe("transient");
    expect(getLocation).toHaveBeenCalledTimes(3);
  });

  it("reportThrottled: at most one event per key per interval", () => {
    reportThrottled("k", 600_000, "m", { caller: "/x", stage: "s" }, 0);
    reportThrottled("k", 600_000, "m", { caller: "/x", stage: "s" }, 599_999);
    reportThrottled("k", 600_000, "m", { caller: "/x", stage: "s" }, 600_000);
    expect(captureAPIError).toHaveBeenCalledTimes(2);
  });
});

describe("review pass 3 — auth by message, unknown-4xx negative cache", () => {
  it("ANY failed /authenticate is auth, whatever its status", () => {
    expect(classifyCallError(new ReslabError(400, "Authentication failed: bad domain")).kind).toBe("auth");
    expect(classifyCallError(new ReslabError(422, "Authentication failed: {}")).kind).toBe("auth");
    expect(classifyCallError(new ReslabError(422, "API request failed: x")).kind).toBe("client_4xx");
  });

  it("an unrecognised min-price 4xx is negatively cached for 60 s", async () => {
    getMinPrice.mockRejectedValueOnce(new ReslabError(422, 'API request failed: {"message":"Something new"}'));
    expect((await quoteLotParking(7, "a", "b", 0)).kind).toBe("unknown_4xx");
    expect((await quoteLotParking(7, "a", "b", 59_999)).kind).toBe("unknown_4xx");
    expect(getMinPrice).toHaveBeenCalledTimes(1);
    getMinPrice.mockResolvedValueOnce(minPrice({ grand: 100, sub: 100 }));
    expect((await quoteLotParking(7, "a", "b", 60_001)).kind).toBe("priced");
  });
});
