import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";

const { db, capturePaymentError, retrieve, createBooking, redriveDirectBookingSends, sendLotCancelNotice } = await vi.hoisted(async () => {
  const { FakeSupabase } = await import("@/lib/booking/__tests__/supabase-fake");
  return {
    db: new FakeSupabase(),
    capturePaymentError: vi.fn(),
    retrieve: vi.fn(),
    createBooking: vi.fn(),
    redriveDirectBookingSends: vi.fn(),
    sendLotCancelNotice: vi.fn(),
  };
});

vi.mock("@/lib/supabase/server", () => ({ createAdminClient: async () => db }));
vi.mock("@/lib/stripe/client", () => ({ stripe: { paymentIntents: { retrieve, cancel: vi.fn() } } }));
vi.mock("@/lib/booking/create-booking", () => ({ createBooking, redriveDirectBookingSends }));
vi.mock("@/lib/sentry", () => ({ capturePaymentError }));
vi.mock("@/lib/direct/lot-notice", () => ({ sendLotCancelNotice }));

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

describe("GET /api/cron/sweep-pending-bookings — declined card, then an authorized retry (2026-10-11)", () => {
  const liveFailed = (over: Record<string, unknown>) => ({
    stripe_payment_intent_id: "pi_retry",
    status: "failed",
    livemode: true,
    reslab_reservation_number: null,
    last_error: "PaymentIntent failed: Your card was declined.",
    created_at: ago(3 * HOUR),
    updated_at: ago(2 * HOUR),
    ...over,
  });

  it("re-drives a `failed` row whose PaymentIntent now holds money through the engine", async () => {
    db.seed("pending_bookings", [liveFailed({})]);
    retrieve.mockResolvedValue({ id: "pi_retry", status: "requires_capture", amount: 9400 });
    createBooking.mockResolvedValue({ kind: "created", reservationNumber: "RTL1" });
    const body = await (await GET(req())).json();
    expect(createBooking).toHaveBeenCalledWith({ source: "sweep", stripePaymentIntentId: "pi_retry" });
    expect(body).toMatchObject({ ok: true, declinedScanned: 1, declinedRedriven: 1, completed: 1 });
  });

  it("leaves a genuinely dead decline (PaymentIntent still requires_payment_method) alone", async () => {
    db.seed("pending_bookings", [liveFailed({})]);
    retrieve.mockResolvedValue({ id: "pi_retry", status: "requires_payment_method", amount: 9400 });
    const body = await (await GET(req())).json();
    expect(createBooking).not.toHaveBeenCalled();
    expect(body).toMatchObject({ declinedScanned: 1, declinedRedriven: 0 });
    expect(db.tables.pending_bookings[0].status).toBe("failed");
  });

  it.each([
    ["with a reservation number", { reslab_reservation_number: "RTL5" }],
    ["in the other Stripe mode", { livemode: false }],
    ["touched in the last 15 minutes", { updated_at: ago(60_000) }],
    ["older than the authorization window", { updated_at: ago(9 * 24 * HOUR) }],
  ])("never looks at a `failed` row %s", async (_n, over) => {
    db.seed("pending_bookings", [liveFailed(over)]);
    retrieve.mockResolvedValue({ id: "pi_retry", status: "requires_capture", amount: 9400 });
    const body = await (await GET(req())).json();
    expect(body.declinedScanned).toBe(0);
    expect(createBooking).not.toHaveBeenCalled();
  });

  it("a failed scan query makes the run non-ok and is reported", async () => {
    db.failWhen("pending_bookings", "select", () => true, "connection reset");
    // The first pending_bookings select is the held-row check; fail the declined scan too.
    db.failWhen("pending_bookings", "select", () => true, "connection reset");
    db.failWhen("pending_bookings", "select", () => true, "connection reset");
    const res = await GET(req());
    expect(res.status).toBeGreaterThanOrEqual(500);
  });
});

