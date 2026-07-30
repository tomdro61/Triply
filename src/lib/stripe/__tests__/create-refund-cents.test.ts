import { describe, it, expect, vi, beforeEach } from "vitest";
import type Stripe from "stripe";
import { stripe, createRefundCents, createRefund } from "../client";

// Regression guard for the payment-atomicity Critical: the self-cancel path
// computes refunds in CENTS, so it must call the cents-native helper. If a
// cents value ever reaches the dollars-based createRefund, refunds go out 100×.
const okRefund = () =>
  vi
    .spyOn(stripe.refunds, "create")
    .mockResolvedValue({ id: "re_test" } as unknown as Stripe.Response<Stripe.Refund>);

describe("createRefundCents", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("passes CENTS straight through (no ×100) with the idempotency key", async () => {
    const spy = okRefund();
    await createRefundCents("pi_123", 9707, "cancel-refund:pi_123");
    expect(spy).toHaveBeenCalledWith(
      { payment_intent: "pi_123", amount: 9707 },
      { idempotencyKey: "cancel-refund:pi_123" },
    );
  });

  it("100×-bug guard: 6601 cents is sent as 6601, not 660100", async () => {
    const spy = okRefund();
    await createRefundCents("pi_123", 6601);
    const arg = spy.mock.calls[0][0];
    expect(arg.amount).toBe(6601);
    expect(arg.amount).not.toBe(660100);
  });

  it("agrees with createRefund(dollars) for an equivalent amount", async () => {
    const spy = okRefund();
    await createRefundCents("pi_1", 9707); // cents
    await createRefund("pi_1", 97.07); // dollars → ×100 internally
    expect(spy.mock.calls[0][0].amount).toBe(9707);
    expect(spy.mock.calls[1][0].amount).toBe(9707);
  });

  it("omits the idempotency options when no key is given", async () => {
    const spy = okRefund();
    await createRefundCents("pi_1", 500);
    expect(spy).toHaveBeenCalledWith(
      { payment_intent: "pi_1", amount: 500 },
      undefined,
    );
  });
});
