import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const captureAPIError = vi.fn();
vi.mock("@/lib/sentry", () => ({ captureAPIError: (...args: unknown[]) => captureAPIError(...args) }));
vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: () => {
    throw new Error("tests must inject the rpc");
  },
}));

import { BUDGET_RPC_TIMEOUT_MS, BudgetTicket, LiteApiBudgetError, takeLiteApiCall, type BudgetRpc } from "@/lib/hotels/liteapi/budget";

const LIMITS = { live: 7, sandbox: 3 };

function rpcReturning(data: unknown, error: { message: string; code?: string } | null = null) {
  const calls: Parameters<BudgetRpc>[0][] = [];
  const rpc: BudgetRpc = async (args) => {
    calls.push(args);
    return { data, error };
  };
  return { rpc, calls };
}

async function refusal(p: Promise<unknown>): Promise<LiteApiBudgetError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof LiteApiBudgetError) return err;
    throw err;
  }
  throw new Error("expected a LiteApiBudgetError");
}

beforeEach(() => captureAPIError.mockClear());
afterEach(() => vi.useRealTimers());

describe("takeLiteApiCall", () => {
  it("takes from the mode's own budget and returns an unspent ticket carrying the row", async () => {
    const { rpc, calls } = rpcReturning([{ allowed: true, calls: 2, denied: 0 }]);
    const ticket = await takeLiteApiCall("sandbox", "/hotels/rates", rpc, LIMITS);
    expect(ticket).toBeInstanceOf(BudgetTicket);
    expect(ticket.row).toEqual({ allowed: true, calls: 2, denied: 0 });
    expect(ticket.mode).toBe("sandbox");
    expect(ticket.spent).toBe(false);
    expect(calls).toEqual([{ p_provider: "liteapi", p_mode: "sandbox", p_limit: 3 }]);
    expect(captureAPIError).not.toHaveBeenCalled();
  });

  it("labels its Sentry events with the calling route", async () => {
    await refusal(takeLiteApiCall("live", "/hotels/rates", rpcReturning(null, { message: "boom" }).rpc, LIMITS, "/api/park-stay/hotel"));
    expect(captureAPIError.mock.calls[0][1]).toMatchObject({ endpoint: "/api/park-stay/hotel" });
  });

  it("refuses a spent budget and reports on the refusal ladder only", async () => {
    for (const denied of [1, 2, 9, 10, 11, 100, 999, 1000, 2000, 2001]) {
      const err = await refusal(takeLiteApiCall("live", "/hotels/rates", rpcReturning([{ allowed: false, calls: 7, denied }]).rpc, LIMITS));
      expect(err.reason).toBe("exhausted");
    }
    expect(captureAPIError.mock.calls.map((c) => (c[1] as { extra: { denied: number } }).extra.denied)).toEqual([1, 10, 100, 1000, 2000]);
    expect(captureAPIError.mock.calls[0][1]).toMatchObject({ stage: "budget_exhausted" });
    expect(String(captureAPIError.mock.calls[0][0])).toContain("spent");
  });

  it("names the off switch rather than calling it spent", async () => {
    await refusal(takeLiteApiCall("live", "/hotels/rates", rpcReturning([{ allowed: false, calls: 0, denied: 1 }]).rpc, { live: 0, sandbox: 0 }));
    expect(String(captureAPIError.mock.calls[0][0])).toContain("switched off");
  });

  it("fails closed on a database error", async () => {
    const err = await refusal(takeLiteApiCall("live", "/data/hotels", rpcReturning(null, { message: "boom", code: "XX000" }).rpc, LIMITS));
    expect(err.reason).toBe("unavailable");
    expect(captureAPIError.mock.calls[0][1]).toMatchObject({ stage: "budget_unavailable" });
  });

  it("fails closed on a result it cannot read", async () => {
    for (const data of [null, [], [{ allowed: "yes", calls: 1, denied: 0 }], { allowed: true, calls: 1, denied: 0 }]) {
      const err = await refusal(takeLiteApiCall("live", "/data/hotels", rpcReturning(data).rpc, LIMITS));
      expect(err.reason).toBe("unavailable");
    }
  });

  it("fails closed when the database does not answer in time", async () => {
    vi.useFakeTimers();
    const never: BudgetRpc = () => new Promise(() => {});
    const p = refusal(takeLiteApiCall("sandbox", "/data/hotels", never, LIMITS));
    await vi.advanceTimersByTimeAsync(BUDGET_RPC_TIMEOUT_MS + 1);
    expect((await p).reason).toBe("unavailable");
    expect(captureAPIError.mock.calls[0][1]).toMatchObject({ extra: { outcomeUnknown: true } });
  });
});

describe("BudgetTicket — single use, minted only by takeLiteApiCall (§7.2)", () => {
  async function ticket(): Promise<BudgetTicket> {
    return takeLiteApiCall("sandbox", "/hotels/rates", rpcReturning([{ allowed: true, calls: 1, denied: 0 }]).rpc, LIMITS);
  }

  it("spends once; a second spend throws", async () => {
    const t = await ticket();
    t.spend("sandbox");
    expect(t.spent).toBe(true);
    expect(() => t.spend("sandbox")).toThrow(/already spent/);
  });

  it("refuses a spend for the other mode", async () => {
    const t = await ticket();
    expect(() => t.spend("live")).toThrow(/sandbox, not live/);
    expect(t.spent).toBe(false);
  });

  it("cannot be constructed outside budget.ts (type and runtime)", () => {
    const fake = Symbol("BudgetTicket.issue");
    // @ts-expect-error — the constructor demands budget.ts's private symbol
    expect(() => new BudgetTicket(fake, "sandbox", { allowed: true, calls: 1, denied: 0 })).toThrow(/only be issued/);
  });
});
