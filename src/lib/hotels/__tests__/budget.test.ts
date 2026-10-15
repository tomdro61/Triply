import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const captureAPIError = vi.fn();
vi.mock("@/lib/sentry", () => ({ captureAPIError: (...args: unknown[]) => captureAPIError(...args) }));
vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: () => {
    throw new Error("tests must inject the rpc");
  },
}));

import { BUDGET_RPC_TIMEOUT_MS, LiteApiBudgetError, takeLiteApiCall, type BudgetRpc } from "@/lib/hotels/liteapi/budget";

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
  it("takes from the mode's own budget and returns the row", async () => {
    const { rpc, calls } = rpcReturning([{ allowed: true, calls: 2, denied: 0 }]);
    await expect(takeLiteApiCall("sandbox", "/hotels/rates", rpc, LIMITS)).resolves.toEqual({ allowed: true, calls: 2, denied: 0 });
    expect(calls).toEqual([{ p_provider: "liteapi", p_mode: "sandbox", p_limit: 3 }]);
    expect(captureAPIError).not.toHaveBeenCalled();
  });

  it("refuses a spent budget and reports only the day's first refusal", async () => {
    const first = await refusal(takeLiteApiCall("live", "/hotels/rates", rpcReturning([{ allowed: false, calls: 7, denied: 1 }]).rpc, LIMITS));
    expect(first.reason).toBe("exhausted");
    expect(captureAPIError).toHaveBeenCalledTimes(1);
    expect(captureAPIError.mock.calls[0][1]).toMatchObject({ stage: "budget_exhausted" });

    const later = await refusal(takeLiteApiCall("live", "/hotels/rates", rpcReturning([{ allowed: false, calls: 7, denied: 2 }]).rpc, LIMITS));
    expect(later.reason).toBe("exhausted");
    expect(captureAPIError).toHaveBeenCalledTimes(1);
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
  });
});
