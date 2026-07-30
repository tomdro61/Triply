/**
 * Money-path tests for the self-service cancellation orchestration.
 *
 * The invariant these serve: no path may refund a reservation that is still
 * live, cancel a reservation without refunding a paid customer, double-refund,
 * or take a side effect before the atomic claim is held. Each case is a specific
 * way that could be violated.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { FakeSupabase } from "@/lib/booking/__tests__/supabase-fake";

const db = new FakeSupabase();

const stripeMock = { paymentIntents: { retrieve: vi.fn() } };
const createRefundCents = vi.fn();
const cancelPaymentIntent = vi.fn();

const reslabMock = { cancelReservation: vi.fn(), getReservation: vi.fn() };
const parkGuardMock = { updateReservation: vi.fn() };
const sendCancellationConfirmation = vi.fn();
const sentry = {
  captureAPIError: vi.fn(),
  capturePaymentError: vi.fn(),
  captureParkGuardError: vi.fn(),
};

vi.mock("@/lib/supabase/server", () => ({ createAdminClient: async () => db }));

vi.mock("@/lib/stripe/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/stripe/client")>(
    "@/lib/stripe/client",
  );
  return {
    stripe: stripeMock,
    createRefundCents,
    cancelPaymentIntent,
    // Pure gate — exercise it for real.
    paymentIntentRefundState: actual.paymentIntentRefundState,
  };
});

vi.mock("@/lib/reslab/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/reslab/client")>(
    "@/lib/reslab/client",
  );
  return { reslab: reslabMock, ReslabError: actual.ReslabError };
});

vi.mock("@/lib/parkguard/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/parkguard/client")>(
    "@/lib/parkguard/client",
  );
  return { ...actual, parkGuard: parkGuardMock };
});

vi.mock("@/lib/resend/send-cancellation-confirmation", () => ({
  sendCancellationConfirmation,
}));

vi.mock("@/lib/sentry", () => sentry);

const { performSelfCancel } = await import("../perform");
const { checkInInstantMs } = await import("../eligibility");
const { ReslabError } = await import("@/lib/reslab/client");

// ---------------------------------------------------------------------------

const TZ = "America/New_York";
const CHECK_IN = "2030-06-15 10:00:00";
const INSTANT = checkInInstantMs(CHECK_IN, TZ)!;
const NOW_OK = INSTANT - 48 * 3_600_000; // 48h before → cancellable
const NOW_WITHIN = INSTANT - 1 * 3_600_000; // 1h before → within 24h
const iso = (ms: number) => new Date(ms).toISOString();

function seedDb(over: Record<string, unknown> = {}) {
  db.tables.bookings = [
    {
      id: "b1",
      reslab_reservation_number: "RTL1",
      status: "confirmed",
      cancel_claimed_at: null,
      cancel_state: null,
      pg_identifier: "pg_1",
      ...over,
    },
  ];
}

function mkBooking(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "b1",
    status: "confirmed",
    reslab_reservation_number: "RTL1",
    location_name: "Test Lot",
    location_address: "1 Test Way",
    check_in: CHECK_IN,
    check_out: "2030-06-20 10:00:00",
    location_timezone: TZ,
    protection_plan: "parkguard",
    protection_plan_price: 10.99,
    pg_identifier: "pg_1",
    stripe_payment_intent_id: "pi_1",
    customers: { email: "c@example.com", first_name: "Case", last_name: "Test" },
    ...over,
  } as Parameters<typeof performSelfCancel>[0];
}

function mkPi(status: string, over: Record<string, unknown> = {}) {
  return {
    id: "pi_1",
    status,
    amount_received: 10_000, // $100
    latest_charge: status === "succeeded" ? { amount_refunded: 0 } : null,
    ...over,
  };
}

beforeEach(() => {
  db.tables.bookings = [];
  db.log = [];
  for (const m of [
    stripeMock.paymentIntents.retrieve,
    createRefundCents,
    cancelPaymentIntent,
    reslabMock.cancelReservation,
    reslabMock.getReservation,
    parkGuardMock.updateReservation,
    sendCancellationConfirmation,
    sentry.captureAPIError,
    sentry.capturePaymentError,
    sentry.captureParkGuardError,
  ]) {
    m.mockReset();
  }
  createRefundCents.mockResolvedValue({ id: "re_1" });
  cancelPaymentIntent.mockResolvedValue({ id: "pi_1", status: "canceled" });
  reslabMock.cancelReservation.mockResolvedValue({ cancelled: true });
  parkGuardMock.updateReservation.mockResolvedValue(undefined);
  sendCancellationConfirmation.mockResolvedValue({ success: true });
});

describe("performSelfCancel — happy refund path", () => {
  it("succeeded PI + Park Guard: refunds amount − $6 wholesale, in CENTS, idempotent key", async () => {
    seedDb();
    stripeMock.paymentIntents.retrieve.mockResolvedValue(mkPi("succeeded"));

    const r = await performSelfCancel(mkBooking(), NOW_OK);

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "refunded", refunded: true, refundAmount: 94 });
    // $100 − $6 wholesale = $94 = 9400 cents (NOT 940000 — the 100× trap).
    expect(createRefundCents).toHaveBeenCalledWith("pi_1", 9400, "selfcancel:pi_1");
    // Terminal state persisted.
    expect(db.tables.bookings[0].status).toBe("refunded");
    expect(db.tables.bookings[0].cancel_state).toBe("refund_issued");
    // Park Guard cancelled + pg_identifier cleared.
    expect(parkGuardMock.updateReservation).toHaveBeenCalledWith("b1", { status: "cancelled" });
    expect(db.tables.bookings[0].pg_identifier).toBeNull();
    // Self-cancel always returns the service fee — reconcile.ts reads this flag.
    expect(db.tables.bookings[0].service_fee_refunded).toBe(true);
    // PI retrieved WITH the charge expanded (else the refund-state gate throws).
    expect(stripeMock.paymentIntents.retrieve).toHaveBeenCalledWith("pi_1", {
      expand: ["latest_charge"],
    });
    // Email reflects the refund + the $6 retained / $4.99 returned breakdown.
    expect(sendCancellationConfirmation).toHaveBeenCalledWith(
      expect.objectContaining({
        wasRefunded: true,
        refundAmount: 94,
        protectionPlanRetained: 6,
        protectionPlanRefund: 4.99,
      }),
    );
  });

  it("no Park Guard: refunds the full amount and does NOT call Park Guard", async () => {
    seedDb({ pg_identifier: null });
    stripeMock.paymentIntents.retrieve.mockResolvedValue(mkPi("succeeded"));

    const r = await performSelfCancel(mkBooking({ protection_plan: null, pg_identifier: null }), NOW_OK);

    expect(r.status).toBe(200);
    expect(createRefundCents).toHaveBeenCalledWith("pi_1", 10_000, "selfcancel:pi_1");
    expect(parkGuardMock.updateReservation).not.toHaveBeenCalled();
  });
});

describe("performSelfCancel — no refund but still cancels", () => {
  it("requires_capture: releases the hold, no refund, status cancelled", async () => {
    seedDb();
    stripeMock.paymentIntents.retrieve.mockResolvedValue(mkPi("requires_capture"));

    const r = await performSelfCancel(mkBooking(), NOW_OK);

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "cancelled", refunded: false });
    expect(cancelPaymentIntent).toHaveBeenCalledWith("pi_1");
    expect(createRefundCents).not.toHaveBeenCalled();
    expect(db.tables.bookings[0].status).toBe("cancelled");
  });

  it("succeeded, already fully refunded by a prior attempt: records REFUNDED not cancelled, no new refund", async () => {
    seedDb();
    stripeMock.paymentIntents.retrieve.mockResolvedValue(
      mkPi("succeeded", { amount_received: 10_000, latest_charge: { amount_refunded: 10_000 } }),
    );

    const r = await performSelfCancel(mkBooking(), NOW_OK);

    expect(r.status).toBe(200);
    // priorRefunded>0 → the customer WAS refunded; status MUST reflect that even
    // though this invocation issued no new refund (the stale-reclaim misrecord bug).
    expect(r.body).toMatchObject({ status: "refunded", refunded: true });
    expect(createRefundCents).not.toHaveBeenCalled();
    expect(db.tables.bookings[0].status).toBe("refunded");
  });
});

describe("performSelfCancel — refuses/holds without moving money", () => {
  it("ResLab refuses (4xx + still active): 409, claim released, NO refund", async () => {
    seedDb();
    stripeMock.paymentIntents.retrieve.mockResolvedValue(mkPi("succeeded"));
    reslabMock.cancelReservation.mockImplementationOnce(async () => {
      throw new ReslabError(400, "must not be started");
    });
    reslabMock.getReservation.mockResolvedValue({ cancelled: false }); // still active

    const r = await performSelfCancel(mkBooking(), NOW_OK);

    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: "cannot_cancel" });
    expect(createRefundCents).not.toHaveBeenCalled();
    // claim released → still cancellable later
    expect(db.tables.bookings[0].cancel_claimed_at).toBeNull();
    expect(db.tables.bookings[0].status).toBe("confirmed");
  });

  it("ResLab ambiguous (timeout): 202 HOLD, claim KEPT, NO refund", async () => {
    seedDb();
    stripeMock.paymentIntents.retrieve.mockResolvedValue(mkPi("succeeded"));
    reslabMock.cancelReservation.mockImplementationOnce(async () => {
      throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
    });

    const r = await performSelfCancel(mkBooking(), NOW_OK);

    expect(r.status).toBe(202);
    expect(createRefundCents).not.toHaveBeenCalled();
    expect(db.tables.bookings[0].cancel_state).toBe("held_reslab_ambiguous");
    expect(db.tables.bookings[0].cancel_claimed_at).not.toBeNull(); // claim kept
    expect(db.tables.bookings[0].status).toBe("confirmed");
  });

  it("refund fails after ResLab cancelled: 202, marks refund-pending, keeps claim", async () => {
    seedDb();
    stripeMock.paymentIntents.retrieve.mockResolvedValue(mkPi("succeeded"));
    createRefundCents.mockImplementationOnce(async () => {
      throw new Error("card_declined");
    });

    const r = await performSelfCancel(mkBooking(), NOW_OK);

    expect(r.status).toBe(202);
    expect(db.tables.bookings[0].cancel_state).toBe("reslab_cancelled_refund_pending");
    // NOT flipped to a terminal money state — the cron finishes the refund.
    expect(db.tables.bookings[0].status).toBe("confirmed");
    expect(sentry.capturePaymentError).toHaveBeenCalled();
  });
});

describe("performSelfCancel — gates BEFORE any side effect", () => {
  it("within 24h: 422, never claims, never touches ResLab/Stripe refund", async () => {
    seedDb();
    stripeMock.paymentIntents.retrieve.mockResolvedValue(mkPi("succeeded"));

    const r = await performSelfCancel(mkBooking(), NOW_WITHIN);

    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ error: "within_24h" });
    expect(reslabMock.cancelReservation).not.toHaveBeenCalled();
    expect(createRefundCents).not.toHaveBeenCalled();
    expect(db.tables.bookings[0].cancel_claimed_at).toBeNull();
  });

  it("processing PI: 409, never claims, never touches ResLab", async () => {
    seedDb();
    stripeMock.paymentIntents.retrieve.mockResolvedValue(mkPi("processing"));

    const r = await performSelfCancel(mkBooking(), NOW_OK);

    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: "payment_settling" });
    expect(reslabMock.cancelReservation).not.toHaveBeenCalled();
    expect(db.tables.bookings[0].cancel_claimed_at).toBeNull();
  });

  it("dirty refund math (NaN amount): 500 support message, never claims/cancels", async () => {
    seedDb();
    stripeMock.paymentIntents.retrieve.mockResolvedValue(
      mkPi("succeeded", { amount_received: NaN }),
    );

    const r = await performSelfCancel(mkBooking(), NOW_OK);

    expect(r.status).toBe(500);
    expect(r.body).toMatchObject({ error: "refund_calc_failed" });
    expect(reslabMock.cancelReservation).not.toHaveBeenCalled();
    expect(db.tables.bookings[0].cancel_claimed_at).toBeNull();
  });

  it("already terminal: 200 idempotent, no side effects at all", async () => {
    seedDb({ status: "cancelled" });

    const r = await performSelfCancel(mkBooking({ status: "cancelled" }), NOW_OK);

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ alreadyCancelled: true });
    expect(stripeMock.paymentIntents.retrieve).not.toHaveBeenCalled();
    expect(reslabMock.cancelReservation).not.toHaveBeenCalled();
  });

  it("concurrent claim already held (fresh): 409 in_progress, never touches ResLab", async () => {
    seedDb({ cancel_claimed_at: iso(NOW_OK), cancel_state: "claimed" });
    stripeMock.paymentIntents.retrieve.mockResolvedValue(mkPi("succeeded"));

    const r = await performSelfCancel(mkBooking(), NOW_OK);

    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: "in_progress" });
    expect(reslabMock.cancelReservation).not.toHaveBeenCalled();
    expect(createRefundCents).not.toHaveBeenCalled();
  });
});

describe("performSelfCancel — money-safety branches (review pass-1 fixes)", () => {
  it("confirmed booking with NULL PaymentIntent → 409 refuse, no claim, no ResLab, no PI read", async () => {
    seedDb({ stripe_payment_intent_id: null });

    const r = await performSelfCancel(mkBooking({ stripe_payment_intent_id: null }), NOW_OK);

    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: "unavailable" });
    expect(stripeMock.paymentIntents.retrieve).not.toHaveBeenCalled();
    expect(reslabMock.cancelReservation).not.toHaveBeenCalled();
    expect(db.tables.bookings[0].cancel_claimed_at).toBeNull();
    expect(sentry.captureAPIError).toHaveBeenCalled();
  });

  it("C1 — succeeded PI with no readable charge (unknown state) → 409, never claims/cancels/refunds", async () => {
    seedDb();
    stripeMock.paymentIntents.retrieve.mockResolvedValue(mkPi("succeeded", { latest_charge: null }));

    const r = await performSelfCancel(mkBooking(), NOW_OK);

    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: "unavailable" });
    expect(reslabMock.cancelReservation).not.toHaveBeenCalled();
    expect(createRefundCents).not.toHaveBeenCalled();
    expect(db.tables.bookings[0].cancel_claimed_at).toBeNull();
  });

  it("H1 — Stripe PI retrieve fails → 503, never claims/cancels", async () => {
    seedDb();
    stripeMock.paymentIntents.retrieve.mockImplementationOnce(async () => {
      throw new Error("stripe unreachable");
    });

    const r = await performSelfCancel(mkBooking(), NOW_OK);

    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ error: "payment_lookup_failed" });
    expect(reslabMock.cancelReservation).not.toHaveBeenCalled();
    expect(db.tables.bookings[0].cancel_claimed_at).toBeNull();
    expect(sentry.capturePaymentError).toHaveBeenCalled();
  });

  it("H2 — requires_capture + hold-release throws → still 200 cancelled (soft-fail, alerted)", async () => {
    seedDb();
    stripeMock.paymentIntents.retrieve.mockResolvedValue(mkPi("requires_capture"));
    cancelPaymentIntent.mockImplementationOnce(async () => {
      throw new Error("release failed");
    });

    const r = await performSelfCancel(mkBooking(), NOW_OK);

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "cancelled", refunded: false });
    expect(db.tables.bookings[0].status).toBe("cancelled");
    expect(sentry.capturePaymentError).toHaveBeenCalled();
  });

  it("H3 — refund succeeds but terminal write fails → 200 refunded, PG NOT called, alerted", async () => {
    seedDb();
    stripeMock.paymentIntents.retrieve.mockResolvedValue(mkPi("succeeded"));
    // Fail ONLY the terminal write (the one carrying cancel_state:'refund_issued'),
    // not the earlier claim UPDATE.
    db.failWhen(
      "bookings",
      "update",
      (p) => p?.cancel_state === "refund_issued",
      "terminal write conn reset",
    );

    const r = await performSelfCancel(mkBooking(), NOW_OK);

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ refunded: true });
    expect(createRefundCents).toHaveBeenCalled(); // refund DID happen
    expect(parkGuardMock.updateReservation).not.toHaveBeenCalled(); // gated on persistedByUs
    expect(sentry.captureAPIError).toHaveBeenCalled();
  });

  it("M5 — partial prior refund nets the NEW refund to a concrete cents value", async () => {
    seedDb({ pg_identifier: null });
    stripeMock.paymentIntents.retrieve.mockResolvedValue(
      mkPi("succeeded", { amount_received: 10_000, latest_charge: { amount_refunded: 3_000 } }),
    );

    const r = await performSelfCancel(
      mkBooking({ protection_plan: null, pg_identifier: null }),
      NOW_OK,
    );

    expect(r.status).toBe(200);
    // 10000 − 0 wholesale − 3000 prior = 7000 cents refunded now.
    expect(createRefundCents).toHaveBeenCalledWith("pi_1", 7000, "selfcancel:pi_1");
    expect(r.body).toMatchObject({ status: "refunded", refunded: true });
  });
});