describe("GET /api/cron/sweep-pending-bookings — direct-lot send backstop (4b plan §9 H-B)", () => {
  const MIN = 60_000;
  /** A live-mode direct booking the lot was never told about, 10 minutes old. */
  const directBooking = (over: Record<string, unknown>) => {
    const created = (over.created_at as string | undefined) ?? ago(10 * MIN);
    return {
      stripe_payment_intent_id: "pi_d1",
      inventory_source: "direct",
      livemode: true,
      status: "confirmed",
      lot_notified_at: null,
      lot_notice_claimed_at: null,
      lot_cancel_notified_at: null,
      // literal wall-clock TIMESTAMP, three days out: the stay is not over
      check_out: new Date(Date.now() + 3 * 24 * HOUR).toISOString().slice(0, 19),
      created_at: created,
      updated_at: created,
      ...over,
    };
  };
  const directPending = (over: Record<string, unknown>) => {
    const created = (over.created_at as string | undefined) ?? ago(10 * MIN);
    return {
      stripe_payment_intent_id: "pi_d1",
      inventory_source: "direct",
      livemode: true,
      status: "completed",
      email_sent: false,
      reslab_reservation_number: "TRP-7K2M9QXA",
      created_at: created,
      updated_at: created,
      ...over,
    };
  };

  beforeEach(() => {
    redriveDirectBookingSends.mockReset().mockResolvedValue(undefined);
    sendLotCancelNotice.mockResolvedValue("sent");
  });

  it("re-drives a confirmed live direct booking whose lot notice is outstanding — sends only, never the whole engine", async () => {
    db.seed("bookings", [directBooking({})]);
    const res = await GET(req());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(redriveDirectBookingSends).toHaveBeenCalledTimes(1);
    expect(createBooking).not.toHaveBeenCalled();
    expect(redriveDirectBookingSends).toHaveBeenCalledWith("pi_d1");
    expect(body).toMatchObject({ ok: true, directSendsRedriven: 1, directCancelNoticesAttempted: 0 });
    expect(sendLotCancelNotice).not.toHaveBeenCalled();
  });

  it("an unsent customer email and an unsent lot notice on the SAME PaymentIntent re-drive it once", async () => {
    db.seed("bookings", [directBooking({})]);
    db.seed("pending_bookings", [directPending({})]);
    const body = await (await GET(req())).json();
    expect(redriveDirectBookingSends).toHaveBeenCalledTimes(1);
    expect(createBooking).not.toHaveBeenCalled();
    expect(redriveDirectBookingSends).toHaveBeenCalledWith("pi_d1");
    expect(body.directSendsRedriven).toBe(1);
  });

  it("a completed direct checkout whose customer email is outstanding is re-driven on its own", async () => {
    db.seed("pending_bookings", [directPending({ stripe_payment_intent_id: "pi_email" })]);
    const body = await (await GET(req())).json();
    expect(redriveDirectBookingSends).toHaveBeenCalledWith("pi_email");
    expect(body.directSendsRedriven).toBe(1);
  });

  it("the email scan is bounded by created_at, so a row whose updated_at a retry just bumped is still re-driven", async () => {
    db.seed("pending_bookings", [directPending({ stripe_payment_intent_id: "pi_bumped", updated_at: ago(MIN) })]);
    const body = await (await GET(req())).json();
    expect(redriveDirectBookingSends).toHaveBeenCalledWith("pi_bumped");
    expect(body.directSendsRedriven).toBe(1);
  });

  it("leaves alone: other Stripe mode, under 6 min old, older than 3 days, ResLab rows, already notified / emailed, not confirmed", async () => {
    db.seed("bookings", [
      directBooking({ stripe_payment_intent_id: "pi_test_mode", livemode: false }),
      directBooking({ stripe_payment_intent_id: "pi_young", created_at: ago(3 * MIN) }),
      directBooking({ stripe_payment_intent_id: "pi_old", created_at: ago(4 * 24 * HOUR) }),
      directBooking({ stripe_payment_intent_id: "pi_reslab", inventory_source: "reslab" }),
      directBooking({ stripe_payment_intent_id: "pi_notified", lot_notified_at: ago(9 * MIN) }),
      directBooking({ stripe_payment_intent_id: "pi_failed", status: "failed" }),
    ]);
    db.seed("pending_bookings", [
      directPending({ stripe_payment_intent_id: "pi_p_test_mode", livemode: false }),
      directPending({ stripe_payment_intent_id: "pi_p_young", created_at: ago(3 * MIN) }),
      directPending({ stripe_payment_intent_id: "pi_p_old", created_at: ago(4 * 24 * HOUR) }),
      directPending({ stripe_payment_intent_id: "pi_p_reslab", inventory_source: "reslab", reslab_reservation_number: "RTL854206" }),
      directPending({ stripe_payment_intent_id: "pi_p_emailed", email_sent: true }),
    ]);
    const res = await GET(req());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(createBooking).not.toHaveBeenCalled();
    expect(redriveDirectBookingSends).not.toHaveBeenCalled();
    expect(sendLotCancelNotice).not.toHaveBeenCalled();
    expect(body).toMatchObject({ ok: true, directSendsRedriven: 0, directCancelNoticesAttempted: 0 });
  });

  it("a cancellation the lot was told (or may have been told) of gets its cancel notice; one the lot never heard of does not", async () => {
    db.seed("bookings", [
      directBooking({ stripe_payment_intent_id: "pi_c_notified", status: "cancelled", lot_notified_at: ago(2 * HOUR) }),
      directBooking({ stripe_payment_intent_id: "pi_c_claimed", status: "refunded", lot_notice_claimed_at: ago(2 * HOUR) }),
      directBooking({ stripe_payment_intent_id: "pi_c_never", status: "cancelled" }),
      directBooking({ stripe_payment_intent_id: "pi_c_done", status: "cancelled", lot_notified_at: ago(2 * HOUR), lot_cancel_notified_at: ago(9 * MIN) }),
      // no "older than 6 min" bound any more: the claim itself refuses an in-flight booking notice
      directBooking({ stripe_payment_intent_id: "pi_c_young", status: "cancelled", lot_notified_at: ago(2 * HOUR), updated_at: ago(2 * MIN) }),
      // bounded by the stay, not updated_at: a cancellation touched long ago whose stay is still ahead is included…
      directBooking({ stripe_payment_intent_id: "pi_c_old_touch", status: "cancelled", lot_notified_at: ago(5 * 24 * HOUR), updated_at: ago(5 * 24 * HOUR) }),
      // …one whose stay ended 3 days ago is not
      directBooking({ stripe_payment_intent_id: "pi_c_stay_over", status: "cancelled", lot_notified_at: ago(5 * 24 * HOUR), check_out: ago(3 * 24 * HOUR).slice(0, 19) }),
      directBooking({ stripe_payment_intent_id: "pi_c_test_mode", status: "cancelled", lot_notified_at: ago(2 * HOUR), livemode: false }),
      directBooking({ stripe_payment_intent_id: "pi_c_reslab", status: "cancelled", inventory_source: "reslab", lot_notified_at: ago(2 * HOUR) }),
    ]);
    const body = await (await GET(req())).json();
    expect(sendLotCancelNotice.mock.calls.map(([pi]) => pi).sort()).toEqual(["pi_c_claimed", "pi_c_notified", "pi_c_old_touch", "pi_c_young"]);
    expect(body).toMatchObject({ ok: true, directCancelNoticesAttempted: 4, directSendsRedriven: 0 });
    expect(createBooking).not.toHaveBeenCalled();
  });

  it("a backstop scan error makes the run non-ok (500) and is reported; the other scans still do their work", async () => {
    db.seed("bookings", [
      directBooking({ stripe_payment_intent_id: "pi_c_notified", status: "cancelled", lot_notified_at: ago(2 * HOUR) }),
    ]);
    // nothing before the backstop reads `bookings`: the first select is the lot-notice scan
    db.failOnce("bookings", "select", "connection reset");
    const res = await GET(req());
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body).toMatchObject({ ok: false, failed: 1, directCancelNoticesAttempted: 1 });
    expect(sendLotCancelNotice).toHaveBeenCalledWith("pi_c_notified");
    expect(capturePaymentError.mock.calls.map(([e]) => (e as Error).message)).toContainEqual(
      expect.stringMatching(/direct lot notice backstop scan failed: connection reset/)
    );
  });

  it("a re-drive that throws is counted and reported, and the loop goes on: the next PI and the cancel notices still run", async () => {
    db.seed("bookings", [
      directBooking({ stripe_payment_intent_id: "pi_throws", created_at: ago(20 * MIN) }),
      directBooking({ stripe_payment_intent_id: "pi_next", created_at: ago(10 * MIN) }),
      directBooking({ stripe_payment_intent_id: "pi_c_notified", status: "cancelled", lot_notified_at: ago(2 * HOUR) }),
    ]);
    redriveDirectBookingSends.mockImplementation(async (piId: string) => {
      if (piId === "pi_throws") throw new Error("Stripe read timed out");
    });
    const res = await GET(req());
    const body = await res.json();
    expect(redriveDirectBookingSends.mock.calls.map(([pi]) => pi)).toEqual(["pi_throws", "pi_next"]);
    expect(sendLotCancelNotice).toHaveBeenCalledWith("pi_c_notified");
    expect(res.status).toBe(500);
    expect(body).toMatchObject({ ok: false, failed: 1, directSendsRedriven: 2, directCancelNoticesAttempted: 1 });
    expect(capturePaymentError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/direct send backstop re-drive threw for pi_throws: Stripe read timed out/) }),
      expect.objectContaining({ stripePaymentIntentId: "pi_throws" })
    );
  });
});
