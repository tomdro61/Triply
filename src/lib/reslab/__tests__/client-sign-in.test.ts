/**
 * A ResLab call that fails at the sign-in (POST /authenticate) is marked as
 * such, so search can report `auth_…` instead of blaming the price call. The
 * error itself is unchanged: the booking engine branches on its class and name.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const fetchMock = vi.fn();

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// A fresh module per test: the token cache is module state.
async function freshClient() {
  vi.resetModules();
  return import("../client");
}

const item = {
  type: "parking",
  reservation_type: "parking",
  from_date: "2026-11-20 10:00:00",
  to_date: "2026-11-22 14:00:00",
  number_of_spots: 1,
} as const;

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ResLab sign-in failures", () => {
  it("a refused sign-in is marked and stays a ReslabError", async () => {
    const { reslab, ReslabError, isReslabSignInFailure } = await freshClient();
    fetchMock.mockResolvedValue(json(503, { message: "down" }));
    const err = await reslab.getMinPrice(1, item).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReslabError);
    expect((err as InstanceType<typeof ReslabError>).statusCode).toBe(503);
    expect((err as Error).message).toMatch(/^Authentication failed/);
    expect(isReslabSignInFailure(err)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a sign-in that times out is marked and stays an AbortError", async () => {
    const { reslab, isReslabSignInFailure } = await freshClient();
    const timeout = new DOMException("This operation was aborted", "AbortError");
    fetchMock.mockRejectedValue(timeout);
    const err = await reslab.getMinPrice(1, item).catch((e: unknown) => e);
    expect(err).toBe(timeout);
    expect(isReslabSignInFailure(err)).toBe(true);
  });

  it("a failed re-sign-in after a 401 is marked", async () => {
    const { reslab, ReslabError, isReslabSignInFailure } = await freshClient();
    let signIns = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/authenticate")) {
        signIns++;
        return signIns === 1 ? json(200, { token: "old" }) : json(503, { message: "down" });
      }
      return json(401, { message: "Unauthenticated" });
    });
    const err = await reslab.getMinPrice(1, item).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReslabError);
    expect((err as InstanceType<typeof ReslabError>).statusCode).toBe(503);
    expect(isReslabSignInFailure(err)).toBe(true);
  });

  it("a retried call that fails after a good re-sign-in is not marked", async () => {
    const { reslab, ReslabError, isReslabSignInFailure } = await freshClient();
    let calls = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/authenticate")) return json(200, { token: "t" });
      calls++;
      return calls === 1 ? json(401, { message: "Unauthenticated" }) : json(502, { message: "bad gateway" });
    });
    const err = await reslab.getMinPrice(1, item).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReslabError);
    expect((err as InstanceType<typeof ReslabError>).statusCode).toBe(502);
    expect(isReslabSignInFailure(err)).toBe(false);
  });

  it("a failure of the price call itself is not marked", async () => {
    const { reslab, ReslabError, isReslabSignInFailure } = await freshClient();
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith("/authenticate") ? json(200, { token: "t1" }) : json(502, { message: "bad gateway" })
    );
    const err = await reslab.getMinPrice(1, item).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReslabError);
    expect((err as InstanceType<typeof ReslabError>).statusCode).toBe(502);
    expect(isReslabSignInFailure(err)).toBe(false);

    const timeout = new DOMException("This operation was aborted", "AbortError");
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/authenticate")) return json(200, { token: "t2" });
      throw timeout;
    });
    const err2 = await reslab.getMinPrice(2, item).catch((e: unknown) => e);
    expect(err2).toBe(timeout);
    expect(isReslabSignInFailure(err2)).toBe(false);
  });
});
