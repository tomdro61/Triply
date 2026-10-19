import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const takeLiteApiCall = vi.fn();
vi.mock("@/lib/hotels/liteapi/budget", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/hotels/liteapi/budget")>();
  return { ...actual, takeLiteApiCall: (...args: unknown[]) => takeLiteApiCall(...args) };
});
vi.mock("@/lib/hotels/liteapi/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/hotels/liteapi/env")>();
  return {
    ...actual,
    resolveHotelEnv: () => ({
      mode: "sandbox",
      apiKey: "test-key",
      dataBaseUrl: "https://data.test",
      bookBaseUrl: "https://book.test",
    }),
  };
});

import { liteApiRequest } from "@/lib/hotels/liteapi/client";
import { LiteApiBudgetError, BudgetTicket } from "@/lib/hotels/liteapi/budget";

const fetchMock = vi.fn();

/** A real ticket, minted by the real takeLiteApiCall through an injected rpc. */
async function realTicket(mode: "sandbox" | "live" = "sandbox"): Promise<BudgetTicket> {
  const actual = await vi.importActual<typeof import("@/lib/hotels/liteapi/budget")>("@/lib/hotels/liteapi/budget");
  return actual.takeLiteApiCall(mode, "/hotels/rates", async () => ({ data: [{ allowed: true, calls: 1, denied: 0 }], error: null }));
}

beforeEach(() => {
  takeLiteApiCall.mockReset();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("liteApiRequest metering", () => {
  it("search: takes one budget call before the request", async () => {
    takeLiteApiCall.mockResolvedValue({ allowed: true, calls: 1, denied: 0 });
    await liteApiRequest("data", "/data/hotels", { meter: "search" });
    expect(takeLiteApiCall).toHaveBeenCalledWith("sandbox", "/data/hotels");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(takeLiteApiCall.mock.invocationCallOrder[0]).toBeLessThan(fetchMock.mock.invocationCallOrder[0]);
  });

  it("search: never sends a request the budget refused", async () => {
    takeLiteApiCall.mockRejectedValue(new LiteApiBudgetError("exhausted", "spent"));
    await expect(liteApiRequest("data", "/hotels/rates", { meter: "search", method: "POST", body: {} })).rejects.toBeInstanceOf(LiteApiBudgetError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("prepaid: spends the caller's ticket and NEVER calls the self-meter (no double take)", async () => {
    const ticket = await realTicket();
    await liteApiRequest("data", "/hotels/rates", { meter: "prepaid", ticket, method: "POST", body: {} });
    expect(takeLiteApiCall).not.toHaveBeenCalled();
    expect(ticket.spent).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("prepaid: a spent ticket cannot pay for a second call, and nothing is sent", async () => {
    const ticket = await realTicket();
    await liteApiRequest("data", "/hotels/rates", { meter: "prepaid", ticket, method: "POST", body: {} });
    await expect(liteApiRequest("data", "/hotels/rates", { meter: "prepaid", ticket, method: "POST", body: {} })).rejects.toThrow(/already spent/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("prepaid: a ticket taken for the other mode is refused before sending", async () => {
    const ticket = await realTicket("live");
    await expect(liteApiRequest("data", "/hotels/rates", { meter: "prepaid", ticket })).rejects.toThrow(/live, not sandbox/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("unmetered: never touches the budget (booking / cancel)", async () => {
    await liteApiRequest("book", "/bookings/abc", { meter: "unmetered", method: "PUT" });
    expect(takeLiteApiCall).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
