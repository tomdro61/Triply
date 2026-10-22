/**
 * /api/lots/quote — the display-only price for the stay on screen (lot page
 * booking box, search slider). One upstream call per quote; ResLab refusals are
 * the customer's answer (422, not reported), outages are 503 and reported,
 * throttled.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";

const { lookup, getMinPrice, getCost, getLocation } = vi.hoisted(() => ({
  lookup: vi.fn(),
  getMinPrice: vi.fn(),
  getCost: vi.fn(),
  getLocation: vi.fn(),
}));

vi.mock("@/lib/direct/flag", async (importOriginal) =>
  (await import("@/lib/direct/__tests__/flag-switch")).mockFlag(importOriginal)
);
vi.mock("@/lib/direct/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/direct/store")>()),
  fetchDirectLot: lookup,
}));
vi.mock("@/lib/reslab/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/reslab/client")>()),
  reslab: { getMinPrice, getCost, getLocation },
}));
const { captureAPIError } = vi.hoisted(() => ({ captureAPIError: vi.fn() }));
vi.mock("@/lib/sentry", () => ({ captureAPIError }));

import { directLotFromRow } from "@/lib/direct/store";
import { directLotRow } from "@/lib/direct/__tests__/fixtures";
import { flagSwitch } from "@/lib/direct/__tests__/flag-switch";

const req = (over: Record<string, string> = {}) => {
  const q = new URLSearchParams({
    lotId: "reslab-275",
    checkin: "2026-12-10",
    checkout: "2026-12-13",
    checkinTime: "8:00 AM",
    checkoutTime: "8:00 AM",
    ...over,
  });
  return new NextRequest(`http://localhost/api/lots/quote?${q.toString()}`);
};

// PARK AC JFK, 3 days, as ResLab's min-price answered it live on 2026-10-22.
const MIN_PRICE = {
  rates: [{ location_parking_type_id: 414 }],
  reservation: {
    grand_total: 55.2,
    sub_total: 46.25,
    fees_total: 3.99,
    tax_total: 4.96,
    due_at_location: 43.24,
    sold_out: false,
    parking_sold_out: false,
    totals: { parking: { number_of_days: 3, sub_total: 46.25 } },
  },
};

// The route keeps its Sentry throttle in module state: a fresh module per test,
// so no test passes or fails because of what an earlier one captured.
let GET: typeof import("../route").GET;
let ReslabError: typeof import("@/lib/reslab/client").ReslabError;
beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  ({ GET } = await import("../route"));
  ({ ReslabError } = await import("@/lib/reslab/client"));
});
afterEach(() => {
  flagSwitch.open = false;
});

describe("GET /api/lots/quote — ResLab lot", () => {
  it("prices the stay with ONE ResLab call (min-price), in the window the customer picked", async () => {
    getMinPrice.mockResolvedValue(MIN_PRICE);
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(getMinPrice).toHaveBeenCalledTimes(1);
    expect(getMinPrice).toHaveBeenCalledWith(275, {
      type: "parking",
      reservation_type: "parking",
      from_date: "2026-12-10 08:00:00",
      to_date: "2026-12-13 08:00:00",
      number_of_spots: 1,
    });
    expect(getCost).not.toHaveBeenCalled();
    expect(getLocation).not.toHaveBeenCalled();
    const { quote } = await res.json();
    expect(quote).toEqual({
      grandTotal: 55.2,
      subtotal: 46.25,
      feesTotal: 3.99,
      taxTotal: 4.96,
      serviceFee: 5.95, // max($5.95, 6 % × 50.24) — the checkout rule
      dueAtLocation: 43.24,
      numberOfDays: 3,
      soldOut: false,
    });
  });

  it("reports a sold-out stay as sold out", async () => {
    getMinPrice.mockResolvedValue({ ...MIN_PRICE, reservation: { ...MIN_PRICE.reservation, parking_sold_out: true } });
    expect((await (await GET(req())).json()).quote.soldOut).toBe(true);
  });

  it("a ResLab refusal (4xx) is the stay's answer: 422, nothing reported", async () => {
    getMinPrice.mockRejectedValue(new ReslabError(400, "API request failed: Minimum number of hours before parking reservation is 24"));
    const res = await GET(req());
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("reslab_rejected");
    expect(captureAPIError).not.toHaveBeenCalled();
  });

  it("an outage (5xx, 429, timeout) is a 503, reported at most once per window", async () => {
    getMinPrice.mockRejectedValue(new ReslabError(502, "API request failed: bad gateway"));
    expect((await GET(req())).status).toBe(503);
    getMinPrice.mockRejectedValue(new ReslabError(429, "API request failed: slow down"));
    expect((await GET(req())).status).toBe(503);
    getMinPrice.mockRejectedValue(Object.assign(new Error("aborted"), { name: "TimeoutError" }));
    expect((await GET(req())).status).toBe(503);
    expect(captureAPIError).toHaveBeenCalledTimes(1);
  });

  it("our own ResLab problems (401/403) are outages, not 'this stay can't be booked'", async () => {
    getMinPrice.mockRejectedValue(new ReslabError(401, "Auth failed"));
    expect((await GET(req())).status).toBe(503);
    getMinPrice.mockRejectedValue(new ReslabError(403, "Forbidden"));
    expect((await GET(req())).status).toBe(503);
  });

  it("refuses stays no one can book before calling ResLab", async () => {
    const reversed = await GET(req({ checkout: "2026-12-10", checkinTime: "6:00 PM", checkoutTime: "8:00 AM" }));
    expect(reversed.status).toBe(422);
    expect((await reversed.json()).code).toBe("checkout_not_after_checkin");
    expect((await GET(req({ checkout: "2026-12-10" }))).status).toBe(422); // 8 AM → 8 AM same day
    const far = await GET(req({ checkin: "2027-06-01", checkout: "2027-06-03" }));
    expect(far.status).toBe(422);
    expect((await far.json()).code).toBe("beyond_booking_window");
    expect(getMinPrice).not.toHaveBeenCalled();
  });

  it("refuses dates and times that don't exist", async () => {
    expect((await GET(req({ checkin: "2026-13-45" }))).status).toBe(400);
    expect((await GET(req({ checkout: "2026-02-30" }))).status).toBe(400);
    expect((await GET(req({ checkinTime: "99:99 PM" }))).status).toBe(400);
    expect((await GET(req({ checkinTime: "0:30 AM" }))).status).toBe(400);
    expect(getMinPrice).not.toHaveBeenCalled();
  });

  it("an answer that does not make a price (ResLab's $0.00 case) is a 503, reported with the lot and stay", async () => {
    getMinPrice.mockResolvedValue({ ...MIN_PRICE, reservation: { ...MIN_PRICE.reservation, grand_total: 0, sub_total: 0, fees_total: 0, tax_total: 0 } });
    expect((await GET(req())).status).toBe(503);
    expect(captureAPIError).toHaveBeenCalledTimes(1);
    const [, ctx] = captureAPIError.mock.calls[0];
    expect(ctx.extra).toMatchObject({ lotId: "reslab-275", fromDate: "2026-12-10 08:00:00", toDate: "2026-12-13 08:00:00" });
  });

  it("a sold-out stay is reported as sold out even with a $0 total", async () => {
    getMinPrice.mockResolvedValue({ ...MIN_PRICE, reservation: { ...MIN_PRICE.reservation, grand_total: 0, sold_out: true } });
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect((await res.json()).quote.soldOut).toBe(true);
    expect(captureAPIError).not.toHaveBeenCalled();
  });

  it("refuses a malformed request and a blocked lot without calling ResLab", async () => {
    expect((await GET(req({ checkinTime: "" }))).status).toBe(400);
    expect((await GET(req({ lotId: "park-ac" }))).status).toBe(400);
    expect((await GET(req({ lotId: "reslab-416" }))).status).toBe(404);
    expect(getMinPrice).not.toHaveBeenCalled();
  });
});

describe("GET /api/lots/quote — direct lot", () => {
  // The fixture lot is visible on staging only (fixtures.ts).
  beforeEach(() => vi.stubEnv("NEXT_PUBLIC_APP_ENV", "staging"));
  afterEach(() => vi.unstubAllEnvs());
  const lot = () => {
    const out = directLotFromRow(directLotRow({ tax_rate_percent: 16 }));
    if (!out.lot) throw new Error(out.reason);
    return out.lot;
  };

  it("prices through quoteDirectCheckout — what checkout charges — with no ResLab call", async () => {
    flagSwitch.open = true;
    lookup.mockResolvedValue({ status: "found", lot: lot() });
    const res = await GET(req({ lotId: "direct-1", checkinTime: "10:00 AM", checkoutTime: "10:00 AM" }));
    expect(res.status).toBe(200);
    const { quote } = await res.json();
    // 3 days × $9.95 = 29.85; 16 % tax = 4.78; fee floor 5.95.
    expect(quote).toEqual({
      grandTotal: 34.63,
      subtotal: 29.85,
      feesTotal: 0,
      taxTotal: 4.78,
      serviceFee: 5.95,
      dueAtLocation: 0,
      numberOfDays: 3,
      soldOut: false,
    });
    expect(getMinPrice).not.toHaveBeenCalled();
  });

  it("a stay the lot refuses (pick-up before drop-off) is 422; a closed lot is 422", async () => {
    flagSwitch.open = true;
    lookup.mockResolvedValue({ status: "found", lot: lot() });
    const reversed = await GET(req({ lotId: "direct-1", checkout: "2026-12-10", checkinTime: "6:00 PM", checkoutTime: "8:00 AM" }));
    expect(reversed.status).toBe(422);
    flagSwitch.open = false;
    expect((await GET(req({ lotId: "direct-1" }))).status).toBe(422);
  });
});
