import { describe, it, expect, vi } from "vitest";
import { postToDiscord } from "../discord";
import type { Embed } from "../render";

const embed: Embed = { title: "t", description: "d", color: 0, fields: [], footer: { text: "f" } };
const res = (status: number, body = "", headers: Record<string, string> = {}) =>
  // Node's Response forbids a body on 204/205/304.
  new Response([204, 205, 304].includes(status) ? null : body, { status, headers });

describe("postToDiscord — budgeted retry", () => {
  it("posts on 204 without retrying", async () => {
    const f = vi.fn(async () => res(204));
    const r = await postToDiscord("https://hook", embed, { remainingBudgetMs: 50_000, fetchImpl: f as unknown as typeof fetch });
    expect(r).toEqual({ kind: "posted", status: 204, retried: false });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("a 400 is not retried (a limits bug, not a blip)", async () => {
    const f = vi.fn(async () => res(400, '{"message":"Invalid Form Body"}'));
    const r = await postToDiscord("https://hook", embed, { remainingBudgetMs: 50_000, fetchImpl: f as unknown as typeof fetch });
    expect(r).toMatchObject({ kind: "failed", status: 400, retried: false });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("a 429 whose retry_after fits the budget is retried once after sleeping that long", async () => {
    const f = vi.fn().mockResolvedValueOnce(res(429, '{"retry_after": 1.5}')).mockResolvedValueOnce(res(204));
    const sleep = vi.fn(async () => {});
    const r = await postToDiscord("https://hook", embed, { remainingBudgetMs: 50_000, fetchImpl: f as unknown as typeof fetch, sleep });
    expect(r).toEqual({ kind: "posted", status: 204, retried: true });
    expect(sleep).toHaveBeenCalledWith(1500);
  });

  it("a 429 whose retry-after does NOT fit the budget goes straight to the loud path — no sleep, no second attempt", async () => {
    const f = vi.fn(async () => res(429, "", { "retry-after": "45" }));
    const sleep = vi.fn(async () => {});
    const r = await postToDiscord("https://hook", embed, { remainingBudgetMs: 20_000, fetchImpl: f as unknown as typeof fetch, sleep });
    expect(r).toMatchObject({ kind: "failed", status: 429, retried: false, body: expect.stringMatching(/exceeds the remaining budget/) });
    expect(sleep).not.toHaveBeenCalled();
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("a network error is a failed result, never a throw", async () => {
    const f = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });
    const r = await postToDiscord("https://hook", embed, { remainingBudgetMs: 50_000, fetchImpl: f as unknown as typeof fetch });
    expect(r).toMatchObject({ kind: "failed", status: null, body: "ECONNRESET" });
  });
});
