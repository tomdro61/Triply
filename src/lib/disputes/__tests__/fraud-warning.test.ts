/**
 * Radar early fraud warnings: one ledger row, one alert, never a refund.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type Stripe from "stripe";

const { db, sentry, alerts } = await vi.hoisted(async () => {
  const { FakeSupabase } = await import("@/lib/booking/__tests__/supabase-fake");
  return {
    db: new FakeSupabase(),
    sentry: { capturePaymentError: vi.fn() },
    alerts: { sendFraudWarningAlert: vi.fn() },
  };
});

vi.mock("@/lib/sentry", () => sentry);
vi.mock("@/lib/resend/send-dispute-alert", () => alerts);

import { handleEarlyFraudWarning } from "../fraud-warning";

type Db = Parameters<typeof handleEarlyFraudWarning>[0];
const sb = db as unknown as Db; // test double only

function warning(over: Partial<Stripe.Radar.EarlyFraudWarning> = {}): Stripe.Radar.EarlyFraudWarning {
  return {
    id: "issfr_1",
    charge: "ch_1",
    payment_intent: "pi_1",
    fraud_type: "made_with_stolen_card",
    actionable: true,
    livemode: true,
    ...over,
  } as Stripe.Radar.EarlyFraudWarning;
}

beforeEach(() => {
  db.clearFailures();
  db.seed("bookings", [
    { id: "b1", stripe_payment_intent_id: "pi_1", reslab_reservation_number: "RTL1", status: "confirmed", check_in: "2026-12-01T08:00:00", grand_total: 42 },
  ]).seed("fraud_warnings", []);
  sentry.capturePaymentError.mockReset();
  alerts.sendFraudWarningAlert.mockReset().mockResolvedValue(undefined);
});

describe("handleEarlyFraudWarning", () => {
  it("records the warning against its booking and alerts once, even when redelivered", async () => {
    expect((await handleEarlyFraudWarning(sb, warning())).retryable).toBe(false);
    expect((await handleEarlyFraudWarning(sb, warning())).retryable).toBe(false);
    expect(db.tables.fraud_warnings).toHaveLength(1);
    expect(db.tables.fraud_warnings[0].booking_id).toBe("b1");
    expect(alerts.sendFraudWarningAlert).toHaveBeenCalledTimes(1);
    expect(alerts.sendFraudWarningAlert.mock.calls[0][0]).toMatchObject({ confirmationNumber: "RTL1" });
    // No amount: grand_total is not the card charge, and a warning carries none.
    expect(alerts.sendFraudWarningAlert.mock.calls[0][0]).not.toHaveProperty("amount");
    expect(db.tables.fraud_warnings[0].alert_sent_at).toBeTruthy();
  });

  it("a failed email releases the lease and asks for a retry; the retry sends it", async () => {
    alerts.sendFraudWarningAlert.mockRejectedValueOnce(new Error("Resend down"));
    expect((await handleEarlyFraudWarning(sb, warning())).retryable).toBe(true);
    expect(db.tables.fraud_warnings[0].alert_sent_at).toBeFalsy();
    expect(db.tables.fraud_warnings[0].alert_claimed_at).toBeNull();
    expect((await handleEarlyFraudWarning(sb, warning())).retryable).toBe(false);
    expect(alerts.sendFraudWarningAlert).toHaveBeenCalledTimes(2);
  });

  // The #149 lost-alert class: the old claim marked "sent" before Resend ran.
  it("a lease left by a delivery that died mid-send is taken over; a live one makes Stripe come back", async () => {
    const row = (claimedAt: string) => ({
      stripe_warning_id: "issfr_1",
      booking_id: "b1",
      alert_claimed_at: claimedAt,
      alert_sent_at: null,
    });
    db.seed("fraud_warnings", [row(new Date().toISOString())]);
    expect((await handleEarlyFraudWarning(sb, warning())).retryable).toBe(true);
    expect(alerts.sendFraudWarningAlert).not.toHaveBeenCalled();

    db.seed("fraud_warnings", [row(new Date(Date.now() - 3 * 60_000).toISOString())]);
    expect((await handleEarlyFraudWarning(sb, warning())).retryable).toBe(false);
    expect(alerts.sendFraudWarningAlert).toHaveBeenCalledTimes(1);
  });

  it("non-actionable and test warnings still alert", async () => {
    await handleEarlyFraudWarning(sb, warning({ actionable: false }));
    await handleEarlyFraudWarning(sb, warning({ id: "issfr_2", livemode: false }));
    expect(alerts.sendFraudWarningAlert).toHaveBeenCalledTimes(2);
  });

  it("a missing table (migration 046 not applied) is reported, not retried", async () => {
    db.failOnce("fraud_warnings", "insert", "relation does not exist", "42P01");
    expect((await handleEarlyFraudWarning(sb, warning())).retryable).toBe(false);
    expect(sentry.capturePaymentError.mock.calls[0][0].message).toContain("migration 046");
  });

  it("a failed booking lookup asks for a retry", async () => {
    db.failOnce("bookings", "select", "timeout");
    expect((await handleEarlyFraudWarning(sb, warning())).retryable).toBe(true);
    expect(alerts.sendFraudWarningAlert).not.toHaveBeenCalled();
  });
});
