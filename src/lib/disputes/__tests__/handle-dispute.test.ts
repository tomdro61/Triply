/**
 * Dispute ledger + evidence draft + alerts. The draft must never be submitted
 * (Stripe allows one submission), each side effect runs exactly once however
 * Stripe orders or repeats its events, and the evidence never states what the
 * booking row doesn't record.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type Stripe from "stripe";

const { db, disputesUpdate, disputesRetrieve, sentry, alerts } = await vi.hoisted(async () => {
  const { FakeSupabase } = await import("@/lib/booking/__tests__/supabase-fake");
  return {
    db: new FakeSupabase(),
    disputesUpdate: vi.fn(),
    disputesRetrieve: vi.fn(),
    sentry: { capturePaymentError: vi.fn() },
    alerts: { sendDisputeOpenedAlert: vi.fn(), sendDisputeClosedAlert: vi.fn() },
  };
});

vi.mock("@/lib/stripe/client", () => ({
  stripe: { disputes: { update: disputesUpdate, retrieve: disputesRetrieve } },
}));
vi.mock("@/lib/sentry", () => sentry);
vi.mock("@/lib/resend/send-dispute-alert", () => alerts);

import { handleDisputeCreated, handleDisputeChanged } from "../handle-dispute";
import { buildEvidence, playbookFor, type ChargeFacts, type DisputeContact } from "../evidence";

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
  // grand_total is deliberately NOT selected: it is not the card amount.
  due_at_location: 0,
  status: "completed",
  created_at: "2026-10-01T12:00:00+00:00",
  cancellation_reason: null,
  cancelled_by: null,
  cancel_state: null,
  cancel_claimed_at: null,
  inventory_source: "reslab",
  // The account row: a signed-in user who booked for someone else.
  customers: { email: "account@b.com", first_name: "Acct", last_name: "Holder" },
};

// Bounded, and no SDK retries (they honour a Retry-After of up to 60 s); the
// handler retries once itself.
const STRIPE_OPTS = { timeout: 6_000, maxNetworkRetries: 0 };
const CHECKOUT: DisputeContact = { name: "Ann Lee", email: "ann@typed.com", source: "checkout" };
const PAID: ChargeFacts = { capturedCents: 6356, refundedCents: 0, currency: "usd" };
const FACTS = { contact: CHECKOUT, charge: PAID };

/** The dispute as `disputes.retrieve(id, { expand: ["charge"] })` returns it now. */
function liveDispute(over: { status?: string; evidence?: Record<string, string | null> } = {}) {
  return {
    status: over.status ?? "needs_response",
    evidence: over.evidence ?? { customer_email_address: "prefilled-by-stripe@x.com" },
    charge: { amount_captured: 6356, amount_refunded: 0, currency: "usd" },
  };
}

function seedBooking(over: Record<string, unknown> = {}) {
  db.seed("bookings", [{ ...BOOKING, customer_id: "c1", ...over }]);
}

