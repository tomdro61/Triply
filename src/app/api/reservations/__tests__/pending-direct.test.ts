/**
 * /api/reservations/pending — DIRECT branch, Phase 3 (plan A-29 / A-31;
 * vehicle-surcharge plan §1.5, R5, R9). Validates and binds everything to the
 * PaymentIntent, then refuses 503 BEFORE any write until DIRECT_ENGINE_READY:
 * no direct pending row can exist yet, so Pay fails closed with no charge.
 * Cross-source both ways: a ResLab body cannot bind to a direct PaymentIntent
 * and vice versa.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";

const { db, stripeMock } = await vi.hoisted(async () => {
  const { FakeSupabase } = await import("@/lib/booking/__tests__/supabase-fake");
  return { db: new FakeSupabase(), stripeMock: { paymentIntents: { retrieve: vi.fn() } } };
});

vi.mock("@/lib/supabase/server", () => ({ createAdminClient: async () => db }));
vi.mock("@/lib/stripe/client", () => ({ stripe: stripeMock }));
vi.mock("@/lib/reslab/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/reslab/client")>()),
  reslab: { getLocation: vi.fn().mockResolvedValue({ id: 42, extra_fields: [] }) },
}));
vi.mock("@/lib/sentry", () => ({
  capturePaymentError: vi.fn(),
  captureBookingError: vi.fn(),
  captureRequiredFieldCheck: vi.fn(),
}));

import { POST } from "../pending/route";
import { capturePaymentError } from "@/lib/sentry";
import { getProtectionPlan, protectionMetadataPatch } from "@/lib/parkguard/plans";
import { encodeSurchargeRates } from "@/lib/direct/vehicle-surcharge-metadata";

/** What Stripe stores: a key sent with an empty value is UNSET (also on create). */
const asStripeStores = (meta: Record<string, string>) =>
  Object.fromEntries(Object.entries(meta).filter(([, v]) => v !== ""));

const PI = "pi_direct_pending";
const DIRECT_META = {
  inventorySource: "direct",
  lotId: "direct-1",
  directLotId: "1",
  customerEmail: "ada@example.com",
  checkin: "2026-10-10",
  checkinTime: "10:00 AM",
  checkout: "2026-10-15",
  checkoutTime: "10:00 AM",
  directDays: "5",
  directTaxRatePercent: "16",
  directSurcharges: "small_suv:500,midsize_suv:700,large_suv_truck:1000",
};

function directBody(over: Record<string, unknown> = {}) {
  return {
    inventorySource: "direct",
    lotId: "direct-1",
    fromDate: "2026-10-10 10:00:00",
    toDate: "2026-10-15 10:00:00",
    customer: { firstName: "Ada", lastName: "L", email: "ada@example.com", phone: "555" },
    vehicle: { make: "Ford", model: "F-150", color: "Black", licensePlate: "ABC", state: "NY" },
    stripePaymentIntentId: PI,
    protectionPlanCode: null,
    vehicleSize: "large_suv_truck",
    vehicleSizeSource: "modal",
    ...over,
  };
}
const post = (body: unknown) =>
  POST(new NextRequest("http://localhost/api/reservations/pending", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }));
const withMeta = (meta: Record<string, string | undefined>) =>
  stripeMock.paymentIntents.retrieve.mockResolvedValue({ id: PI, amount: 6366, livemode: false, metadata: meta });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("DIRECT_CHECKOUT_PREVIEW", "true");
  vi.stubEnv("NEXT_PUBLIC_APP_ENV", "staging"); // the flag is honoured on an allowlist only
  db.tables = { pending_bookings: [], bookings: [] };
  db.log = [];
  withMeta(DIRECT_META);
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /api/reservations/pending — direct (Phase 3)", () => {
  it("a fully valid large-SUV booking is refused 503 BEFORE any write (A-31: Pay fails closed)", async () => {
    const res = await post(directBody());
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "direct_not_bookable_yet" });
    expect(db.tables.pending_bookings).toHaveLength(0);
    expect(capturePaymentError).not.toHaveBeenCalled();
  });

  it("'none' is equally valid (and equally refused before the write)", async () => {
    expect((await post(directBody({ vehicleSize: "none" }))).status).toBe(503);
  });

  it("closed checkout: 503 before even reading the PaymentIntent", async () => {
    vi.stubEnv("DIRECT_CHECKOUT_PREVIEW", "");
    expect((await post(directBody())).status).toBe(503);
    expect(stripeMock.paymentIntents.retrieve).not.toHaveBeenCalled();
  });

  it("a size this payment was not priced with → 400 'choose your vehicle size again'", async () => {
    const res = await post(directBody({ vehicleSize: "bus" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "unknown_vehicle_size" });
  });

  it("missing surcharge terms on the PaymentIntent → 400 + Sentry, never 'no surcharge'", async () => {
    withMeta({ ...DIRECT_META, directSurcharges: undefined });
    const res = await post(directBody({ vehicleSize: "none" }));
    expect(res.status).toBe(400);
    expect(capturePaymentError).toHaveBeenCalledTimes(1);
  });

  it("client cents / money / location fields are refused (.strict, B10)", async () => {
    for (const extra of [{ vehicleSurchargeCents: 0 }, { subtotal: 1 }, { locationId: 42 }, { grandTotal: 1 }]) {
      expect((await post(directBody(extra))).status).toBe(400);
    }
    expect((await post(directBody({ vehicleSize: undefined }))).status).toBe(400);
    expect((await post(directBody({ vehicleSizeSource: "url" }))).status).toBe(400);
    expect(stripeMock.paymentIntents.retrieve).not.toHaveBeenCalled();
  });

  it.each([
    ["another lot", { lotId: "direct-2" }],
    ["another email", { customer: { firstName: "A", lastName: "L", email: "eve@example.com", phone: "5" } }],
    ["a different drop-off time", { fromDate: "2026-10-10 22:00:00" }],
    ["a different pick-up date", { toDate: "2026-10-16 10:00:00" }],
  ])("a body for %s does not bind to this payment → 400", async (_n, over) => {
    expect((await post(directBody(over))).status).toBe(400);
    expect(capturePaymentError).toHaveBeenCalled();
  });

  it("protection must match what the payment holds", async () => {
    expect((await post(directBody({ protectionPlanCode: "A" }))).status).toBe(400);
  });

  it("cross-source: a DIRECT body cannot bind to a ResLab PaymentIntent", async () => {
    withMeta({ customerEmail: "ada@example.com", locationId: "42", inventorySource: "reslab" });
    expect((await post(directBody())).status).toBe(400);
    withMeta({ customerEmail: "ada@example.com", locationId: "42" }); // pre-release ResLab PI, no source key
    expect((await post(directBody())).status).toBe(400);
  });

  it("cross-source: a RESLAB body cannot bind to a direct PaymentIntent (none of its keys would be checked)", async () => {
    const res = await post({
      locationId: 42,
      costsToken: "tok",
      fromDate: "2026-10-10 10:00:00",
      toDate: "2026-10-15 10:00:00",
      parkingTypeId: 7,
      customer: { firstName: "Ada", lastName: "L", email: "ada@example.com", phone: "555" },
      vehicle: { make: "Ford", model: "F-150", color: "Black", licensePlate: "ABC", state: "NY" },
      stripePaymentIntentId: PI,
      protectionPlanCode: null,
    });
    expect(res.status).toBe(400);
    expect(db.tables.pending_bookings).toHaveLength(0);
  });
});

