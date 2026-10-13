/**
 * The payout Stripe reader: every doubt is an error (→ a person decides),
 * never a 0 that could be paid or called refunded.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const { retrieve, listDisputes } = vi.hoisted(() => ({ retrieve: vi.fn(), listDisputes: vi.fn() }));
vi.mock("@/lib/stripe/client", () => ({ stripe: { paymentIntents: { retrieve }, disputes: { list: listDisputes } } }));

import { readPayoutStripe, readPayoutStripeMany } from "../payout-stripe";

const charge = (o: Record<string, unknown> = {}) => ({ amount_refunded: 0, disputed: false, balance_transaction: { fee: 181 }, ...o });
const pi = (o: Record<string, unknown> = {}) => ({ id: "pi_a", status: "succeeded", amount_received: 5212, latest_charge: charge(), ...o });

beforeEach(() => {
  retrieve.mockReset().mockResolvedValue(pi());
  listDisputes.mockReset().mockResolvedValue({ data: [], has_more: false });
});

describe("readPayoutStripe", () => {
  it("reads integer cents, the dispute flag and the fee, with the charge expanded", async () => {
    expect(await readPayoutStripe("pi_a")).toEqual({ error: null, amountReceivedCents: 5212, amountRefundedCents: 0, piStatus: "succeeded", disputed: false, disputes: "", feeCents: 181 });
    expect(listDisputes).not.toHaveBeenCalled();
    expect(retrieve).toHaveBeenCalledWith("pi_a", { expand: ["latest_charge.balance_transaction"] }, expect.objectContaining({ maxNetworkRetries: 1 }));
  });

  it("passes Stripe's own dispute flag through, with each dispute's status (sorted)", async () => {
    retrieve.mockResolvedValue(pi({ latest_charge: charge({ disputed: true }) }));
    listDisputes.mockResolvedValue({ data: [{ id: "du_2", status: "won", amount: 5212 }, { id: "du_1", status: "lost", amount: 1000 }], has_more: false });
    expect(await readPayoutStripe("pi_a")).toMatchObject({ error: null, disputed: true, disputes: "du_1:lost:1000,du_2:won:5212" });
    expect(listDisputes).toHaveBeenCalledWith({ payment_intent: "pi_a", limit: 10 }, expect.objectContaining({ maxNetworkRetries: 1 }));
  });

  it.each([
    ["disputes unreadable (Error)", () => listDisputes.mockRejectedValue(new Error("down"))],
    ["more than 10 disputes", () => listDisputes.mockResolvedValue({ data: [{ id: "du_1", status: "won", amount: 1 }], has_more: true })],
    ["disputed, but no dispute found", () => listDisputes.mockResolvedValue({ data: [], has_more: false })],
  ])("a disputed charge whose disputes cannot be read is unknown: %s", async (error, arrange) => {
    retrieve.mockResolvedValue(pi({ latest_charge: charge({ disputed: true }) }));
    arrange();
    expect(await readPayoutStripe("pi_a")).toMatchObject({ error, disputed: null, disputes: null, amountReceivedCents: null });
  });

  it("a failed read is an error with every figure unknown, never 0", async () => {
    retrieve.mockRejectedValue(Object.assign(new Error("No such payment_intent"), { type: "StripeInvalidRequestError", code: "resource_missing" }));
    expect(await readPayoutStripe("pi_a")).toEqual({
      error: "read failed (StripeInvalidRequestError/resource_missing)",
      amountReceivedCents: null,
      amountRefundedCents: null,
      piStatus: null,
      disputed: null,
      disputes: null,
      feeCents: null,
    });
  });

  it("a released hold (nothing received, no charge) reads as 0 / 0, not disputed", async () => {
    retrieve.mockResolvedValue(pi({ status: "canceled", amount_received: 0, latest_charge: null }));
    expect(await readPayoutStripe("pi_a")).toMatchObject({ error: null, amountReceivedCents: 0, amountRefundedCents: 0, piStatus: "canceled", disputed: false });
  });

  it.each([
    ["money received but no charge", { latest_charge: null }],
    ["charge missing from the reply", { latest_charge: undefined }],
    ["charge was not expanded", { latest_charge: "ch_1" }],
    ["refund amount unreadable", { latest_charge: charge({ amount_refunded: -1 }) }],
    ["refund amount unreadable", { latest_charge: charge({ amount_refunded: 1.5 }) }],
    ["dispute flag unreadable", { latest_charge: charge({ disputed: undefined }) }],
    ["amount received unreadable", { amount_received: 52.12 }],
  ])("refuses to guess: %s", async (error, o) => {
    retrieve.mockResolvedValue(pi(o));
    expect(await readPayoutStripe("pi_a")).toMatchObject({ error, amountReceivedCents: null, amountRefundedCents: null });
  });

  it("an unreadable fee is unknown; the other figures still read", async () => {
    retrieve.mockResolvedValue(pi({ latest_charge: charge({ balance_transaction: "txn_1" }) }));
    expect(await readPayoutStripe("pi_a")).toMatchObject({ error: null, amountReceivedCents: 5212, feeCents: null });
  });
});

describe("readPayoutStripeMany", () => {
  it("one bad reply never aborts the others", async () => {
    retrieve.mockImplementation(async (id: string) => {
      if (id === "pi_bad") return null; // a reply shaped unlike the SDK's types
      if (id === "pi_err") throw new Error("boom");
      return pi({ id });
    });
    const out = await readPayoutStripeMany(["pi_1", "pi_bad", "pi_err", "pi_2"]);
    expect([...out.keys()].sort()).toEqual(["pi_1", "pi_2", "pi_bad", "pi_err"]);
    expect(out.get("pi_1")).toMatchObject({ error: null });
    expect(out.get("pi_bad")?.error).toMatch(/unreadable reply/);
    expect(out.get("pi_err")?.error).toMatch(/read failed/);
  });

  it("never runs more than 10 reads at once", async () => {
    let inFlight = 0;
    let peak = 0;
    retrieve.mockImplementation(async (id: string) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return pi({ id });
    });
    await readPayoutStripeMany(Array.from({ length: 25 }, (_, i) => `pi_${i}`));
    expect(peak).toBe(10);
  });
});
