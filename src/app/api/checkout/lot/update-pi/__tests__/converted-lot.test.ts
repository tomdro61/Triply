/**
 * update-pi on a PaymentIntent for a lot whose price we convert (ResLab prices
 * it in Canadian dollars). No protection plan is offered there: the checkout
 * page hides the selector, and this route is the rule.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

const { stripeMock } = vi.hoisted(() => ({
  stripeMock: { paymentIntents: { retrieve: vi.fn(), update: vi.fn() } },
}));
vi.mock("@/lib/stripe/client", () => ({ stripe: stripeMock }));
vi.mock("@/lib/sentry", () => ({ capturePaymentError: vi.fn() }));

import { POST } from "../route";

const BASE = { inventorySource: "reslab", parkingOnlyChargeAmount: "97.16", parkingOnlyChargeAmountCents: "9716" };
const CAD = { ...BASE, reslabCurrency: "CAD", fxRateId: "r1", fxRateMicros: "725000" };

const post = (protectionPlanCode: string | null) =>
  POST(
    new NextRequest("http://localhost/api/checkout/lot/update-pi", {
      method: "POST",
      body: JSON.stringify({ paymentIntentId: "pi_c", protectionPlanCode }),
      headers: { "content-type": "application/json" },
    })
  );
const pi = (metadata: Record<string, string>) =>
  stripeMock.paymentIntents.retrieve.mockResolvedValue({ id: "pi_c", status: "requires_payment_method", amount: 9716, metadata });

beforeEach(() => {
  vi.clearAllMocks();
  stripeMock.paymentIntents.update.mockImplementation(async (_id: string, p: { amount: number; metadata: Record<string, string | null> }) => ({
    id: "pi_c",
    amount: p.amount,
    metadata: p.metadata,
  }));
});

describe("update-pi on a converted (Canadian-dollar) lot", () => {
  it("adding a plan is refused and Stripe is not updated", async () => {
    pi(CAD);
    const res = await post("A");
    expect(res.status).toBe(422);
    expect(stripeMock.paymentIntents.update).not.toHaveBeenCalled();
  });

  it("declining is allowed: the amount stays the parking-only charge and the rate stamp survives", async () => {
    pi(CAD);
    const res = await post(null);
    expect(res.status).toBe(200);
    const [, params] = stripeMock.paymentIntents.update.mock.calls[0];
    expect(params.amount).toBe(9716);
    expect(params.metadata).toMatchObject(CAD);
  });

  it("an unknown currency stamp is treated like a converted lot (no plan)", async () => {
    pi({ ...BASE, reslabCurrency: "EUR" });
    expect((await post("A")).status).toBe(422);
  });

  it.each([
    ["a US lot", { ...BASE, reslabCurrency: "USD" }],
    ["a PaymentIntent from before the stamp existed", BASE],
  ])("%s takes a plan exactly as before", async (_n, metadata) => {
    pi(metadata);
    const res = await post("A");
    expect(res.status).toBe(200);
    const [, params] = stripeMock.paymentIntents.update.mock.calls[0];
    expect(params.amount).toBeGreaterThan(9716);
    expect(params.metadata).toMatchObject({ ...metadata, protectionPlanCode: "A" });
  });
});
