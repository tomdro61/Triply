/**
 * fetchFromCms's optional `signal`: once it fires, no request or retry
 * starts. Without it (every other caller), one request with the 8 s timeout
 * as before.
 */
import { describe, it, expect, afterEach, vi } from "vitest";

vi.mock("@/lib/sentry", () => ({ captureAPIError: vi.fn() }));

import { fetchFromCms } from "../cms";

afterEach(() => vi.unstubAllGlobals());

const ok = () => new Response(JSON.stringify({ docs: [] }), { status: 200 });

describe("fetchFromCms signal", () => {
  it("without a signal: one request, carrying the timeout signal, as before", async () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => ok());
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchFromCms("/posts")).resolves.toEqual({ docs: [] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("an already-aborted signal starts no request", async () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => ok());
    vi.stubGlobal("fetch", fetchMock);
    const c = new AbortController();
    c.abort(new Error("budget"));
    await expect(fetchFromCms("/posts", {}, 60, c.signal)).rejects.toThrow("budget");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a signal fired mid-request aborts it and starts no retry", async () => {
    const c = new AbortController();
    let inFlight: RequestInit | undefined;
    const fetchMock = vi
      .fn<(url: string, init?: RequestInit) => Promise<Response>>(() => Promise.resolve(ok()))
      .mockImplementationOnce((_url, init) => {
        inFlight = init;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        });
      });
    vi.stubGlobal("fetch", fetchMock);
    const pending = fetchFromCms("/posts", {}, 60, c.signal);
    c.abort(new Error("budget"));
    // Aborted now, not when its own 8 s timeout fires.
    expect(inFlight?.signal?.aborted).toBe(true);
    await expect(pending).rejects.toThrow("budget");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
