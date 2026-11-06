/**
 * gscQuery's optional `signal`: once it fires, the request in flight is
 * aborted and no further page is requested.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { gscQuery } from "../client";

beforeAll(() => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  process.env.GOOGLE_ANALYTICS_SA_KEY = Buffer.from(
    JSON.stringify({ client_email: "test@example.iam.gserviceaccount.com", private_key: privateKey })
  ).toString("base64");
});
afterEach(() => vi.unstubAllGlobals());

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe("gscQuery signal", () => {
  it("an already-aborted signal makes no request", async () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => json({}));
    vi.stubGlobal("fetch", fetchMock);
    const c = new AbortController();
    c.abort(new Error("budget"));
    await expect(gscQuery({ dimensions: ["page"] }, { signal: c.signal })).rejects.toThrow("budget");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a signal fired mid-request aborts the request in flight", async () => {
    let queryInit: RequestInit | undefined;
    const fetchMock = vi.fn((url: string, init?: RequestInit): Promise<Response> => {
      if (url.includes("oauth2")) return Promise.resolve(json({ access_token: "t", expires_in: 3600 }));
      queryInit = init;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const c = new AbortController();
    const pending = gscQuery({ dimensions: ["page"] }, { signal: c.signal });
    await vi.waitFor(() => expect(queryInit).toBeDefined());
    c.abort(new Error("budget"));
    expect(queryInit?.signal?.aborted).toBe(true);
    await expect(pending).rejects.toThrow("budget");
    expect(fetchMock.mock.calls.filter(([url]) => !url.includes("oauth2"))).toHaveLength(1);
  });
});
