/**
 * /api/checkout/lot — the DIRECT-lot branches (plan A-28; vehicle-surcharge
 * plan R5/R11). The PaymentIntent is charged parking + tax + fee (+ Park
 * Guard) and NEVER the vehicle surcharge; the surcharge rates and tax rate are
 * stamped into metadata as the one authority for the at-lot estimate.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { TERMS_VERSION } from "@/lib/checkout/terms-acceptance";
import { NextRequest } from "next/server";

const { lookup, createPI, getLotById, getCost, getLocation, promoSingle, promoEq, channel } = vi.hoisted(() => ({
  lookup: vi.fn(),
  createPI: vi.fn(),
  getLotById: vi.fn(),
  getCost: vi.fn(),
  getLocation: vi.fn(),
  promoSingle: vi.fn(),
  promoEq: vi.fn(),
  // The ResLab location list the instance holds, which the POST reads for the
  // lot's currency; `fails` = no list held (getChannelLocationsNoSweep → null).
  channel: { data: [] as { id: number; currency?: { code: string } }[], fails: false },
}));
vi.mock("@/lib/reslab/search", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/reslab/search")>()),
  getChannelLocationsNoSweep: async () => (channel.fails ? null : channel.data),
}));

vi.mock("@/lib/direct/flag", async (importOriginal) =>
  (await import("@/lib/direct/__tests__/flag-switch")).mockFlag(importOriginal)
);
vi.mock("@/lib/direct/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/direct/store")>()),
  fetchDirectLot: lookup,
}));
vi.mock("@/lib/stripe/client", () => ({ createPaymentIntent: createPI }));
vi.mock("@/lib/reslab/get-lot", () => ({ getLotById }));
vi.mock("@/lib/reslab/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/reslab/client")>()),
  reslab: { getCost, getLocation },
}));
vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: async () => ({
    from: () => ({
      select: () => ({
        eq: (col: string, val: string) => {
          promoEq(col, val);
          return { single: promoSingle };
        },
      }),
    }),
  }),
}));
vi.mock("@/lib/sentry", () => ({ captureAPIError: vi.fn() }));
import { captureAPIError } from "@/lib/sentry";

import { GET, POST } from "../route";
import { directLotFromRow, type DirectLot } from "@/lib/direct/store";
import { directLotToUnified } from "@/lib/direct/adapter";
import { getAirportByCode } from "@/config/airports";
import { directLotRow } from "@/lib/direct/__tests__/fixtures";
import { flagSwitch } from "@/lib/direct/__tests__/flag-switch";

// Booking closed unless a test opens it (go-live behaviour is pinned explicitly).
afterEach(() => {
  flagSwitch.open = false;
});


const lot = (over: Record<string, unknown> = {}): DirectLot => {
  const out = directLotFromRow(directLotRow({ tax_rate_percent: 16, ...over }));
  if (!out.lot) throw new Error(out.reason);
  return out.lot;
};

function directBody(over: Record<string, unknown> = {}) {
  return {
    inventorySource: "direct",
    lotId: "direct-1",
    checkin: "2026-10-10",
    checkout: "2026-10-15",
    checkinTime: "10:00 AM",
    checkoutTime: "10:00 AM",
    customerEmail: "ada@example.com",
    protectionPlanCode: null,
    // checkout-form always sends the version it rendered (#150).
    termsVersion: TERMS_VERSION,
    ...over,
  };
}
const post = (body: unknown) =>
  POST(new NextRequest("http://localhost/api/checkout/lot", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }));

beforeEach(() => {
  vi.clearAllMocks();
  channel.data = [];
  channel.fails = false;
  // A lot missing from the list is read on its own: USD unless a test says otherwise.
  getLocation.mockImplementation(async (id: number) => ({ id, currency: { code: "USD" } }));
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-09T16:00:00Z")); // noon at JFK
  vi.stubEnv("NEXT_PUBLIC_APP_ENV", "staging");
  vi.stubEnv("DIRECT_CHECKOUT_PREVIEW", "true");
  lookup.mockResolvedValue({ status: "found", lot: lot() });
  createPI.mockResolvedValue({ id: "pi_direct", client_secret: "cs_direct" });
  promoSingle.mockResolvedValue({ data: USABLE_PROMO, error: null });
});

const USABLE_PROMO = { id: 1, discount_percent: 10, active: true, expires_at: null, max_uses: null, current_uses: 0 };
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("POST /api/checkout/lot — direct", () => {
  it("charges parking + 16 % tax + service fee ($63.66 for 5 days) and stamps the terms", async () => {
    const res = await post(directBody());
    expect(res.status).toBe(200);
    const [amount, meta] = createPI.mock.calls[0];
    expect(amount).toBe(63.66);
    expect(meta).toMatchObject({
      inventorySource: "direct",
      lotId: "direct-1",
      directLotId: "1",
      checkinTime: "10:00 AM",
      directRateCents: "995",
      directDays: "5",
      directSubtotalCents: "4975",
      directTaxCents: "796",
      directGrandTotalCents: "5771",
      directServiceFeeCents: "595",
      parkingOnlyChargeAmountCents: "6366",
      directTaxRatePercent: "16",
      directSurcharges: "small_suv:500,midsize_suv:700,large_suv_truck:1000",
    });
    const json = await res.json();
    expect(json).toMatchObject({ paymentIntentId: "pi_direct", verifiedDueNow: 63.66, dueAtLocation: 0, costsToken: null });
    expect(json.direct).toEqual({
      days: 5,
      taxRatePercent: 16,
      vehicleSurcharges: [
        { code: "small_suv", label: "Small SUV", dailyRateCents: 500 },
        { code: "midsize_suv", label: "Midsize SUV / minivan", dailyRateCents: 700 },
        { code: "large_suv_truck", label: "Large SUV / truck", dailyRateCents: 1000 },
      ],
    });
  });

  it("adds the Park Guard premium (Plan A) to the charge, never a surcharge", async () => {
    await post(directBody({ protectionPlanCode: "A" }));
    const [amount, meta] = createPI.mock.calls[0];
    expect(amount).toBe(76.65);
    expect(meta).toMatchObject({ protectionPlanCode: "A", parkingOnlyChargeAmountCents: "6366" });
  });

  it("applies a usable promo to the subtotal", async () => {
    await post(directBody({ promoCode: "TEN" }));
    const [amount, meta] = createPI.mock.calls[0];
    expect(amount).toBe(58.68); // 63.66 − 4.98
    expect(meta).toMatchObject({ promoCode: "TEN", discountPercent: "10", directDiscountCents: "498" });
  });

  it("stamps 'none' when the lot has no surcharges (never '', which Stripe drops) — same $63.66 charge", async () => {
    lookup.mockResolvedValue({ status: "found", lot: lot({ vehicle_surcharges: [] }) });
    await post(directBody());
    expect(createPI.mock.calls[0][0]).toBe(63.66);
    expect(createPI.mock.calls[0][1]).toHaveProperty("directSurcharges", "none");
  });

  it("is closed (503) without the preview flag, and in production even with it", async () => {
    vi.stubEnv("DIRECT_CHECKOUT_PREVIEW", "");
    expect((await post(directBody())).status).toBe(503);
    vi.stubEnv("DIRECT_CHECKOUT_PREVIEW", "true");
    vi.stubEnv("VERCEL_ENV", "production");
    expect((await post(directBody())).status).toBe(503);
    expect(createPI).not.toHaveBeenCalled();
  });

  // #150: the rendered terms version reaches createPaymentIntent (which stamps
  // only a known one). The .strict() schema must keep accepting it — dropping
  // it would 400 every direct checkout from the current bundle.
  it("passes the rendered terms version to createPaymentIntent; old and unknown tabs still pay", async () => {
    expect((await post(directBody())).status).toBe(200);
    expect(createPI.mock.calls[0][2]).toBe(TERMS_VERSION);
    const { termsVersion: _omit, ...oldTab } = directBody();
    void _omit;
    expect((await post(oldTab)).status).toBe(200); // a tab from before versioning
    expect(createPI.mock.calls[1][2]).toBeUndefined();
    expect((await post(directBody({ termsVersion: "2099-01-01" }))).status).toBe(200); // unknown: paid, not stamped
    expect(createPI.mock.calls[2][2]).toBe("2099-01-01");
    expect((await post(directBody({ termsVersion: "x".repeat(33) }))).status).toBe(400);
  });

  it("refuses client money or extra keys (.strict) and never creates a PaymentIntent", async () => {
    expect((await post(directBody({ subtotal: 1 }))).status).toBe(400);
    expect((await post(directBody({ vehicleSize: "large_suv_truck" }))).status).toBe(400);
    expect((await post(directBody({ lotId: "reslab-42" }))).status).toBe(400);
    expect(createPI).not.toHaveBeenCalled();
  });

  it("passes the quote's refusal through (inside the notice period → 400)", async () => {
    const res = await post(directBody({ checkin: "2026-10-09", checkinTime: "12:30 PM" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "inside_notice_period" });
    expect(createPI).not.toHaveBeenCalled();
  });
});

describe("POST /api/checkout/lot — ResLab body is unchanged except the explicit source", () => {
  it("stamps inventorySource: reslab", async () => {
    getCost.mockResolvedValue({
      costs_token: "tok",
      reservation: { sold_out: false, sub_total: 50, fees_total: 0, tax_total: 5, grand_total: 55, due_at_location: 0 },
    });
    const res = await post({
      lotId: "reslab-42",
      locationId: 42,
      checkin: "2026-10-10",
      checkout: "2026-10-15",
      checkinTime: "10:00 AM",
      checkoutTime: "10:00 AM",
      parkingTypeId: 7,
      customerEmail: "ada@example.com",
      protectionPlanCode: null,
      termsVersion: TERMS_VERSION,
    });
    expect(res.status).toBe(200);
    expect(createPI.mock.calls[0][1]).toMatchObject({ inventorySource: "reslab", locationId: "42" });
    expect(createPI.mock.calls[0][2]).toBe(TERMS_VERSION);
    expect(createPI.mock.calls[0][1]).not.toHaveProperty("directSurcharges");
  });

  it("a lot priced in CAD (our Canadian lots) is 404 before any ResLab call or PaymentIntent — the charge is USD", async () => {
    channel.data = [
      { id: 558, currency: { code: "CAD" } },
      { id: 42, currency: { code: "USD" } },
    ];
    const body = {
      lotId: "reslab-558",
      locationId: 558,
      checkin: "2026-12-02",
      checkout: "2026-12-05",
      checkinTime: "10:00 AM",
      checkoutTime: "10:00 AM",
      parkingTypeId: 7,
      customerEmail: "ada@example.com",
      protectionPlanCode: null,
    };
    expect((await post(body)).status).toBe(404);
    expect(getCost).not.toHaveBeenCalled();
    expect(createPI).not.toHaveBeenCalled();
    // A USD lot in the same list still prices.
    getCost.mockResolvedValue({
      costs_token: "tok",
      reservation: { sold_out: false, sub_total: 50, fees_total: 0, tax_total: 5, grand_total: 55, due_at_location: 0 },
    });
    expect((await post({ ...body, lotId: "reslab-42", locationId: 42 })).status).toBe(200);
  });

  it("fails closed: a lot missing from the list is read on its own; when neither answers → 503, no PaymentIntent (Codex)", async () => {
    const body = {
      lotId: "reslab-558",
      locationId: 558,
      checkin: "2026-12-02",
      checkout: "2026-12-05",
      checkinTime: "10:00 AM",
      checkoutTime: "10:00 AM",
      parkingTypeId: 7,
      customerEmail: "ada@example.com",
      protectionPlanCode: null,
    };
    // Missing from an incomplete list → the single read says CAD → 404.
    getLocation.mockResolvedValueOnce({ id: 558, currency: { code: "CAD" } });
    expect((await post(body)).status).toBe(404);
    // No list held AND the single read fails → 503 "try again", nothing charged.
    channel.fails = true;
    getLocation.mockRejectedValueOnce(new Error("ResLab 502"));
    const res = await post(body);
    expect(res.status).toBe(503);
    expect(getCost).not.toHaveBeenCalled();
    expect(createPI).not.toHaveBeenCalled();
    expect(vi.mocked(captureAPIError)).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ stage: "currency_check_unverified" })
    );
  });

  it("a hidden lot (blocked, or a ResLab test lot in production) is 404 before any ResLab call or PaymentIntent", async () => {
    const body = {
      lotId: "reslab-194",
      locationId: 194,
      checkin: "2026-10-10",
      checkout: "2026-10-15",
      checkinTime: "10:00 AM",
      checkoutTime: "10:00 AM",
      parkingTypeId: 7,
      customerEmail: "ada@example.com",
      protectionPlanCode: null,
    };
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "production");
    expect((await post(body)).status).toBe(404);
    expect((await post({ ...body, lotId: "reslab-416", locationId: 416 })).status).toBe(404);
    expect(getCost).not.toHaveBeenCalled();
    expect(createPI).not.toHaveBeenCalled();
    // staging (where test bookings are made) still prices lot 194
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "staging");
    getCost.mockResolvedValue({
      costs_token: "tok",
      reservation: { sold_out: false, sub_total: 50, fees_total: 0, tax_total: 5, grand_total: 55, due_at_location: 0 },
    });
    expect((await post(body)).status).toBe(200);
  });
});

describe("GET /api/checkout/lot — direct", () => {
  const get = () =>
    GET(new NextRequest("http://localhost/api/checkout/lot?lotId=direct-1&checkin=2026-10-10&checkout=2026-10-15&checkinTime=10:00%20AM&checkoutTime=10:00%20AM"));

  beforeEach(() => {
    getLotById.mockResolvedValue(
      directLotToUnified(lot(), getAirportByCode("JFK")!, { fromDate: "2026-10-10 10:00:00", toDate: "2026-10-15 10:00:00" })
    );
  });

  it("returns the same numbers POST charges, plus the vehicle terms", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const { costData } = await res.json();
    expect(costData).toMatchObject({
      costsToken: null,
      subtotal: 49.75,
      taxTotal: 7.96,
      serviceFee: 5.95,
      grandTotal: 57.71,
      dueAtLocation: 0,
      dueNow: 63.66,
      numberOfDays: 5,
      direct: { days: 5, taxRatePercent: 16 },
    });
    expect(costData.direct.vehicleSurcharges).toHaveLength(3);
  });

  it("is 503 direct_not_bookable_yet while checkout is closed", async () => {
    vi.stubEnv("DIRECT_CHECKOUT_PREVIEW", "");
    const res = await get();
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "direct_not_bookable_yet" });
  });

  it("go-live (DIRECT_BOOKING_OPEN): open in production with no preview flag", async () => {
    flagSwitch.open = true;
    vi.stubEnv("DIRECT_CHECKOUT_PREVIEW", "");
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "production");
    const prodLot = lot({ visibility: "production" });
    lookup.mockResolvedValue({ status: "found", lot: prodLot });
    getLotById.mockResolvedValue(
      directLotToUnified(prodLot, getAirportByCode("JFK")!, { fromDate: "2026-10-10 10:00:00", toDate: "2026-10-15 10:00:00" })
    );
    const res = await get();
    expect(res.status).toBe(200);
  });
});

describe("promo lookup (extracted helper) — both branches", () => {
  const reslabBody = (over: Record<string, unknown> = {}) => ({
    lotId: "reslab-42",
    locationId: 42,
    checkin: "2026-10-10",
    checkout: "2026-10-15",
    checkinTime: "10:00 AM",
    checkoutTime: "10:00 AM",
    parkingTypeId: 7,
    customerEmail: "ada@example.com",
    protectionPlanCode: null,
    ...over,
  });
  beforeEach(() => {
    getCost.mockResolvedValue({
      costs_token: "tok",
      reservation: { sold_out: false, sub_total: 50, fees_total: 0, tax_total: 5, grand_total: 55, due_at_location: 0 },
    });
  });

  it("ResLab: no promo → 55 + 5.95 = 60.95, metadata = the old keys + inventorySource only", async () => {
    await post(reslabBody());
    const [amount, meta] = createPI.mock.calls[0];
    expect(amount).toBe(60.95);
    expect(Object.keys(meta).sort()).toEqual(
      [
        "checkin",
        "checkinTime",
        "checkout",
        "checkoutTime",
        "customerEmail",
        "inventorySource",
        "locationId",
        "lotId",
        "parkingOnlyChargeAmount",
        "parkingOnlyChargeAmountCents",
        "parkingTypeId",
        "serviceFee",
        "verifiedTotal",
      ].sort()
    );
  });

  it("ResLab: a usable 10 % code (sent lowercase) → 55.95, looked up uppercase", async () => {
    await post(reslabBody({ promoCode: "ten" }));
    expect(promoEq).toHaveBeenCalledWith("code", "TEN");
    const [amount, meta] = createPI.mock.calls[0];
    expect(amount).toBe(55.95);
    expect(meta).toMatchObject({ discountPercent: "10" });
  });

  it.each([
    ["no such code (PGRST116)", { data: null, error: { code: "PGRST116", message: "no rows" } }, false],
    ["a Supabase error", { data: null, error: { code: "57014", message: "timeout" } }, true],
    ["an inactive code", { data: { ...USABLE_PROMO, active: false }, error: null }, false],
    ["an expired code", { data: { ...USABLE_PROMO, expires_at: "2020-01-01T00:00:00Z" }, error: null }, false],
    ["a used-up code", { data: { ...USABLE_PROMO, max_uses: 1, current_uses: 1 }, error: null }, false],
  ])("%s → full price on BOTH branches (captured only for a real error)", async (_n, result, captured) => {
    promoSingle.mockResolvedValue(result);
    await post(reslabBody({ promoCode: "X" }));
    expect(createPI.mock.calls[0][0]).toBe(60.95);
    expect(createPI.mock.calls[0][1]).not.toHaveProperty("discountPercent");
    await post(directBody({ promoCode: "X" }));
    expect(createPI.mock.calls[1][0]).toBe(63.66);
    expect(createPI.mock.calls[1][1]).toMatchObject({ directDiscountCents: "0" });
    expect(vi.mocked(captureAPIError).mock.calls.length).toBe(captured ? 2 : 0);
  });
});

describe("direct: Park Guard + promo combinations", () => {
  it.each([
    ["B", 71.65],
    ["C", 68.61],
  ])("Plan %s → %s", async (code, amount) => {
    await post(directBody({ protectionPlanCode: code }));
    expect(createPI.mock.calls[0][0]).toBe(amount);
    expect(createPI.mock.calls[0][1]).toMatchObject({ parkingOnlyChargeAmountCents: "6366" });
  });

  it("10 % promo + Plan A → 58.68 + 12.99 = 71.67, baseline 5868 (what update-pi recomputes from)", async () => {
    await post(directBody({ promoCode: "TEN", protectionPlanCode: "A" }));
    expect(createPI.mock.calls[0][0]).toBe(71.67);
    expect(createPI.mock.calls[0][1]).toMatchObject({ parkingOnlyChargeAmountCents: "5868" });
  });

  it("a 100 % promo still charges tax + fee (13.91) — never a premium-only PaymentIntent", async () => {
    promoSingle.mockResolvedValue({ data: { ...USABLE_PROMO, discount_percent: 100 }, error: null });
    await post(directBody({ promoCode: "FREE" }));
    expect(createPI.mock.calls[0][0]).toBe(13.91);
  });
});

describe("GET direct — refusals pass through, uncached; production guard", () => {
  const get = () =>
    GET(new NextRequest("http://localhost/api/checkout/lot?lotId=direct-1&checkin=2026-10-10&checkout=2026-10-15&checkinTime=10:00%20AM&checkoutTime=10:00%20AM"));
  beforeEach(() => {
    getLotById.mockResolvedValue(
      directLotToUnified(lot(), getAirportByCode("JFK")!, { fromDate: "2026-10-10 10:00:00", toDate: "2026-10-15 10:00:00" })
    );
  });

  it("unreadable lot → 503 direct_unavailable, no-store", async () => {
    lookup.mockResolvedValue({ status: "unavailable", kind: "timeout", message: "x" });
    const res = await get();
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toMatchObject({ code: "direct_unavailable" });
  });

  it("not found → 404", async () => {
    lookup.mockResolvedValue({ status: "not_found" });
    expect((await get()).status).toBe(404);
  });

  it.each([{ VERCEL_ENV: "production" }, { NEXT_PUBLIC_APP_ENV: "production" }])(
    "production (%o) with the preview flag on → 503 direct_not_bookable_yet, lot never read",
    async (envs) => {
      for (const [k, v] of Object.entries(envs)) vi.stubEnv(k, v);
      const res = await get();
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ code: "direct_not_bookable_yet" });
      expect(lookup).not.toHaveBeenCalled();
    }
  );
});

describe("POST direct — production guard asserts the CODE, not just 503", () => {
  it.each([{ VERCEL_ENV: "production" }, { NEXT_PUBLIC_APP_ENV: "production" }])("%o", async (envs) => {
    for (const [k, v] of Object.entries(envs)) vi.stubEnv(k, v);
    const res = await post(directBody());
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "direct_not_bookable_yet" });
    expect(lookup).not.toHaveBeenCalled();
  });
});
