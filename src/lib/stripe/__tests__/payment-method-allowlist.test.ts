import { describe, it, expect, vi, beforeEach } from "vitest";
import type Stripe from "stripe";
import { stripe, createPaymentIntent, CHECKOUT_PAYMENT_METHOD_TYPES } from "../client";

// 2026-10-13: production checkout offered Klarna and a bank-debit tab although
// both had been turned off in the Dashboard in July. The allowed methods are now
// set on every PaymentIntent; this pins it.
describe("createPaymentIntent — payment methods are an allowlist in code", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("offers card (incl. Apple Pay / Google Pay) and Link only — never the Dashboard's automatic set", async () => {
    const spy = vi
      .spyOn(stripe.paymentIntents, "create")
      .mockResolvedValue({ id: "pi_test" } as Stripe.Response<Stripe.PaymentIntent>);
    await createPaymentIntent(44.04, { lotId: "reslab-275" });
    const params = spy.mock.calls[0][0];
    expect(params.payment_method_types).toEqual(["card", "link"]);
    expect(params).not.toHaveProperty("automatic_payment_methods");
    expect(params.amount).toBe(4404);
  });

  it("the allowlist holds no redirect or delayed method", () => {
    const slow = ["klarna", "affirm", "afterpay_clearpay", "cashapp", "us_bank_account", "ach_debit", "sepa_debit", "zip"];
    for (const m of CHECKOUT_PAYMENT_METHOD_TYPES) expect(slow).not.toContain(m);
  });

  it("cards are still authorized, not charged (manual capture on card)", async () => {
    const spy = vi
      .spyOn(stripe.paymentIntents, "create")
      .mockResolvedValue({ id: "pi_test" } as Stripe.Response<Stripe.PaymentIntent>);
    await createPaymentIntent(10, {});
    expect(spy.mock.calls[0][0].payment_method_options).toEqual({ card: { capture_method: "manual" } });
  });
});
