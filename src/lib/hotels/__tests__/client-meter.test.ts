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
import { LiteApiBudgetError } from "@/lib/hotels/liteapi/budget";

const fetchMock = vi.fn();

beforeEach(() => {
  takeLiteApiCall.mockReset();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("liteApiRequest metering", () => {
  it("takes one budget call before a search request", async () => {
    takeLiteApiCall.mockResolvedValue({ allowed: true, calls: 1, denied: 0 });
    await liteApiRequest("data", "/data/hotels", { meter: "search" });
    expect(takeLiteApiCall).toHaveBeenCalledWith("sandbox", "/data/hotels");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(takeLiteApiCall.mock.invocationCallOrder[0]).toBeLessThan(fetchMock.mock.invocationCallOrder[0]);
  });

  it("never sends a search request the budget refused", async () => {
    takeLiteApiCall.mockRejectedValue(new LiteApiBudgetError("exhausted", "spent"));
    await expect(liteApiRequest("data", "/hotels/rates", { meter: "search", method: "POST", body: {} })).rejects.toBeInstanceOf(LiteApiBudgetError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never touches the budget for an unmetered (booking / cancel) request", async () => {
    await liteApiRequest("book", "/bookings/abc", { meter: "unmetered", method: "PUT" });
    expect(takeLiteApiCall).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
