/**
 * Recovery tests for the cancel-reconciliation cron. The invariant: it finishes
 * interrupted cancellations idempotently — retrying a stuck refund, re-verifying
 * an ambiguous ResLab cancel — without ever double-refunding, refunding a
 * still-live reservation, or touching a row it doesn't own.
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

const { reconcileStuckCancellations, recoverOne } = await import("../reconcile");
const { createAdminClient } = await import("@/lib/supabase/server");
const { ReslabError } = await import("@/lib/reslab/client");

// ---------------------------------------------------------------------------

const NOW = 1_800_000_000_000;
const iso = (ms: number) => new Date(ms).toISOString();
const STALE = iso(NOW - 300_000); // 5 min ago → past the 3-min grace
const FRESH = iso(NOW - 60_000); // 1 min ago → within grace

function seed(over: Record<string, unknown> = {}) {
  db.tables.customers = [
    { id: "c1", email: "c@example.com", first_name: "Case", last_name: "Test" },
  ];
  db.tables.bookings = [
    {
      id: "b1",
      reslab_reservation_number: "RTL1",
      status: "confirmed",
      customer_id: "c1",
      location_name: "Lot",
      location_address: "1 Way",
      check_in: "2030-06-15 10:00:00",
      check_out: "2030-06-20 10:00:00",
      location_timezone: "America/New_York",
      protection_plan: null,
      protection_plan_price: null,
      pg_identifier: null,
      stripe_payment_intent_id: "pi_1",
      cancel_state: "reslab_cancelled_refund_pending",
      cancel_claimed_at: STALE,
      ...over,
    },
  ];
}

function mkPi(status: string, over: Record<string, unknown> = {}) {
  return {
    id: "pi_1",
    status,
    amount_received: 10_000,
    latest_charge: status === "succeeded" ? { amount_refunded: 0 } : null,
    ...over,
  };
}

function mkRow(reservationNumber: string, over: Record<string, unknown> = {}) {
  return {
    id: `b-${reservationNumber}`,
    reslab_reservation_number: reservationNumber,
    status: "confirmed",
    customer_id: "c1",
    location_name: "Lot",
    location_address: "1 Way",
    check_in: "2030-06-15 10:00:00",
    check_out: "2030-06-20 10:00:00",
    location_timezone: "America/New_York",
    protection_plan: null,
    protection_plan_price: null,
    pg_identifier: null,
    stripe_payment_intent_id: "pi_1",
    cancel_state: "reslab_cancelled_refund_pending",
    cancel_claimed_at: STALE,
    ...over,
  };
}

beforeEach(() => {
  db.tables.bookings = [];
  db.tables.customers = [];
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

describe("reconcileStuckCancellations", () => {
  it("reslab_cancelled_refund_pending: retries the refund → recovered, status refunded, no ResLab cancel", async () => {
    seed({ cancel_state: "reslab_cancelled_refund_pending", cancel_claimed_at: STALE });
    stripeMock.paymentIntents.retrieve.mockResolvedValue(mkPi("succeeded"));

    const r = await reconcileStuckCancellations(NOW);

    expect(r.recovered).toBe(1);
    expect(r.stalled).toEqual([]);
    expect(createRefundCents).toHaveBeenCalledWith("pi_1", 10_000, "selfcancel:pi_1");
    expect(db.tables.bookings[0].status).toBe("refunded");
    expect(db.tables.bookings[0].cancel_state).toBe("refund_issued");
    // ResLab is already cancelled for this state — don't re-cancel.
    expect(reslabMock.cancelReservation).not.toHaveBeenCalled();
  });

  it("held_reslab_ambiguous + ResLab now confirms cancelled: proceed → recovered", async () => {
    seed({ cancel_state: "held_reslab_ambiguous", cancel_claimed_at: STALE });
    reslabMock.cancelReservation.mockResolvedValue({ cancelled: true });
    stripeMock.paymentIntents.retrieve.mockResolvedValue(mkPi("succeeded"));

    const r = await reconcileStuckCancellations(NOW);

    expect(r.recovered).toBe(1);
    expect(reslabMock.cancelReservation).toHaveBeenCalledWith("RTL1");
    expect(createRefundCents).toHaveBeenCalled();
    expect(db.tables.bookings[0].status).toBe("refunded");
  });

  it("held_reslab_ambiguous + ResLab refuses (still active): reverts to confirmed, stalled, NO refund", async () => {
    seed({ cancel_state: "held_reslab_ambiguous", cancel_claimed_at: STALE });
    reslabMock.cancelReservation.mockImplementationOnce(async () => {
      throw new ReslabError(400, "already checked in");
    });
    reslabMock.getReservation.mockResolvedValue({ cancelled: false }); // still active

    const r = await reconcileStuckCancellations(NOW);

    expect(r.recovered).toBe(0);
    expect(r.stalled).toEqual([
      { reservationNumber: "RTL1", cancelState: "held_reslab_ambiguous", reason: "reslab_refused" },
    ]);
    expect(createRefundCents).not.toHaveBeenCalled();
    // Reverted to a clean confirmed booking.
    expect(db.tables.bookings[0].cancel_claimed_at).toBeNull();
    expect(db.tables.bookings[0].cancel_state).toBeNull();
    expect(db.tables.bookings[0].status).toBe("confirmed");
  });

  it("held_reslab_ambiguous + ResLab STILL ambiguous (timeout): stays held, stalled, NO refund", async () => {
    seed({ cancel_state: "held_reslab_ambiguous", cancel_claimed_at: STALE });
    reslabMock.cancelReservation.mockImplementationOnce(async () => {
      throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
    });

    const r = await reconcileStuckCancellations(NOW);

    expect(r.stalled).toEqual([
      { reservationNumber: "RTL1", cancelState: "held_reslab_ambiguous", reason: "still_ambiguous" },
    ]);
    expect(createRefundCents).not.toHaveBeenCalled();
    expect(db.tables.bookings[0].cancel_state).toBe("held_reslab_ambiguous");
    // Re-claim advanced the timestamp so the grace applies before the next run.
    expect(db.tables.bookings[0].cancel_claimed_at).toBe(iso(NOW));
  });

  it("refund fails AGAIN on a retry: stalled refund_failed, stays refund-pending", async () => {
    seed({ cancel_state: "reslab_cancelled_refund_pending", cancel_claimed_at: STALE });
    stripeMock.paymentIntents.retrieve.mockResolvedValue(mkPi("succeeded"));
    createRefundCents.mockImplementationOnce(async () => {
      throw new Error("card_declined");
    });

    const r = await reconcileStuckCancellations(NOW);

    expect(r.recovered).toBe(0);
    expect(r.stalled).toEqual([
      { reservationNumber: "RTL1", cancelState: "reslab_cancelled_refund_pending", reason: "refund_failed" },
    ]);
    expect(db.tables.bookings[0].cancel_state).toBe("reslab_cancelled_refund_pending");
    expect(db.tables.bookings[0].status).toBe("confirmed");
  });

  it("idempotent: an already-refunded refund_pending row → recovered, NO new refund", async () => {
    seed({ cancel_state: "reslab_cancelled_refund_pending", cancel_claimed_at: STALE });
    stripeMock.paymentIntents.retrieve.mockResolvedValue(
      mkPi("succeeded", { latest_charge: { amount_refunded: 10_000 } }),
    );

    const r = await reconcileStuckCancellations(NOW);

    expect(r.recovered).toBe(1);
    expect(createRefundCents).not.toHaveBeenCalled(); // refundCents nets to 0
    expect(db.tables.bookings[0].status).toBe("refunded"); // via priorRefunded
  });

  it("does NOT recover a row still within the grace window", async () => {
    seed({ cancel_state: "reslab_cancelled_refund_pending", cancel_claimed_at: FRESH });
    stripeMock.paymentIntents.retrieve.mockResolvedValue(mkPi("succeeded"));

    const r = await reconcileStuckCancellations(NOW);

    expect(r.scanned).toBe(0);
    expect(r.recovered).toBe(0);
    expect(createRefundCents).not.toHaveBeenCalled();
  });

  it("counts a stale bare 'claimed' as a leaked claim but does NOT auto-recover it", async () => {
    seed({ cancel_state: "claimed", cancel_claimed_at: STALE });

    const r = await reconcileStuckCancellations(NOW);

    expect(r.leakedClaims).toBe(1);
    expect(r.scanned).toBe(0); // 'claimed' isn't a HOLD state
    expect(r.recovered).toBe(0);
    expect(reslabMock.cancelReservation).not.toHaveBeenCalled();
    expect(createRefundCents).not.toHaveBeenCalled();
  });

  it("admin_claimed is never auto-recovered, but IS flagged as a leaked/stuck claim (alert-only)", async () => {
    seed({ cancel_state: "admin_claimed", cancel_claimed_at: STALE });

    const r = await reconcileStuckCancellations(NOW);

    expect(r.scanned).toBe(0); // not a recovery HOLD state — never auto-refunded
    expect(r.recovered).toBe(0);
    expect(r.leakedClaims).toBe(1); // but surfaced for a human (admin terminal-write-failed)
    expect(createRefundCents).not.toHaveBeenCalled();
  });
});

describe("reconcile — review-fix coverage", () => {
  it("recoverOne SKIPS when the claim was advanced under it (concurrency guard)", async () => {
    // DB row's claim is now at NOW; the scan snapshot still has STALE.
    seed({ cancel_state: "reslab_cancelled_refund_pending", cancel_claimed_at: iso(NOW) });
    stripeMock.paymentIntents.retrieve.mockResolvedValue(mkPi("succeeded"));
    const admin = await createAdminClient();
    const snapshot = { ...mkRow("RTL1"), cancel_claimed_at: STALE };

    const outcome = await recoverOne(admin, snapshot, NOW);

    // Re-claim pins cancel_claimed_at=STALE but the DB has NOW → zero rows → skip.
    expect(outcome).toBe("skipped");
    expect(reslabMock.cancelReservation).not.toHaveBeenCalled();
    expect(createRefundCents).not.toHaveBeenCalled();
  });

  it("recovers a Park Guard booking: refund = amount − $6, PG cancelled + pg_identifier cleared", async () => {
    seed({
      cancel_state: "reslab_cancelled_refund_pending",
      cancel_claimed_at: STALE,
      protection_plan: "parkguard",
      protection_plan_price: 10.99,
      pg_identifier: "pg_1",
    });
    stripeMock.paymentIntents.retrieve.mockResolvedValue(mkPi("succeeded"));

    const r = await reconcileStuckCancellations(NOW);

    expect(r.recovered).toBe(1);
    expect(createRefundCents).toHaveBeenCalledWith("pi_1", 9400, "selfcancel:pi_1"); // 10000 − 600
    expect(parkGuardMock.updateReservation).toHaveBeenCalledWith("b1", { status: "cancelled" });
    expect(db.tables.bookings[0].pg_identifier).toBeNull();
    expect(db.tables.bookings[0].status).toBe("refunded");
  });

  it("refund_pending with an unreadable charge → stalled 'unknown', NO refund", async () => {
    seed({ cancel_state: "reslab_cancelled_refund_pending", cancel_claimed_at: STALE });
    stripeMock.paymentIntents.retrieve.mockResolvedValue(mkPi("succeeded", { latest_charge: null }));

    const r = await reconcileStuckCancellations(NOW);

    expect(r.stalled).toEqual([
      { reservationNumber: "RTL1", cancelState: "reslab_cancelled_refund_pending", reason: "unknown" },
    ]);
    expect(createRefundCents).not.toHaveBeenCalled();
  });

  it("refund_pending with a NaN amount → stalled 'dirty_refund_math', NO refund", async () => {
    seed({ cancel_state: "reslab_cancelled_refund_pending", cancel_claimed_at: STALE });
    stripeMock.paymentIntents.retrieve.mockResolvedValue(mkPi("succeeded", { amount_received: NaN }));

    const r = await reconcileStuckCancellations(NOW);

    expect(r.stalled).toEqual([
      { reservationNumber: "RTL1", cancelState: "reslab_cancelled_refund_pending", reason: "dirty_refund_math" },
    ]);
    expect(createRefundCents).not.toHaveBeenCalled();
  });

  it("recovery scan DB error → THROWS (so the cron alerts, not a false clean run)", async () => {
    seed({ cancel_state: "reslab_cancelled_refund_pending", cancel_claimed_at: STALE });
    db.failOnce("bookings", "select", "connection reset");

    await expect(reconcileStuckCancellations(NOW)).rejects.toThrow(/scan failed/);
  });

  it("aggregates multiple rows: recovered + stalled counted correctly", async () => {
    db.tables.customers = [{ id: "c1", email: "c@example.com", first_name: "A", last_name: "B" }];
    db.tables.bookings = [
      mkRow("RTL1", { stripe_payment_intent_id: "pi_1" }), // recovers
      mkRow("RTL2", { stripe_payment_intent_id: "pi_2" }), // refund throws → stalled
      mkRow("RTL3", { cancel_state: "held_reslab_ambiguous", stripe_payment_intent_id: "pi_3" }), // timeout → stalled
    ];
    stripeMock.paymentIntents.retrieve.mockResolvedValue(mkPi("succeeded"));
    createRefundCents.mockImplementation(async (pi: string) => {
      if (pi === "pi_2") throw new Error("declined");
      return { id: "re" };
    });
    reslabMock.cancelReservation.mockImplementation(async () => {
      throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
    });

    const r = await reconcileStuckCancellations(NOW);

    expect(r.recovered).toBe(1); // RTL1
    expect(r.stalled.map((s) => s.reservationNumber).sort()).toEqual(["RTL2", "RTL3"]);
  });

  it("capped: true when the wall-clock deadline is already past (backlog deferred)", async () => {
    db.tables.customers = [{ id: "c1", email: "c@example.com", first_name: "A", last_name: "B" }];
    db.tables.bookings = [mkRow("RTL1"), mkRow("RTL2", { stripe_payment_intent_id: "pi_2" })];
    stripeMock.paymentIntents.retrieve.mockResolvedValue(mkPi("succeeded"));

    // deadline epoch 1ms → real Date.now() is already past it → bail before row 1.
    const r = await reconcileStuckCancellations(NOW, 1);

    expect(r.capped).toBe(true);
    expect(r.recovered).toBe(0);
    expect(createRefundCents).not.toHaveBeenCalled();
  });

  it("recovers even when the customer row is missing: refund + terminal write, NO email, no throw", async () => {
    seed({
      cancel_state: "reslab_cancelled_refund_pending",
      cancel_claimed_at: STALE,
      customer_id: "missing", // no matching customers row
    });
    stripeMock.paymentIntents.retrieve.mockResolvedValue(mkPi("succeeded"));

    const r = await reconcileStuckCancellations(NOW);

    expect(r.recovered).toBe(1);
    expect(createRefundCents).toHaveBeenCalled();
    expect(db.tables.bookings[0].status).toBe("refunded");
    expect(sendCancellationConfirmation).not.toHaveBeenCalled(); // customers null → no email
  });
});
