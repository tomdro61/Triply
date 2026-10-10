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

describe("GET /api/cron/sweep-pending-bookings — held opposite-mode rows are reported ONCE", () => {
  const heldPis = () => capturePaymentError.mock.calls.map(([, ctx]) => (ctx as { stripePaymentIntentId?: string }).stripePaymentIntentId);

  it("reports a held row on the first tick, stamps it (keeping the prior error), and stays quiet after", async () => {
    db.seed("pending_bookings", [
      stagingRow({ stripe_payment_intent_id: "pi_held", status: "processing", reslab_reservation_number: "TRP-7K2M9QXA", last_error: "capture failed: card_declined" }),
      stagingRow({ stripe_payment_intent_id: "pi_held_null", status: "pending", reslab_reservation_number: "RTL854206" }),
    ]);

    const first = await (await GET(req())).json();
    expect(first).toMatchObject({ ok: true, crossModeHeld: 2, crossModeHeldUnmarked: 0 });
    expect(heldPis().sort()).toEqual(["pi_held", "pi_held_null"]);

    const row = (pi: string) => db.tables.pending_bookings.find((r) => r.stripe_payment_intent_id === pi)!;
    expect(row("pi_held").last_error).toMatch(/^held-cross-mode-reported \d{4}-\d{2}-\d{2}T\S+ \| prior: capture failed: card_declined$/);
    expect(row("pi_held_null").last_error).toMatch(/^held-cross-mode-reported \d{4}-\d{2}-\d{2}T\S+$/);
    // booking state untouched
    expect(row("pi_held").status).toBe("processing");
    expect(row("pi_held_null").status).toBe("pending");

    capturePaymentError.mockClear();
    for (let tick = 0; tick < 3; tick++) {
      const again = await (await GET(req())).json();
      expect(again).toMatchObject({ ok: true, crossModeHeld: 0 });
    }
    expect(capturePaymentError).not.toHaveBeenCalled();
  });

  it("a row the other environment re-touches (last_error rewritten) is reported again", async () => {
    db.seed("pending_bookings", [
      stagingRow({ stripe_payment_intent_id: "pi_held", status: "processing", reslab_reservation_number: "TRP-7K2M9QXA" }),
    ]);
    await GET(req());
    db.tables.pending_bookings[0].last_error = "capture failed again: timeout";
    capturePaymentError.mockClear();
    const body = await (await GET(req())).json();
    expect(body.crossModeHeld).toBe(1);
    expect(heldPis()).toEqual(["pi_held"]);
  });

  it("orders newest first, so a fresh row is never starved behind the per-run cap", async () => {
    const rows = Array.from({ length: 26 }, (_, i) =>
      stagingRow({
        stripe_payment_intent_id: `pi_old_${String(i).padStart(2, "0")}`,
        status: "processing",
        reslab_reservation_number: `RTL${i}`,
        created_at: ago((30 + i) * HOUR),
      })
    );
    rows.push(stagingRow({ stripe_payment_intent_id: "pi_newest", status: "processing", reslab_reservation_number: "TRP-NEWNEWNE", created_at: ago(2 * HOUR) }));
    db.seed("pending_bookings", rows);

    const first = await (await GET(req())).json();
    expect(first.crossModeHeld).toBe(25);
    expect(heldPis()).toContain("pi_newest");
    expect(heldPis()[0]).toBe("pi_newest");

    // the two oldest are picked up next tick — nothing is reported twice
    capturePaymentError.mockClear();
    const second = await (await GET(req())).json();
    expect(second.crossModeHeld).toBe(2);
    expect(heldPis().sort()).toEqual(["pi_old_24", "pi_old_25"]);
  });

  it("a failed stamp is non-fatal and counted; the row is reported again next tick", async () => {
    db.seed("pending_bookings", [
      stagingRow({ stripe_payment_intent_id: "pi_held", status: "processing", reslab_reservation_number: "TRP-7K2M9QXA" }),
    ]);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    db.failWhen("pending_bookings", "update", (p) => typeof p?.last_error === "string" && p.last_error.startsWith("held-cross-mode-reported"), "connection reset");
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, crossModeHeld: 1, crossModeHeldUnmarked: 1 });
    expect(db.tables.pending_bookings[0].last_error).toBeNull();
    expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/could not stamp held opposite-mode row pi_held: connection reset/));

    capturePaymentError.mockClear();
    expect((await (await GET(req())).json()).crossModeHeld).toBe(1);
    expect(heldPis()).toEqual(["pi_held"]);
    errSpy.mockRestore();
  });
});
