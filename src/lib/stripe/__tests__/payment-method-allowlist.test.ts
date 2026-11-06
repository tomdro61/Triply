import { describe, it, expect, vi, beforeEach } from "vitest";
import type Stripe from "stripe";
import { stripe, createPaymentIntent, CHECKOUT_PAYMENT_METHOD_TYPES } from "../client";
import { TERMS_VERSION } from "@/lib/checkout/terms-acceptance";

// 2026-10-13: production checkout offered Klarna and a bank-debit tab although
// both had been turned off in the Dashboard in July. The allowed methods are now
// set on every PaymentIntent; this pins it.
describe("createPaymentIntent — payment methods are an allowlist in code", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("offers card (incl. Apple Pay / Google Pay) and Link only — never the Dashboard's automatic set", async () => {
    const spy = vi
      .spyOn(stripe.paymentIntents, "create")
      .mockResolvedValue({ id: "pi_test" } as Stripe.Response<Stripe.PaymentIntent>);
    await createPaymentIntent(44.04, { lotId: "reslab-275" }, undefined);
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
    await createPaymentIntent(10, {}, undefined);
    expect(spy.mock.calls[0][0].payment_method_options).toEqual({ card: { capture_method: "manual" } });
  });

  // #150: the version the checkout RENDERED is stamped, and only a known one —
  // dispute evidence quotes its wording to the card issuer.
  it("stamps a known rendered terms version, and nothing for an unknown or missing one", async () => {
    const spy = vi
      .spyOn(stripe.paymentIntents, "create")
      .mockResolvedValue({ id: "pi_test" } as Stripe.Response<Stripe.PaymentIntent>);
    await createPaymentIntent(10, { lotId: "x" }, TERMS_VERSION);
    await createPaymentIntent(10, { lotId: "x" }, "1999-01-01");
    await createPaymentIntent(10, { lotId: "x" }, undefined);
    await createPaymentIntent(10, { lotId: "x", termsVersion: "spoofed" }, undefined);
    expect(spy.mock.calls[0][0].metadata).toEqual({ lotId: "x", termsVersion: TERMS_VERSION });
    expect(spy.mock.calls[1][0].metadata).toEqual({ lotId: "x" });
    expect(spy.mock.calls[2][0].metadata).toEqual({ lotId: "x" });
    // A caller-supplied metadata key is not how the stamp gets in: it is dropped.
    expect(spy.mock.calls[3][0].metadata).toEqual({ lotId: "x" });
  });
});
