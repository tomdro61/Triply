/** More cases for src/lib/direct/__tests__/payout-stripe.test.ts (same helpers). */
import { describe, it, expect, beforeEach, vi } from "vitest";

const { retrieve, listDisputes } = vi.hoisted(() => ({ retrieve: vi.fn(), listDisputes: vi.fn() }));
vi.mock("@/lib/stripe/client", () => ({ stripe: { paymentIntents: { retrieve }, disputes: { list: listDisputes } } }));

import { readPayoutStripe } from "@/lib/direct/payout-stripe";

const charge = (o: Record<string, unknown> = {}) => ({ amount_refunded: 0, disputed: false, balance_transaction: { fee: 181 }, ...o });
const pi = (o: Record<string, unknown> = {}) => ({ id: "pi_a", status: "succeeded", amount_received: 5212, latest_charge: charge(), ...o });

beforeEach(() => {
  retrieve.mockReset().mockResolvedValue(pi());
  listDisputes.mockReset().mockResolvedValue({ data: [], has_more: false });
});

describe("readPayoutStripe (more cases)", () => {
  it("S1 passes a refund through in cents", async () => {
    retrieve.mockResolvedValue(pi({ latest_charge: charge({ amount_refunded: 500 }) }));
    expect(await readPayoutStripe("pi_a")).toMatchObject({ error: null, amountReceivedCents: 5212, amountRefundedCents: 500, feeCents: 181 });
  });

  it("S2 refuses a negative amount received", async () => {
    retrieve.mockResolvedValue(pi({ amount_received: -1 }));
    expect(await readPayoutStripe("pi_a")).toMatchObject({ error: "amount received unreadable", amountReceivedCents: null });
  });
});
