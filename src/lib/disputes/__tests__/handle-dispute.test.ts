/**
 * Dispute ledger + evidence draft + alerts. The draft must never be submitted
 * (Stripe allows one submission), each side effect runs exactly once however
 * Stripe orders or repeats its events, and the evidence never states what the
 * booking row doesn't record.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type Stripe from "stripe";

const { db, disputesUpdate, piRetrieve, cc, sentry, alerts } = await vi.hoisted(async () => {
  const { FakeSupabase } = await import("@/lib/booking/__tests__/supabase-fake");
  return {
    db: new FakeSupabase(),
    disputesUpdate: vi.fn(),
    piRetrieve: vi.fn(),
    cc: { commandCenterConfigured: vi.fn(), createCommandCenterTask: vi.fn() },
    sentry: { capturePaymentError: vi.fn() },
    alerts: { sendDisputeOpenedAlert: vi.fn(), sendDisputeClosedAlert: vi.fn() },
  };
});

vi.mock("@/lib/stripe/client", () => ({
  stripe: { disputes: { update: disputesUpdate }, paymentIntents: { retrieve: piRetrieve } },
}));
vi.mock("@/lib/command-center/create-task", async (orig) => ({
  ...(await orig<typeof import("@/lib/command-center/create-task")>()),
  ...cc,
}));
vi.mock("@/lib/sentry", () => sentry);
vi.mock("@/lib/resend/send-dispute-alert", () => alerts);

import { handleDisputeCreated, handleDisputeChanged } from "../handle-dispute";
import { buildEvidence, paymentFactsFrom, playbookFor } from "../evidence";
import { TERMS_CHECKBOX_TEXT, TERMS_VERSION } from "@/lib/checkout/terms-acceptance";

type Db = Parameters<typeof handleDisputeCreated>[0];
const sb = db as unknown as Db; // test double only

function dispute(over: Partial<Stripe.Dispute> = {}): Stripe.Dispute {
  return {
    id: "dp_1",
    amount: 5057,
    currency: "usd",
    reason: "fraudulent",
    status: "needs_response",
    livemode: true,
    payment_intent: "pi_1",
    charge: "ch_1",
    evidence_details: { due_by: 1_762_300_800 },
    ...over,
  } as Stripe.Dispute;
}

const BOOKING = {
  id: "b1",
  stripe_payment_intent_id: "pi_1",
  reslab_reservation_number: "RTL828863",
  location_name: "Park Fast",
  location_address: "1 Airport Rd",
  airport_code: "EWR",
  check_in: "2026-10-10T08:00:00",
  check_out: "2026-10-14T18:00:00",
  grand_total: 50.57,
  status: "completed",
  created_at: "2026-10-01T12:00:00+00:00",
  cancellation_reason: null,
  cancelled_by: null,
  inventory_source: "reslab",
  customers: { email: "a@b.com", first_name: "Ann", last_name: "Lee" },
};

const PI = {
  id: "pi_1",
  metadata: { termsVersion: TERMS_VERSION },
  latest_charge: {
    id: "ch_1",
    created: 1_759_320_000, // 2025-10-01T12:00:00Z
    payment_method_details: {
      card: { checks: { cvc_check: "pass", address_postal_code_check: "unavailable" }, three_d_secure: null },
    },
  },
} as unknown as Stripe.PaymentIntent; // test double only

function seedBooking(over: Record<string, unknown> = {}) {
  db.seed("bookings", [{ ...BOOKING, customer_id: "c1", ...over }]);
}

beforeEach(() => {
  db.clearFailures();
  seedBooking();
  db.seed("customers", [{ id: "c1", email: "a@b.com", first_name: "Ann", last_name: "Lee" }]).seed("disputes", []);
  disputesUpdate.mockReset().mockResolvedValue({});
  piRetrieve.mockReset().mockResolvedValue(PI);
  cc.commandCenterConfigured.mockReset().mockReturnValue(false);
  cc.createCommandCenterTask.mockReset().mockResolvedValue("task-1");
  sentry.capturePaymentError.mockReset();
  alerts.sendDisputeOpenedAlert.mockReset().mockResolvedValue(undefined);
  alerts.sendDisputeClosedAlert.mockReset().mockResolvedValue(undefined);
});

describe("handleDisputeCreated", () => {
  it("records the dispute, saves an UNSUBMITTED draft, and alerts once", async () => {
    const r = await handleDisputeCreated(sb, dispute());
    expect(r.retryable).toBe(false);

    expect(db.tables.disputes).toHaveLength(1);
    expect(db.tables.disputes[0]).toMatchObject({
      stripe_dispute_id: "dp_1",
      booking_id: "b1",
      booking_status_at_dispute: "completed",
      amount_cents: 5057,
      reason: "fraudulent",
      evidence_due_by: new Date(1_762_300_800 * 1000).toISOString(),
    });
    expect(db.tables.disputes[0].evidence_drafted_at).toBeTruthy();
    expect(db.tables.disputes[0].alert_sent_at).toBeTruthy();

    expect(disputesUpdate).toHaveBeenCalledTimes(1);
    const [, params] = disputesUpdate.mock.calls[0];
    expect(params.submit).toBe(false);
    expect(params.evidence.customer_email_address).toBe("a@b.com");
    expect(params.evidence.service_date).toBe("2026-10-10");

    expect(alerts.sendDisputeOpenedAlert).toHaveBeenCalledTimes(1);
    expect(alerts.sendDisputeOpenedAlert.mock.calls[0][0]).toMatchObject({ confirmationNumber: "RTL828863", draftSaved: true });
  });

  it("a redelivered event does nothing (no second draft, no second email)", async () => {
    await handleDisputeCreated(sb, dispute());
    const r = await handleDisputeCreated(sb, dispute());
    expect(r.retryable).toBe(false);
    expect(disputesUpdate).toHaveBeenCalledTimes(1);
    expect(alerts.sendDisputeOpenedAlert).toHaveBeenCalledTimes(1);
  });

  it("a redelivery after the booking was flipped keeps the pre-dispute status", async () => {
    alerts.sendDisputeOpenedAlert.mockRejectedValueOnce(new Error("Resend down"));
    await handleDisputeCreated(sb, dispute());
    db.tables.bookings[0].status = "disputed"; // the webhook's flip
    await handleDisputeCreated(sb, dispute());
    expect(db.tables.disputes[0].booking_status_at_dispute).toBe("completed");
  });

  it("a failed ledger insert asks Stripe to retry and sends nothing", async () => {
    db.failOnce("disputes", "insert", "connection reset");
    const r = await handleDisputeCreated(sb, dispute());
    expect(r.retryable).toBe(true);
    expect(disputesUpdate).not.toHaveBeenCalled();
    expect(alerts.sendDisputeOpenedAlert).not.toHaveBeenCalled();
  });

  it("a failed ledger lookup asks Stripe to retry and writes nothing", async () => {
    db.failOnce("disputes", "select", "timeout");
    const r = await handleDisputeCreated(sb, dispute());
    expect(r.retryable).toBe(true);
    expect(db.tables.disputes).toHaveLength(0);
    expect(alerts.sendDisputeOpenedAlert).not.toHaveBeenCalled();
  });

  it("losing the insert race re-reads the winner's row and carries on", async () => {
    // Models the row another delivery inserted between our read and insert.
    db.failAfterCommitWhen("disputes", "insert", () => true, "duplicate key", "23505");
    const r = await handleDisputeCreated(sb, dispute());
    expect(r.retryable).toBe(false);
    expect(db.tables.disputes).toHaveLength(1);
    expect(alerts.sendDisputeOpenedAlert).toHaveBeenCalledTimes(1);
  });

  it("losing the insert race with the row then unreadable asks for a retry", async () => {
    db.failOnce("disputes", "insert", "duplicate key", "23505");
    expect((await handleDisputeCreated(sb, dispute())).retryable).toBe(true);
    expect(alerts.sendDisputeOpenedAlert).not.toHaveBeenCalled();
  });

  it("a row whose claims are already taken sends nothing again", async () => {
    db.tables.bookings[0].status = "disputed"; // flipped by the first delivery
    db.seed("disputes", [
      { stripe_dispute_id: "dp_1", booking_id: "b1", booking_status_at_dispute: "completed", draft_attempted_at: "t", alert_sent_at: "t", closed_at: null },
    ]);
    const r = await handleDisputeCreated(sb, dispute());
    expect(r).toEqual({ retryable: false, flipBooking: false });
    expect(disputesUpdate).not.toHaveBeenCalled();
    expect(alerts.sendDisputeOpenedAlert).not.toHaveBeenCalled();
  });

  it("only the delivery that stores the status asks for the booking flip", async () => {
    alerts.sendDisputeOpenedAlert.mockRejectedValueOnce(new Error("Resend down"));
    expect(await handleDisputeCreated(sb, dispute())).toEqual({ retryable: true, flipBooking: true });
    db.tables.bookings[0].status = "disputed"; // the webhook's flip
    expect(await handleDisputeCreated(sb, dispute())).toEqual({ retryable: false, flipBooking: false });
  });

  it("a delivery that died before its flip is flipped by the redelivery", async () => {
    // Row written, alert sent, then the function timed out: booking never flipped.
    db.seed("disputes", [
      { stripe_dispute_id: "dp_1", booking_id: "b1", booking_status_at_dispute: "completed", draft_attempted_at: "t", alert_sent_at: "t", closed_at: null },
    ]);
    expect(await handleDisputeCreated(sb, dispute())).toEqual({ retryable: false, flipBooking: true });
    expect(alerts.sendDisputeOpenedAlert).not.toHaveBeenCalled();
  });

  it("a redelivery never flips a booking whose status moved on since the dispute", async () => {
    db.tables.bookings[0].status = "refunded";
    db.seed("disputes", [
      { stripe_dispute_id: "dp_1", booking_id: "b1", booking_status_at_dispute: "completed", draft_attempted_at: "t", alert_sent_at: "t", closed_at: null },
    ]);
    expect((await handleDisputeCreated(sb, dispute())).flipBooking).toBe(false);
  });

  it("a missing ledger table (migration not applied) degrades: no retry, flip the booking", async () => {
    db.failOnce("disputes", "select", "relation does not exist", "42P01");
    expect(await handleDisputeCreated(sb, dispute())).toEqual({ retryable: false, flipBooking: true });
    expect(sentry.capturePaymentError.mock.calls[0][0].message).toContain("migration 045");
  });

  it("a failed draft is recorded and still alerts, without a retry", async () => {
    disputesUpdate.mockRejectedValueOnce(new Error("evidence too long"));
    const r = await handleDisputeCreated(sb, dispute());
    expect(r.retryable).toBe(false);
    expect(db.tables.disputes[0].evidence_draft_error).toBe("evidence too long");
    expect(alerts.sendDisputeOpenedAlert.mock.calls[0][0]).toMatchObject({ draftSaved: false, draftError: "evidence too long" });
  });

  it("a failed email releases its claim and asks for a retry; the retry sends it", async () => {
    alerts.sendDisputeOpenedAlert.mockRejectedValueOnce(new Error("Resend down"));
    const r1 = await handleDisputeCreated(sb, dispute());
    expect(r1.retryable).toBe(true);
    expect(db.tables.disputes[0].alert_sent_at).toBeNull();
    const r2 = await handleDisputeCreated(sb, dispute());
    expect(r2.retryable).toBe(false);
    expect(alerts.sendDisputeOpenedAlert).toHaveBeenCalledTimes(2);
    expect(disputesUpdate).toHaveBeenCalledTimes(1); // the draft is not redone
  });

  it("no booking for the charge: ledger row with no booking, no draft, still alerts", async () => {
    db.seed("bookings", []);
    await handleDisputeCreated(sb, dispute());
    expect(db.tables.disputes[0].booking_id).toBeNull();
    expect(disputesUpdate).not.toHaveBeenCalled();
    expect(alerts.sendDisputeOpenedAlert.mock.calls[0][0]).toMatchObject({ confirmationNumber: null, draftSaved: false });
  });

  it("an `updated` event that arrived first does not suppress the draft or the alert", async () => {
    await handleDisputeChanged(sb, dispute());
    expect(db.tables.disputes[0].booking_id).toBeUndefined();
    await handleDisputeCreated(sb, dispute());
    expect(db.tables.disputes[0]).toMatchObject({ booking_id: "b1", booking_status_at_dispute: "completed" });
    expect(disputesUpdate).toHaveBeenCalledTimes(1);
    expect(alerts.sendDisputeOpenedAlert).toHaveBeenCalledTimes(1);
  });

  it("an inquiry that no longer accepts evidence gets no draft", async () => {
    await handleDisputeCreated(sb, dispute({ status: "under_review" }));
    expect(disputesUpdate).not.toHaveBeenCalled();
  });
  it("the draft quotes the checkbox the customer ticked and only the card checks that passed", async () => {
    await handleDisputeCreated(sb, dispute());
    expect(piRetrieve).toHaveBeenCalledWith("pi_1", { expand: ["latest_charge"] });
    const ev = disputesUpdate.mock.calls[0][1].evidence;
    expect(ev.cancellation_policy_disclosure).toContain(TERMS_CHECKBOX_TEXT[TERMS_VERSION]);
    expect(ev.cancellation_policy_disclosure).toContain("payment made 2025-10-01 12:00 UTC");
    expect(ev.uncategorized_text).toContain("CVC) check: passed");
    expect(ev.uncategorized_text).not.toContain("AVS");
  });

  it("an unreadable PaymentIntent still saves the booking-only draft", async () => {
    piRetrieve.mockRejectedValueOnce(new Error("Stripe 500"));
    await handleDisputeCreated(sb, dispute());
    expect(disputesUpdate).toHaveBeenCalledTimes(1);
    expect(disputesUpdate.mock.calls[0][1].evidence.cancellation_policy_disclosure).not.toContain("ticked");
  });

  it("a live dispute gets one Command Center task, due two days before the deadline", async () => {
    cc.commandCenterConfigured.mockReturnValue(true);
    await handleDisputeCreated(sb, dispute());
    await handleDisputeCreated(sb, dispute());
    expect(cc.createCommandCenterTask).toHaveBeenCalledTimes(1);
    const task = cc.createCommandCenterTask.mock.calls[0][0];
    expect(task.title).toBe("Answer $50.57 fraudulent dispute (RTL828863) by 2025-11-05");
    expect(task.due).toBe("2025-11-02");
    expect(db.tables.disputes[0].cc_task_id).toBe("task-1");
  });

  it("test-mode disputes never create a Command Center task", async () => {
    cc.commandCenterConfigured.mockReturnValue(true);
    await handleDisputeCreated(sb, dispute({ livemode: false }));
    expect(cc.createCommandCenterTask).not.toHaveBeenCalled();
  });

  it("a failed Command Center task is reported, not retried", async () => {
    cc.commandCenterConfigured.mockReturnValue(true);
    cc.createCommandCenterTask.mockRejectedValueOnce(new Error("HTTP 500"));
    expect((await handleDisputeCreated(sb, dispute())).retryable).toBe(false);
    expect(sentry.capturePaymentError.mock.calls.at(-1)?.[0].message).toContain("Command Center task failed");
  });
});

describe("handleDisputeChanged", () => {
  it("records the outcome on close and emails it once, even when updated + closed both say lost", async () => {
    await handleDisputeCreated(sb, dispute());
    await handleDisputeChanged(sb, dispute({ status: "lost" }));
    await handleDisputeChanged(sb, dispute({ status: "lost" }));
    expect(db.tables.disputes[0]).toMatchObject({ status: "lost", outcome: "lost" });
    expect(db.tables.disputes[0].closed_at).toBeTruthy();
    expect(alerts.sendDisputeClosedAlert).toHaveBeenCalledTimes(1);
    expect(alerts.sendDisputeClosedAlert.mock.calls[0][0]).toMatchObject({ confirmationNumber: "RTL828863" });
  });

  it("a late non-terminal update never reopens a closed dispute", async () => {
    await handleDisputeCreated(sb, dispute());
    await handleDisputeChanged(sb, dispute({ status: "won" }));
    await handleDisputeChanged(sb, dispute({ status: "under_review" }));
    expect(db.tables.disputes[0]).toMatchObject({ status: "won", outcome: "won" });
  });

  it("an update for a dispute opened before the ledger creates its row", async () => {
    await handleDisputeChanged(sb, dispute({ status: "under_review" }));
    expect(db.tables.disputes).toHaveLength(1);
    expect(db.tables.disputes[0]).toMatchObject({ status: "under_review" });
    expect(db.tables.disputes[0].closed_at).toBeUndefined();
    expect(alerts.sendDisputeClosedAlert).not.toHaveBeenCalled();
  });

  it("a failed ledger lookup asks Stripe to retry", async () => {
    db.failOnce("disputes", "select", "timeout");
    expect((await handleDisputeChanged(sb, dispute({ status: "lost" }))).retryable).toBe(true);
    expect(alerts.sendDisputeClosedAlert).not.toHaveBeenCalled();
  });
});

describe("evidence", () => {
  it("keeps airport-local times as written (no timezone shift)", () => {
    expect(buildEvidence(BOOKING, "general").uncategorized_text).toContain("check-in 2026-10-10 08:00");
  });

  it("a duplicate claim gets a duplicate explanation", () => {
    expect(buildEvidence(BOOKING, "duplicate").duplicate_charge_explanation).toContain("RTL828863");
  });

  it("an uncancelled booking rebuts a 'cancelled' claim", () => {
    expect(buildEvidence(BOOKING, "subscription_canceled").cancellation_rebuttal).toContain("no cancellation");
  });

  it("a cancelled booking never gets a 'no cancellation' rebuttal", () => {
    const cancelled = { ...BOOKING, status: "cancelled", cancelled_by: "customer" };
    expect(buildEvidence(cancelled, "subscription_canceled").cancellation_rebuttal).toBeUndefined();
    expect(buildEvidence(cancelled, "credit_not_processed").refund_refusal_explanation).toBeUndefined();
  });

  it("an unknown pre-dispute status makes no cancellation claim either way", () => {
    for (const status of [null, "disputed"]) {
      const e = buildEvidence({ ...BOOKING, status }, "credit_not_processed");
      expect(e.refund_refusal_explanation).toBeUndefined();
      expect(e.uncategorized_text).toContain("status before the dispute: not recorded");
    }
  });

  it("an unversioned (older) charge quotes no checkbox wording", () => {
    const facts = paymentFactsFrom({ ...PI, metadata: {} } as Stripe.PaymentIntent);
    expect(facts.termsText).toBeNull();
    expect(buildEvidence(BOOKING, "general", facts).cancellation_policy_disclosure).not.toContain("ticked");
  });

  it("every reason has hand steps", () => {
    for (const r of ["fraudulent", "product_not_received", "credit_not_processed", "duplicate", "anything"]) {
      expect(playbookFor(r).addByHand.length).toBeGreaterThan(0);
    }
  });
});
