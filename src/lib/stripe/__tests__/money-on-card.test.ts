import { describe, it, expect, beforeEach, vi } from "vitest";

const retrieve = vi.hoisted(() => vi.fn());
const update = vi.hoisted(() => vi.fn());
const capturePaymentError = vi.hoisted(() => vi.fn());
vi.mock("../client", () => ({ stripe: { paymentIntents: { retrieve, update } } }));
vi.mock("@/lib/sentry", () => ({ capturePaymentError }));

import { moneyOnCard, readCard, markAlerted, formatMoneyOnCard, ALERTED_METADATA_KEY } from "../money-on-card";

const pi = (over: Record<string, unknown>) => ({
  id: "pi_1",
  currency: "usd",
  amount: 2537,
  amount_capturable: 0,
  amount_received: 0,
  latest_charge: null,
  livemode: true,
  metadata: { customerEmail: "ada@example.com" },
  ...over,
});

beforeEach(() => vi.clearAllMocks());

describe("moneyOnCard / readCard", () => {
  it("reads AFTER the fact, bounded at 4 s with no retries, with the charge expanded", async () => {
    retrieve.mockResolvedValue(pi({ status: "requires_capture", amount_capturable: 2537 }));
    expect(await moneyOnCard("pi_1")).toEqual({ kind: "hold", amountCents: 2537, currency: "usd" });
    expect(retrieve).toHaveBeenCalledWith("pi_1", { expand: ["latest_charge"] }, { timeout: 4_000, maxNetworkRetries: 0 });
  });

  it("readCard also returns the metadata email, livemode and the alerted marker", async () => {
    retrieve.mockResolvedValue(pi({ status: "requires_capture", amount_capturable: 2537, livemode: false, metadata: { customerEmail: " ada@example.com ", [ALERTED_METADATA_KEY]: "2026-10-28T20:00:00.000Z" } }));
    expect(await readCard("pi_1")).toEqual({
      money: { kind: "hold", amountCents: 2537, currency: "usd" },
      customerEmail: "ada@example.com",
      livemode: false,
      alreadyAlerted: true,
    });
  });

  it("a metadata email without @ is null; no marker → not alerted", async () => {
    retrieve.mockResolvedValue(pi({ status: "processing", metadata: { customerEmail: "nope" } }));
    expect(await readCard("pi_1")).toEqual({ money: { kind: "unknown" }, customerEmail: null, livemode: true, alreadyAlerted: false });
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

  it("an unexpanded charge id counts as not refunded", async () => {
    retrieve.mockResolvedValue(pi({ status: "succeeded", amount_received: 2537, latest_charge: "ch_1" }));
    expect(await moneyOnCard("pi_1")).toEqual({ kind: "captured", amountCents: 2537, currency: "usd" });
  });

  it.each(["processing", "canceled", "requires_payment_method"])("%s → unknown", async (status) => {
    retrieve.mockResolvedValue(pi({ status }));
    expect(await moneyOnCard("pi_1")).toEqual({ kind: "unknown" });
  });

  it("a failed read → unknown / nulls, reported with the PaymentIntent id", async () => {
    retrieve.mockRejectedValue(new Error("timeout"));
    expect(await readCard("pi_1")).toEqual({ money: { kind: "unknown" }, customerEmail: null, livemode: null, alreadyAlerted: false });
    expect(capturePaymentError).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ stripePaymentIntentId: "pi_1" }));
  });
});

describe("markAlerted", () => {
  it("writes the marker to the PaymentIntent's metadata, bounded", async () => {
    update.mockResolvedValue({});
    expect(await markAlerted("pi_1", new Date("2026-10-28T20:00:00Z"))).toBe(true);
    expect(update).toHaveBeenCalledWith("pi_1", { metadata: { [ALERTED_METADATA_KEY]: "2026-10-28T20:00:00.000Z" } }, { timeout: 4_000, maxNetworkRetries: 0 });
  });

  it("a failed write → false, reported (the caller may alert again)", async () => {
    update.mockRejectedValue(new Error("stripe down"));
    expect(await markAlerted("pi_1")).toBe(false);
    expect(capturePaymentError).toHaveBeenCalledTimes(1);
  });
});

describe("formatMoneyOnCard", () => {
  it("formats USD with a dollar sign, other currencies with their code, unknown as null", () => {
    expect(formatMoneyOnCard({ kind: "hold", amountCents: 2537, currency: "usd" })).toBe("$25.37");
    expect(formatMoneyOnCard({ kind: "captured", amountCents: 1000, currency: "cad" })).toBe("10.00 CAD");
    expect(formatMoneyOnCard({ kind: "unknown" })).toBeNull();
  });
});