beforeEach(() => {
  db.clearFailures();
  seedBooking();
  db.seed("customers", [{ id: "c1", email: "account@b.com", first_name: "Acct", last_name: "Holder" }])
    .seed("pending_bookings", [
      { stripe_payment_intent_id: "pi_1", customer: { firstName: "Ann", lastName: "Lee", email: "ann@typed.com" } },
    ])
    .seed("disputes", []);
  disputesUpdate.mockReset().mockResolvedValue({});
  disputesRetrieve.mockReset().mockResolvedValue(liveDispute());
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
    const [, params, opts] = disputesUpdate.mock.calls[0];
    expect(params.submit).toBe(false);
    expect(params.evidence.service_date).toBe("2026-10-10");
    // Bounded: a hung Stripe call fails inside the route's 60 s.
    expect(opts).toMatchObject(STRIPE_OPTS);
    expect(opts.idempotencyKey).toMatch(/^dispute-draft-dp_1-/);
    expect(disputesRetrieve).toHaveBeenCalledWith("dp_1", { expand: ["charge"] }, STRIPE_OPTS);

    expect(alerts.sendDisputeOpenedAlert).toHaveBeenCalledTimes(1);
    expect(alerts.sendDisputeOpenedAlert.mock.calls[0][0]).toMatchObject({
      confirmationNumber: "RTL828863",
      draftSaved: true,
      draftUnknown: false,
    });
  });

  it("the draft names the person typed at checkout and the amount Stripe charged", async () => {
    await handleDisputeCreated(sb, dispute());
    const { evidence } = disputesUpdate.mock.calls[0][1];
    expect(evidence.customer_email_address).toBe("ann@typed.com");
    expect(evidence.customer_name).toBe("Ann Lee");
    expect(evidence.uncategorized_text).toContain("Charged online by Triply: $63.56.");
    expect(evidence.uncategorized_text).not.toContain("account@b.com");
    // The alert names the address the confirmation went to (what ops searches in Resend).
    expect(alerts.sendDisputeOpenedAlert.mock.calls[0][0].customerEmail).toBe("ann@typed.com");
  });

  it("the alert labels an account email when there is no checkout record", async () => {
    db.seed("pending_bookings", []);
    await handleDisputeCreated(sb, dispute());
    expect(alerts.sendDisputeOpenedAlert.mock.calls[0][0].customerEmail).toBe("account@b.com (account email; no checkout record)");
  });

  it("no checkout record: the account contact is labelled, never put in the matched fields", async () => {
    db.seed("pending_bookings", []);
    await handleDisputeCreated(sb, dispute());
    const { evidence } = disputesUpdate.mock.calls[0][1];
    expect(evidence.customer_email_address).toBeUndefined();
    expect(evidence.uncategorized_text).toContain("Triply account linked to the reservation: Acct Holder, account@b.com.");
  });

  it("a failed checkout-contact read is reported and still drafts and alerts", async () => {
    db.failOnce("pending_bookings", "select", "timeout");
    const r = await handleDisputeCreated(sb, dispute());
    expect(r.retryable).toBe(false);
    expect(disputesUpdate.mock.calls[0][1].evidence.customer_email_address).toBeUndefined();
    expect(sentry.capturePaymentError.mock.calls.some(([e]) => e.message.includes("checkout contact lookup failed"))).toBe(true);
    expect(alerts.sendDisputeOpenedAlert).toHaveBeenCalledTimes(1);
  });

  it("an unreadable charge: the draft states no amount and makes no 'no refund' claim", async () => {
    disputesRetrieve.mockRejectedValueOnce(new Error("Stripe 500"));
    await handleDisputeCreated(sb, dispute({ reason: "credit_not_processed" }));
    const { evidence } = disputesUpdate.mock.calls[0][1];
    expect(evidence.uncategorized_text).not.toContain("Charged");
    expect(evidence.refund_refusal_explanation).toBeUndefined();
    expect(sentry.capturePaymentError.mock.calls.some(([e]) => e.message.includes("live dispute read failed"))).toBe(true);
  });

  // Round 3: a redelivery's event can be hours old.
  it("evidence someone already typed in Stripe is never overwritten", async () => {
    disputesRetrieve.mockResolvedValueOnce(liveDispute({ evidence: { uncategorized_text: "Ops wrote this" } }));
    await handleDisputeCreated(sb, dispute());
    expect(disputesUpdate).not.toHaveBeenCalled();
    expect(db.tables.disputes[0].evidence_draft_error).toContain("already entered");
    expect(alerts.sendDisputeOpenedAlert.mock.calls[0][0]).toMatchObject({ draftSaved: false });
  });

  it("a dispute that no longer accepts evidence gets no draft, even if the event says it does", async () => {
    disputesRetrieve.mockResolvedValueOnce(liveDispute({ status: "under_review" }));
    await handleDisputeCreated(sb, dispute({ status: "needs_response" }));
    expect(disputesUpdate).not.toHaveBeenCalled();
    expect(db.tables.disputes[0].evidence_draft_error).toContain("no longer accepts evidence");
  });

  it("Stripe's own prefilled contact fields don't count as evidence in progress", async () => {
    await handleDisputeCreated(sb, dispute()); // liveDispute() default has a prefilled email
    expect(disputesUpdate).toHaveBeenCalledTimes(1);
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
    expect(r).toEqual({ retryable: false, flipBooking: false, statusBefore: "completed" });
    expect(disputesUpdate).not.toHaveBeenCalled();
    expect(alerts.sendDisputeOpenedAlert).not.toHaveBeenCalled();
  });

  it("only the delivery that stores the status asks for the booking flip", async () => {
    alerts.sendDisputeOpenedAlert.mockRejectedValueOnce(new Error("Resend down"));
    expect(await handleDisputeCreated(sb, dispute())).toEqual({ retryable: true, flipBooking: true, statusBefore: "completed" });
    db.tables.bookings[0].status = "disputed"; // the webhook's flip
    expect(await handleDisputeCreated(sb, dispute())).toEqual({ retryable: false, flipBooking: false, statusBefore: "completed" });
  });

  it("a delivery that died before its flip is flipped by the redelivery", async () => {
    // Row written, alert sent, then the function timed out: booking never flipped.
    db.seed("disputes", [
      { stripe_dispute_id: "dp_1", booking_id: "b1", booking_status_at_dispute: "completed", draft_attempted_at: "t", alert_sent_at: "t", closed_at: null },
    ]);
    expect(await handleDisputeCreated(sb, dispute())).toEqual({ retryable: false, flipBooking: true, statusBefore: "completed" });
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
    expect(await handleDisputeCreated(sb, dispute())).toEqual({ retryable: false, flipBooking: true, statusBefore: null });
    expect(sentry.capturePaymentError.mock.calls[0][0].message).toContain("migration 045");
  });

  it("a transient Stripe failure on the draft is retried once and the draft is saved", async () => {
    disputesUpdate.mockRejectedValueOnce(Object.assign(new Error("lock_timeout"), { type: "StripeRateLimitError", statusCode: 429 }));
    await handleDisputeCreated(sb, dispute());
    expect(disputesUpdate).toHaveBeenCalledTimes(2);
    // Same idempotency key on both attempts: a retry after a lost response
    // replays the first result instead of writing over an edit made since.
    expect(disputesUpdate.mock.calls[1][2].idempotencyKey).toBe(disputesUpdate.mock.calls[0][2].idempotencyKey);
    expect(db.tables.disputes[0].evidence_drafted_at).toBeTruthy();
    expect(alerts.sendDisputeOpenedAlert.mock.calls[0][0]).toMatchObject({ draftSaved: true });
  });

  it("a Stripe step that hangs is cut off at 15 s and the alert still goes out", async () => {
    vi.useFakeTimers();
    try {
      disputesUpdate.mockReturnValueOnce(new Promise(() => {}));
      const run = handleDisputeCreated(sb, dispute());
      await vi.advanceTimersByTimeAsync(15_000);
      const r = await run;
      expect(r.retryable).toBe(false);
      expect(db.tables.disputes[0].evidence_draft_error).toContain("timed out after 15000ms (it may still complete at Stripe)");
      expect(alerts.sendDisputeOpenedAlert).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a failed draft is recorded and still alerts, without a retry", async () => {
    disputesUpdate.mockRejectedValueOnce(new Error("evidence too long"));
    const r = await handleDisputeCreated(sb, dispute());
    expect(r.retryable).toBe(false);
    expect(disputesUpdate).toHaveBeenCalledTimes(1); // not transient: not retried
    expect(db.tables.disputes[0].evidence_draft_error).toBe("evidence too long");
    expect(alerts.sendDisputeOpenedAlert.mock.calls[0][0]).toMatchObject({ draftSaved: false, draftError: "evidence too long" });
  });

  it("a failed email releases its lease and asks for a retry; the retry sends it", async () => {
    alerts.sendDisputeOpenedAlert.mockRejectedValueOnce(new Error("Resend down"));
    const r1 = await handleDisputeCreated(sb, dispute());
    expect(r1.retryable).toBe(true);
    expect(db.tables.disputes[0].alert_sent_at).toBeFalsy();
    expect(db.tables.disputes[0].alert_claimed_at).toBeNull();
    const r2 = await handleDisputeCreated(sb, dispute());
    expect(r2.retryable).toBe(false);
    expect(db.tables.disputes[0].alert_sent_at).toBeTruthy();
    expect(alerts.sendDisputeOpenedAlert).toHaveBeenCalledTimes(2);
    expect(disputesUpdate).toHaveBeenCalledTimes(1); // the draft is not redone
  });

  // Review pass 1 Critical: the old claim marked the alert "sent" BEFORE
  // Resend ran, so a delivery killed mid-send suppressed every redelivery.
  const leased = (claimedAt: string) => ({
    stripe_dispute_id: "dp_1",
    booking_id: "b1",
    booking_status_at_dispute: "completed",
    draft_attempted_at: "t",
    evidence_drafted_at: "t",
    alert_claimed_at: claimedAt,
    alert_sent_at: null,
    closed_at: null,
  });

  it("a lease held by a live delivery: ask Stripe to come back, send nothing", async () => {
    db.seed("disputes", [leased(new Date().toISOString())]);
    expect((await handleDisputeCreated(sb, dispute())).retryable).toBe(true);
    expect(alerts.sendDisputeOpenedAlert).not.toHaveBeenCalled();
  });

  it("a lease left by a delivery that died mid-send is taken over and the alert goes out", async () => {
    db.seed("disputes", [leased(new Date(Date.now() - 3 * 60_000).toISOString())]);
    expect((await handleDisputeCreated(sb, dispute())).retryable).toBe(false);
    expect(alerts.sendDisputeOpenedAlert).toHaveBeenCalledTimes(1);
    expect(db.tables.disputes[0].alert_sent_at).toBeTruthy();
  });

  it("a failed send whose lease release also fails still goes out once the lease expires", async () => {
    alerts.sendDisputeOpenedAlert.mockRejectedValueOnce(new Error("Resend down"));
    db.failWhen("disputes", "update", (p) => p != null && "alert_claimed_at" in p && p.alert_claimed_at === null, "connection reset");
    expect((await handleDisputeCreated(sb, dispute())).retryable).toBe(true);
    expect(db.tables.disputes[0].alert_sent_at).toBeFalsy();
    expect(sentry.capturePaymentError.mock.calls.some(([e]) => e.message.includes("lease release failed"))).toBe(true);

    // Stripe redelivers before the lease expires: still held, retry again.
    expect((await handleDisputeCreated(sb, dispute())).retryable).toBe(true);
    // ...and after it expires: sent.
    db.tables.disputes[0].alert_claimed_at = new Date(Date.now() - 3 * 60_000).toISOString();
    expect((await handleDisputeCreated(sb, dispute())).retryable).toBe(false);
    expect(alerts.sendDisputeOpenedAlert).toHaveBeenCalledTimes(2);
  });

  it("an alert that went out but couldn't be marked sent is reported, not retried", async () => {
    db.failWhen("disputes", "update", (p) => p != null && "alert_sent_at" in p, "connection reset");
    expect((await handleDisputeCreated(sb, dispute())).retryable).toBe(false);
    expect(alerts.sendDisputeOpenedAlert).toHaveBeenCalledTimes(1);
    expect(sentry.capturePaymentError.mock.calls.some(([e]) => e.message.includes("alert sent but not recorded"))).toBe(true);
  });

  it("an earlier draft attempt that recorded no result: the alert says to check Stripe", async () => {
    db.seed("disputes", [
      { stripe_dispute_id: "dp_1", booking_id: "b1", booking_status_at_dispute: "completed", draft_attempted_at: "t", closed_at: null },
    ]);
    await handleDisputeCreated(sb, dispute());
    expect(disputesUpdate).not.toHaveBeenCalled();
    expect(alerts.sendDisputeOpenedAlert.mock.calls[0][0]).toMatchObject({ draftSaved: false, draftUnknown: true });
    expect(sentry.capturePaymentError.mock.calls.some(([e]) => e.message.includes("recorded no result"))).toBe(true);
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
    expect(buildEvidence(BOOKING, "general", FACTS).uncategorized_text).toContain("check-in 2026-10-10 08:00");
  });

  it("a duplicate claim gets a duplicate explanation", () => {
    expect(buildEvidence(BOOKING, "duplicate", FACTS).duplicate_charge_explanation).toContain("RTL828863");
  });

  it("an uncancelled, unrefunded booking rebuts a 'cancelled' or 'refund' claim", () => {
    expect(buildEvidence(BOOKING, "subscription_canceled", FACTS).cancellation_rebuttal).toContain("no cancellation");
    // Facts only — no paraphrase of when a refund is due (round 2 High).
    expect(buildEvidence(BOOKING, "credit_not_processed", FACTS).refund_refusal_explanation).toBe(
      "Triply's booking record for this reservation shows no cancellation, and Stripe shows no refund on this charge."
    );
  });

  it("the refund policy quotes the Terms (\"typically\"), not checkout", () => {
    const e = buildEvidence(BOOKING, "general", FACTS);
    expect(e.refund_policy_disclosure).toContain("typically appear within 5-10 business days");
    expect(e.refund_policy_disclosure).not.toContain("disclosed at checkout");
  });

  it("a cancelled booking never gets a 'no cancellation' rebuttal", () => {
    const cancelled = { ...BOOKING, status: "cancelled", cancelled_by: "customer" };
    expect(buildEvidence(cancelled, "subscription_canceled", FACTS).cancellation_rebuttal).toBeUndefined();
    expect(buildEvidence(cancelled, "credit_not_processed", FACTS).refund_refusal_explanation).toBeUndefined();
  });

  // Review pass 1: every refund path writes `refunded`, and `cancelled_by` is
  // NULL on every cancel before 2026-09-30.
  it("a refunded booking with no cancelled_by gets no 'no cancellation / no refund' line", () => {
    const refunded = { ...BOOKING, status: "refunded", cancelled_by: null };
    const charge = { ...PAID, refundedCents: 6356 };
    expect(buildEvidence(refunded, "credit_not_processed", { contact: CHECKOUT, charge }).refund_refusal_explanation).toBeUndefined();
    expect(buildEvidence(refunded, "subscription_canceled", { contact: CHECKOUT, charge }).cancellation_rebuttal).toBeUndefined();
  });

  // Round 3 (Codex): a cancel whose refund failed stays `confirmed`, and its
  // cancelled_by write is best-effort.
  it("a cancel that was started (held or refund pending) gets no 'no cancellation' line", () => {
    for (const over of [
      { cancel_state: "reslab_cancelled_refund_pending" },
      { cancel_state: "held_reslab_ambiguous" },
      { cancel_claimed_at: "2026-10-05T10:00:00+00:00" },
    ]) {
      const midCancel = { ...BOOKING, status: "confirmed", ...over };
      expect(buildEvidence(midCancel, "credit_not_processed", FACTS).refund_refusal_explanation).toBeUndefined();
      expect(buildEvidence(midCancel, "subscription_canceled", FACTS).cancellation_rebuttal).toBeUndefined();
    }
  });

  it("a partial refund (status still confirmed) gets no rebuttal and shows the refund", () => {
    const confirmed = { ...BOOKING, status: "confirmed" };
    const charge = { ...PAID, refundedCents: 1299 };
    const e = buildEvidence(confirmed, "credit_not_processed", { contact: CHECKOUT, charge });
    expect(e.refund_refusal_explanation).toBeUndefined();
    expect(e.uncategorized_text).toContain("Refunded to the card so far: $12.99.");
  });

  it("states the card amount from Stripe and the part paid at the lot separately", () => {
    const e = buildEvidence({ ...BOOKING, due_at_location: "12.50" }, "general", FACTS);
    expect(e.uncategorized_text).toContain("Charged online by Triply: $63.56.");
    // No figure: a CAD-priced lot's at-lot amount would be mislabelled in the charge currency.
    expect(e.uncategorized_text).toContain("Part of the reservation price was payable directly at the facility; Triply did not charge it.");
    expect(e.uncategorized_text).not.toContain("12.50");
    expect(e.product_description).toContain("part of the price payable at the facility");
    expect(e.product_description).not.toMatch(/prepaid/i);
  });

  it("nothing paid at the lot: no at-lot line", () => {
    expect(buildEvidence(BOOKING, "general", FACTS).uncategorized_text).not.toContain("payable directly at the facility");
  });

  it("a booking made before the current Terms §5 gets no policy text", () => {
    const old = { ...BOOKING, created_at: "2026-08-01T15:00:00+00:00" };
    const e = buildEvidence(old, "subscription_canceled", FACTS);
    expect(e.cancellation_policy_disclosure).toBeUndefined();
    expect(e.refund_policy_disclosure).toBeUndefined();
    expect(e.cancellation_rebuttal).toBe("Triply's booking record for this reservation shows no cancellation.");
    expect(buildEvidence(BOOKING, "general", FACTS).cancellation_policy_disclosure).toContain("Triply account");
  });

  it("an unknown pre-dispute status makes no cancellation claim either way", () => {
    for (const status of [null, "disputed"]) {
      const e = buildEvidence({ ...BOOKING, status }, "credit_not_processed", FACTS);
      expect(e.refund_refusal_explanation).toBeUndefined();
      expect(e.uncategorized_text).toContain("status before the dispute: not recorded");
    }
  });

  it("every reason has hand steps", () => {
    for (const r of ["fraudulent", "product_not_received", "credit_not_processed", "duplicate", "anything"]) {
      expect(playbookFor(r).addByHand.length).toBeGreaterThan(0);
    }
  });
});
