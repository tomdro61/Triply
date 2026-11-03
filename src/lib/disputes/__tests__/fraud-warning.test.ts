/**
 * Radar early fraud warnings: one ledger row, one alert, one Command Center
 * task for actionable live warnings, and never a refund.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type Stripe from "stripe";

const { db, sentry, alerts, cc } = await vi.hoisted(async () => {
  const { FakeSupabase } = await import("@/lib/booking/__tests__/supabase-fake");
  return {
    db: new FakeSupabase(),
    sentry: { capturePaymentError: vi.fn() },
    alerts: { sendFraudWarningAlert: vi.fn() },
    cc: { commandCenterConfigured: vi.fn(), createCommandCenterTask: vi.fn() },
  };
});

vi.mock("@/lib/sentry", () => sentry);
vi.mock("@/lib/resend/send-dispute-alert", () => alerts);
vi.mock("@/lib/command-center/create-task", () => cc);

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
  cc.commandCenterConfigured.mockReset().mockReturnValue(true);
  cc.createCommandCenterTask.mockReset().mockResolvedValue("t1");
});

describe("handleEarlyFraudWarning", () => {
  it("records the warning against its booking and alerts once, even when redelivered", async () => {
    expect((await handleEarlyFraudWarning(sb, warning())).retryable).toBe(false);
    expect((await handleEarlyFraudWarning(sb, warning())).retryable).toBe(false);
    expect(db.tables.fraud_warnings).toHaveLength(1);
    expect(db.tables.fraud_warnings[0].booking_id).toBe("b1");
    expect(alerts.sendFraudWarningAlert).toHaveBeenCalledTimes(1);
    expect(alerts.sendFraudWarningAlert.mock.calls[0][0]).toMatchObject({ confirmationNumber: "RTL1", amount: "$42.00" });
    expect(cc.createCommandCenterTask).toHaveBeenCalledTimes(1);
    expect(cc.createCommandCenterTask.mock.calls[0][0].title).toContain("refund $42.00 booking RTL1");
  });

  it("a failed email releases the claim and asks for a retry", async () => {
    alerts.sendFraudWarningAlert.mockRejectedValueOnce(new Error("Resend down"));
    expect((await handleEarlyFraudWarning(sb, warning())).retryable).toBe(true);
    expect(db.tables.fraud_warnings[0].alert_sent_at).toBeNull();
    expect((await handleEarlyFraudWarning(sb, warning())).retryable).toBe(false);
    expect(alerts.sendFraudWarningAlert).toHaveBeenCalledTimes(2);
  });

  it("a non-actionable or test warning alerts but adds no task", async () => {
    await handleEarlyFraudWarning(sb, warning({ actionable: false }));
    await handleEarlyFraudWarning(sb, warning({ id: "issfr_2", livemode: false }));
    expect(alerts.sendFraudWarningAlert).toHaveBeenCalledTimes(2);
    expect(cc.createCommandCenterTask).not.toHaveBeenCalled();
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
