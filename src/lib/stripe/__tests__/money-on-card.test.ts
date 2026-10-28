import { describe, it, expect, beforeEach, vi } from "vitest";

const retrieve = vi.hoisted(() => vi.fn());
const capturePaymentError = vi.hoisted(() => vi.fn());
vi.mock("../client", () => ({ stripe: { paymentIntents: { retrieve } } }));
vi.mock("@/lib/sentry", () => ({ capturePaymentError }));

import { moneyOnCard, formatMoneyOnCard } from "../money-on-card";

const pi = (over: Record<string, unknown>) => ({
  id: "pi_1",
  currency: "usd",
  amount: 2537,
  amount_capturable: 0,
  amount_received: 0,
  latest_charge: null,
  ...over,
});

beforeEach(() => vi.clearAllMocks());

describe("moneyOnCard", () => {
  it("reads AFTER the fact, bounded at 4 s with no retries, with the charge expanded", async () => {
    retrieve.mockResolvedValue(pi({ status: "requires_capture", amount_capturable: 2537 }));
    expect(await moneyOnCard("pi_1")).toEqual({ kind: "hold", amountCents: 2537, currency: "usd" });
    expect(retrieve).toHaveBeenCalledWith("pi_1", { expand: ["latest_charge"] }, { timeout: 4_000, maxNetworkRetries: 0 });
  });

  it("succeeded with nothing refunded → captured", async () => {
    retrieve.mockResolvedValue(pi({ status: "succeeded", amount_received: 2537, latest_charge: { id: "ch_1", amount_refunded: 0 } }));
    expect(await moneyOnCard("pi_1")).toEqual({ kind: "captured", amountCents: 2537, currency: "usd" });
  });

  it("succeeded but refunded in full → refunded (never 'charged $X' for money already returned)", async () => {
    retrieve.mockResolvedValue(pi({ status: "succeeded", amount_received: 2537, latest_charge: { id: "ch_1", amount_refunded: 2537 } }));
    expect(await moneyOnCard("pi_1")).toEqual({ kind: "refunded", amountCents: 2537, currency: "usd" });
  });

  it("partially refunded → unknown (no figure is safer than a wrong one)", async () => {
    retrieve.mockResolvedValue(pi({ status: "succeeded", amount_received: 2537, latest_charge: { id: "ch_1", amount_refunded: 600 } }));
    expect(await moneyOnCard("pi_1")).toEqual({ kind: "unknown" });
  });

  it("an unexpanded charge id counts as not refunded (the expand is requested; an id means Stripe did not expand)", async () => {
    retrieve.mockResolvedValue(pi({ status: "succeeded", amount_received: 2537, latest_charge: "ch_1" }));
    expect(await moneyOnCard("pi_1")).toEqual({ kind: "captured", amountCents: 2537, currency: "usd" });
  });

  it.each(["processing", "canceled", "requires_payment_method"])("%s → unknown", async (status) => {
    retrieve.mockResolvedValue(pi({ status }));
    expect(await moneyOnCard("pi_1")).toEqual({ kind: "unknown" });
  });

  it("a failed read → unknown, reported with the PaymentIntent id", async () => {
    retrieve.mockRejectedValue(new Error("timeout"));
    expect(await moneyOnCard("pi_1")).toEqual({ kind: "unknown" });
    expect(capturePaymentError).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ stripePaymentIntentId: "pi_1" }));
  });
});

describe("formatMoneyOnCard", () => {
  it("formats USD with a dollar sign, other currencies with their code, unknown as null", () => {
    expect(formatMoneyOnCard({ kind: "hold", amountCents: 2537, currency: "usd" })).toBe("$25.37");
    expect(formatMoneyOnCard({ kind: "captured", amountCents: 1000, currency: "cad" })).toBe("10.00 CAD");
    expect(formatMoneyOnCard({ kind: "unknown" })).toBeNull();
  });
});