describe("POST /api/reservations/pending — direct, more binding cases", () => {
  it.each(["A", "B", "C"] as const)("Plan %s on the payment + the same in the body binds (→ 503, nothing captured)", async (code) => {
    withMeta({ ...DIRECT_META, ...protectionMetadataPatch(getProtectionPlan(code)!) });
    const res = await post(directBody({ protectionPlanCode: code }));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "direct_not_bookable_yet" });
    expect(capturePaymentError).not.toHaveBeenCalled();
  });

  it("half a protection pair on the payment → 400 + Sentry", async () => {
    withMeta({ ...DIRECT_META, protectionPlanCode: "A" });
    expect((await post(directBody({ protectionPlanCode: "A" }))).status).toBe(400);
    expect(capturePaymentError).toHaveBeenCalled();
  });

  it("a lot with NO surcharges survives Stripe: 'none' is stored, binds, 503 (not a false integrity error)", async () => {
    withMeta(asStripeStores({ ...DIRECT_META, directSurcharges: encodeSurchargeRates([]) }));
    const res = await post(directBody({ vehicleSize: "none" }));
    expect(res.status).toBe(503);
    expect(capturePaymentError).not.toHaveBeenCalled();
  });

  it("…and the old '' marker WOULD have been dropped by Stripe and refused (why it is not used)", async () => {
    withMeta(asStripeStores({ ...DIRECT_META, directSurcharges: "" }));
    expect((await post(directBody({ vehicleSize: "none" }))).status).toBe(400);
  });

  it("email binds case-insensitively", async () => {
    const res = await post(directBody({ customer: { firstName: "Ada", lastName: "L", email: "Ada@Example.COM", phone: "555" } }));
    expect(res.status).toBe(503);
  });

  it.each(["customerEmail", "checkinTime", "checkoutTime", "checkin", "checkout", "lotId"])(
    "a payment missing %s → 400",
    async (key) => {
      withMeta({ ...DIRECT_META, [key]: undefined });
      expect((await post(directBody())).status).toBe(400);
    }
  );

  it.each([
    ["12:30 AM", "2026-10-10 00:30:00", 503],
    ["12:00 PM", "2026-10-10 12:00:00", 503],
    ["12:30 AM", "2026-10-10 12:30:00", 400],
  ])("meta %s vs body %s → %s (literal wall-clock compare)", async (metaTime, fromDate, status) => {
    withMeta({ ...DIRECT_META, checkinTime: metaTime });
    expect((await post(directBody({ fromDate }))).status).toBe(status);
  });

  it("cross-source is refused on inventorySource ALONE (every other key matches)", async () => {
    withMeta({ ...DIRECT_META, inventorySource: "reslab" });
    expect((await post(directBody())).status).toBe(400);
    expect(String(vi.mocked(capturePaymentError).mock.calls[0][0])).toMatch(/: inventorySource$/);
    vi.clearAllMocks();
    withMeta({ ...DIRECT_META, inventorySource: undefined });
    expect((await post(directBody())).status).toBe(400);
    expect(String(vi.mocked(capturePaymentError).mock.calls[0][0])).toMatch(/: inventorySource$/);
  });

  it.each([{ VERCEL_ENV: "production" }, { NEXT_PUBLIC_APP_ENV: "production" }])(
    "production (%o) with the preview flag on → 503 before the PaymentIntent is read",
    async (envs) => {
      for (const [k, v] of Object.entries(envs)) vi.stubEnv(k, v);
      const res = await post(directBody());
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ code: "direct_not_bookable_yet" });
      expect(stripeMock.paymentIntents.retrieve).not.toHaveBeenCalled();
    }
  );
});
