import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";

const { db, capturePaymentError, retrieve, createBooking } = await vi.hoisted(async () => {
  const { FakeSupabase } = await import("@/lib/booking/__tests__/supabase-fake");
  return {
    db: new FakeSupabase(),
    capturePaymentError: vi.fn(),
    retrieve: vi.fn(),
    createBooking: vi.fn(),
  };
});

vi.mock("@/lib/supabase/server", () => ({ createAdminClient: async () => db }));
vi.mock("@/lib/stripe/client", () => ({ stripe: { paymentIntents: { retrieve, cancel: vi.fn() } } }));
vi.mock("@/lib/booking/create-booking", () => ({ createBooking }));
vi.mock("@/lib/sentry", () => ({ capturePaymentError }));

import { GET } from "../route";

const CRON_SECRET = process.env.CRON_SECRET as string;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const HOUR = 3_600_000;

function req() {
  return new NextRequest("https://www.triplypro.com/api/cron/sweep-pending-bookings", {
    headers: { authorization: `Bearer ${CRON_SECRET}` },
  });
}

/** A staging (Stripe TEST) row as the production sweep sees it: opposite mode. */
function stagingRow(over: Record<string, unknown>) {
  const created = (over.created_at as string | undefined) ?? ago(2 * HOUR);
  return {
    stripe_payment_intent_id: "pi_x",
    status: "pending",
    livemode: false,
    reslab_reservation_number: null,
    last_error: null,
    created_at: created,
    updated_at: created,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Production: crons run only there, with the LIVE key.
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_live_dummy_for_unit_tests");
  db.tables = { pending_bookings: [], cart_claims: [], bookings: [], customers: [] };
  db.log = [];
  db.clearFailures();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /api/cron/sweep-pending-bookings — opposite-mode cleanup (plan 4b §9 M-G)", () => {
  it("expires abandoned staging rows with no reservation number, but never one with a recorded number — those are reported", async () => {
    db.seed("pending_bookings", [
      stagingRow({ stripe_payment_intent_id: "pi_abandoned", status: "pending" }),
      stagingRow({ stripe_payment_intent_id: "pi_direct_mid", status: "processing", reslab_reservation_number: "TRP-7K2M9QXA" }),
      stagingRow({ stripe_payment_intent_id: "pi_reslab_mid", status: "processing", reslab_reservation_number: "RTL854206" }),
      stagingRow({ stripe_payment_intent_id: "pi_young", status: "pending", created_at: ago(10 * 60_000) }),
      stagingRow({ stripe_payment_intent_id: "pi_young_mid", status: "processing", reslab_reservation_number: "TRP-ABCDEFGH", created_at: ago(10 * 60_000) }),
      stagingRow({ stripe_payment_intent_id: "pi_done", status: "completed", reslab_reservation_number: "RTL1" }),
    ]);
    db.seed("cart_claims", [
      { cart_key: "k1", stripe_payment_intent_id: "pi_abandoned", released_at: null, livemode: false },
      { cart_key: "k2", stripe_payment_intent_id: "pi_direct_mid", released_at: null, livemode: false },
    ]);

    const res = await GET(req());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, livemode: true, crossModeHeld: 2, scanned: 0 });

    const status = (pi: string) => db.tables.pending_bookings.find((r) => r.stripe_payment_intent_id === pi)?.status;
    expect(status("pi_abandoned")).toBe("expired");
    // an authorized booking mid-fulfilment is NEVER expired blind
    expect(status("pi_direct_mid")).toBe("processing");
    expect(status("pi_reslab_mid")).toBe("processing");
    expect(status("pi_young")).toBe("pending");
    expect(status("pi_young_mid")).toBe("processing");
    expect(status("pi_done")).toBe("completed");

    // only the expired row's cart claim is released
    const claim = (pi: string) => db.tables.cart_claims.find((r) => r.stripe_payment_intent_id === pi);
    expect(claim("pi_abandoned")?.released_at).not.toBeNull();
    expect(claim("pi_direct_mid")?.released_at).toBeNull();

    // each held row is reported once, by PaymentIntent, naming its number; the young one is not
    const reported = capturePaymentError.mock.calls.map(([err, ctx]) => ({ msg: (err as Error).message, pi: (ctx as { stripePaymentIntentId?: string }).stripePaymentIntentId }));
    expect(reported.map((r) => r.pi).sort()).toEqual(["pi_direct_mid", "pi_reslab_mid"]);
    expect(reported.find((r) => r.pi === "pi_direct_mid")!.msg).toMatch(/TRP-7K2M9QXA recorded but is still processing.*NOT expired.*staging \(Stripe TEST\)/);
    // no Stripe call is possible (wrong-mode key) and none is made
    expect(retrieve).not.toHaveBeenCalled();
    expect(createBooking).not.toHaveBeenCalled();
  });

  it("the held-row check failing is reported and does not stop the primary sweep or expire anything extra", async () => {
    db.seed("pending_bookings", [
      stagingRow({ stripe_payment_intent_id: "pi_direct_mid", status: "processing", reslab_reservation_number: "TRP-7K2M9QXA" }),
    ]);
    // the first SELECT is the held-row check (the cleanup before it is an UPDATE)
    db.failOnce("pending_bookings", "select", "connection reset");
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect((await res.json()).crossModeHeld).toBe(0);
    expect(db.tables.pending_bookings[0].status).toBe("processing");
    expect(capturePaymentError.mock.calls.map(([e]) => (e as Error).message)).toEqual([
      expect.stringMatching(/opposite-mode held-row check failed: connection reset/),
    ]);
  });

  it("the same-mode (live) scan is untouched: a live row is never caught by the opposite-mode cleanup", async () => {
    db.seed("pending_bookings", [
      { ...stagingRow({ stripe_payment_intent_id: "pi_live", status: "processing", reslab_reservation_number: "RTL9" }), livemode: true },
    ]);
    retrieve.mockResolvedValue({ id: "pi_live", status: "requires_payment_method", amount: 1000 });
    const res = await GET(req());
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, crossModeHeld: 0, scanned: 1, skipped: 1 });
    expect(db.tables.pending_bookings[0].status).toBe("processing");
    expect(capturePaymentError).not.toHaveBeenCalled();
  });
});
