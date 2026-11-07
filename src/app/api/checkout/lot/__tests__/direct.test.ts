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
          const query = { abortSignal: () => query, maybeSingle: () => promoSingle(val) };
          return query;
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
import { readDirectMetadataMoney } from "@/lib/direct/metadata-money";
import { checkStampAgainstCharge, readStampedDiscount } from "@/lib/promo/stamped-discount";

/** The stamp the POST wrote — the test fails if it wrote none. */
const presentStamp = (meta: Record<string, string>) => {
  const stamped = readStampedDiscount(meta);
  if (stamped.kind === "absent") throw new Error("no discountCents stamped");
  return stamped;
};

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
  // The row for whatever code is looked up: a usable 10 % code.
  promoSingle.mockImplementation(async (code: string) => ({ data: { ...USABLE_PROMO, code }, error: null }));
});

const USABLE_PROMO = { code: "TEN", discount_percent: 10, discount_amount: null, min_subtotal: null, active: true, expires_at: null, max_uses: null, current_uses: 0 };
// A fixed $5 code with a $25 minimum, as migration 049 stores it (DECIMAL → string).
const FIXED_PROMO = { ...USABLE_PROMO, code: "JFK5", discount_percent: null, discount_amount: "5.00", min_subtotal: "25.00" };
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

  it("applies a usable promo to the subtotal and stamps the discount with checkout's figures — which the direct reader accepts", async () => {
    const res = await post(directBody({ promoCode: "TEN" }));
    const [amount, meta] = createPI.mock.calls[0];
    expect(amount).toBe(58.68); // 63.66 − 4.98
    expect(meta).toMatchObject({
      promoCode: "TEN",
      discountPercent: "10",
      directDiscountCents: "498",
      discountCents: "498",
      onlineParkingCents: "5771", // the whole grand total is paid online
      preDiscountOnlineCents: "6366",
      parkingOnlyChargeAmountCents: "5868",
    });
    expect(await res.json()).toMatchObject({ chargeCents: 5868, promo: { code: "TEN", kind: "percent", appliedCents: 498 }, discountPercent: 10 });
    expect(readDirectMetadataMoney(meta, 5868)).toMatchObject({ ok: true, money: { discountCents: 498, chargeCents: 5868 } });
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

  /** The ResLab stamp must pass the reader the pending route and Step 8 run. */
  const passesReader = (meta: Record<string, string>, amountCents: number) =>
    checkStampAgainstCharge(meta, presentStamp(meta), { premiumCents: 0, piAmountCents: amountCents });

  it("ResLab: a usable 10 % code (sent lowercase) → 55.95, looked up normalised; the stamp passes the reader", async () => {
    const res = await post(reslabBody({ promoCode: " ten " }));
    expect(promoEq).toHaveBeenCalledWith("code", "TEN");
    const [amount, meta] = createPI.mock.calls[0];
    expect(amount).toBe(55.95);
    // Parking online 55.00 + fee 5.95 = 60.95 before the 5.00 off.
    expect(meta).toMatchObject({
      promoCode: "TEN",
      discountPercent: "10",
      discountCents: "500",
      onlineParkingCents: "5500",
      preDiscountOnlineCents: "6095",
      parkingOnlyChargeAmountCents: "5595",
      serviceFee: "5.95",
    });
    expect(await res.json()).toMatchObject({ chargeCents: 5595, verifiedDueNow: 55.95, promo: { code: "TEN", kind: "percent", appliedCents: 500 } });
    expect(passesReader(meta, 5595)).toMatchObject({ ok: true, cents: 500 });
  });

  it.each([
    ["no such code", { data: null, error: null }, "unknown"],
    ["an inactive code", { data: { ...USABLE_PROMO, code: "X", active: false }, error: null }, "inactive"],
    ["an expired code", { data: { ...USABLE_PROMO, code: "X", expires_at: "2020-01-01T00:00:00Z" }, error: null }, "expired"],
    ["a used-up code", { data: { ...USABLE_PROMO, code: "X", max_uses: 1, current_uses: 1 }, error: null }, "used_up"],
  ])("%s → full price on BOTH branches, NOTHING stamped (not even the code), the reason returned", async (_n, result, reason) => {
    promoSingle.mockResolvedValue(result);
    const reslabRes = await post(reslabBody({ promoCode: "X" }));
    expect(createPI.mock.calls[0][0]).toBe(60.95);
    for (const key of ["promoCode", "discountPercent", "discountCents", "onlineParkingCents", "preDiscountOnlineCents"]) {
      expect(createPI.mock.calls[0][1]).not.toHaveProperty(key);
    }
    expect(await reslabRes.json()).toMatchObject({ promo: { code: "X", refused: reason, message: expect.any(String) }, discountPercent: 0 });
    await post(directBody({ promoCode: "X" }));
    expect(createPI.mock.calls[1][0]).toBe(63.66);
    expect(createPI.mock.calls[1][1]).toMatchObject({ directDiscountCents: "0" });
    expect(createPI.mock.calls[1][1]).not.toHaveProperty("promoCode");
    expect(captureAPIError).not.toHaveBeenCalled();
  });

  it("a FAILED lookup → 503 on BOTH branches, NO PaymentIntent (it used to charge full price silently), reported", async () => {
    promoSingle.mockResolvedValue({ data: null, error: { code: "57014", message: "timeout" } });
    for (const body of [reslabBody({ promoCode: "TEN" }), directBody({ promoCode: "TEN" })]) {
      const res = await post(body);
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ code: "promo_lookup_unavailable" });
    }
    expect(createPI).not.toHaveBeenCalled();
    // Looked up before the price: no ResLab call is spent either.
    expect(getCost).not.toHaveBeenCalled();
    expect(vi.mocked(captureAPIError).mock.calls.filter(([, ctx]) => ctx.stage === "promo_lookup")).toHaveLength(2);
  });

  it("a malformed promo row → refused as not available, full price, reported", async () => {
    promoSingle.mockResolvedValue({ data: { ...FIXED_PROMO, discount_percent: 10 }, error: null }); // both kinds
    vi.stubEnv("PROMO_FIXED_ENABLED", "true");
    const res = await post(reslabBody({ promoCode: "JFK5" }));
    expect(createPI.mock.calls[0][0]).toBe(60.95);
    expect(await res.json()).toMatchObject({ promo: { refused: "not_available" } });
    expect(vi.mocked(captureAPIError).mock.calls.filter(([, ctx]) => ctx.stage === "promo_row_malformed")).toHaveLength(1);
  });

  describe("a fixed $5 code (JFK5, $25 minimum)", () => {
    beforeEach(() => {
      promoSingle.mockResolvedValue({ data: FIXED_PROMO, error: null });
    });

    it("kill switch OFF (PROMO_FIXED_ENABLED unset): not available on BOTH branches — full price, nothing stamped", async () => {
      const res = await post(reslabBody({ promoCode: "JFK5" }));
      expect(createPI.mock.calls[0][0]).toBe(60.95);
      expect(createPI.mock.calls[0][1]).not.toHaveProperty("discountCents");
      expect(await res.json()).toMatchObject({ promo: { code: "JFK5", refused: "not_available" } });
      await post(directBody({ promoCode: "JFK5" }));
      expect(createPI.mock.calls[1][0]).toBe(63.66);
    });

    describe("kill switch ON", () => {
      beforeEach(() => {
        vi.stubEnv("PROMO_FIXED_ENABLED", "true");
      });

      it("ResLab: $5 off the parking, the fee untouched (60.95 → 55.95); stamped without a percent; passes the reader", async () => {
        const res = await post(reslabBody({ promoCode: "jfk5" }));
        const [amount, meta] = createPI.mock.calls[0];
        expect(amount).toBe(55.95);
        expect(meta).toMatchObject({ promoCode: "JFK5", discountCents: "500", onlineParkingCents: "5500", preDiscountOnlineCents: "6095" });
        expect(meta).not.toHaveProperty("discountPercent");
        expect(await res.json()).toMatchObject({ chargeCents: 5595, promo: { code: "JFK5", kind: "fixed", appliedCents: 500 }, discountPercent: 0 });
        expect(passesReader(meta, 5595)).toMatchObject({ ok: true, cents: 500 });
      });

      it("direct: $5 off (63.66 → 58.66); the direct reader accepts it", async () => {
        const res = await post(directBody({ promoCode: "JFK5" }));
        const [amount, meta] = createPI.mock.calls[0];
        expect(amount).toBe(58.66);
        expect(meta).toMatchObject({ discountCents: "500", directDiscountCents: "500", onlineParkingCents: "5771", preDiscountOnlineCents: "6366" });
        expect(await res.json()).toMatchObject({ chargeCents: 5866, promo: { kind: "fixed", appliedCents: 500 } });
        expect(readDirectMetadataMoney(meta, 5866)).toMatchObject({ ok: true, money: { discountCents: 500 } });
      });

      it("+ Plan A: the premium adds on top of the discounted parking; chargeCents is the PaymentIntent amount", async () => {
        const res = await post(reslabBody({ promoCode: "JFK5", protectionPlanCode: "A" }));
        const [amount, meta] = createPI.mock.calls[0];
        expect(amount).toBe(68.94); // 55.95 + 12.99
        expect(meta).toMatchObject({ parkingOnlyChargeAmountCents: "5595", protectionPlanCode: "A" });
        expect((await res.json()).chargeCents).toBe(6894);
        expect(checkStampAgainstCharge(meta, presentStamp(meta), { premiumCents: 1299, piAmountCents: 6894 })).toMatchObject({ ok: true });
      });

      it("below the $25 minimum: refused with the reason, full price, nothing stamped", async () => {
        getCost.mockResolvedValue({
          costs_token: "tok",
          reservation: { sold_out: false, sub_total: 20, fees_total: 4.99, tax_total: 2, grand_total: 26.99, due_at_location: 0 },
        });
        const res = await post(reslabBody({ promoCode: "JFK5" }));
        expect(createPI.mock.calls[0][1]).not.toHaveProperty("discountCents");
        expect(await res.json()).toMatchObject({
          promo: { code: "JFK5", refused: "below_minimum", message: "This code needs at least $25 of parking." },
        });
      });

      it("pay-at-the-lot (only $3.00 of parking online): refused — the $5 would come out of the service fee (D1)", async () => {
        getCost.mockResolvedValue({
          costs_token: "tok",
          reservation: { sold_out: false, sub_total: 50, fees_total: 0, tax_total: 5, grand_total: 55, due_at_location: 52 },
        });
        const res = await post(reslabBody({ promoCode: "JFK5" }));
        expect(createPI.mock.calls[0][0]).toBe(8.95); // 3.00 online + the 5.95 fee, whole
        expect(await res.json()).toMatchObject({ promo: { refused: "not_applicable", message: "This code isn't valid for pay-at-the-lot bookings." } });
      });
    });
  });

  it("a percent code on a pay-at-the-lot booking is capped at the online parking — never out of the fee (bug 6)", async () => {
    // 10 % of the 50.00 sub_total = 5.00, but only 3.00 of parking is paid online.
    getCost.mockResolvedValue({
      costs_token: "tok",
      reservation: { sold_out: false, sub_total: 50, fees_total: 0, tax_total: 5, grand_total: 55, due_at_location: 52 },
    });
    await post(reslabBody({ promoCode: "TEN" }));
    const [amount, meta] = createPI.mock.calls[0];
    expect(amount).toBe(5.95); // the fee, whole
    expect(meta).toMatchObject({ discountCents: "300", onlineParkingCents: "300", preDiscountOnlineCents: "895" });
    expect(passesReader(meta, 595)).toMatchObject({ ok: true });
  });

  it("an unusable ResLab price (NaN) → 503, no PaymentIntent, reported", async () => {
    getCost.mockResolvedValue({
      costs_token: "tok",
      reservation: { sold_out: false, sub_total: 50, fees_total: 0, tax_total: 5, grand_total: Number.NaN, due_at_location: 0 },
    });
    expect((await post(reslabBody())).status).toBe(503);
    expect(createPI).not.toHaveBeenCalled();
    expect(vi.mocked(captureAPIError).mock.calls.filter(([, ctx]) => ctx.stage === "cost_unusable")).toHaveLength(1);
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
    promoSingle.mockResolvedValue({ data: { ...USABLE_PROMO, code: "FREE", discount_percent: 100 }, error: null });
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
