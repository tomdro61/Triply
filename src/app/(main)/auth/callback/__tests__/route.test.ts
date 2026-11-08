/**
 * GET /auth/callback — Supabase sends a person here after Google sign-in or
 * the sign-up email link. After the code exchange they go to `next`, but only
 * when it is a page of our own site; anything else goes to the homepage.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  exchange: vi.fn(async (_code: string) => ({ data: {}, error: null as { message: string } | null })),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { exchangeCodeForSession: h.exchange } }),
}));

const { GET } = await import("../route");

const ORIGIN = "https://www.triplypro.com";

// Built with URLSearchParams, so a tab or backslash reaches the route as the
// raw character (a literal tab in a URL is stripped by the parser).
function callback(params: Record<string, string>): Request {
  return new Request(`${ORIGIN}/auth/callback?${new URLSearchParams(params)}`);
}

beforeEach(() => {
  h.exchange.mockClear();
  h.exchange.mockResolvedValue({ data: {}, error: null });
});

describe("GET /auth/callback", () => {
  it("goes to a page of ours after a successful sign-in", async () => {
    const res = await GET(callback({ code: "abc", next: "/account" }));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(`${ORIGIN}/account`);
    expect(h.exchange).toHaveBeenCalledWith("abc");
  });

  it("goes to the homepage when there is no next", async () => {
    const res = await GET(callback({ code: "abc" }));
    expect(res.headers.get("location")).toBe(`${ORIGIN}/`);
  });

  it.each([
    "/\\evil.example",
    "/\t/evil.example",
    "/\n/evil.example",
    "//evil.example",
    "https://evil.example",
    "/.//evil.example",
    "/%2e//evil.example",
    "/auth/login",
  ])("sends next=%j to the homepage", async (next) => {
    const req = callback({ code: "abc", next });
    // The route must see the raw value, or the case proves nothing.
    expect(new URL(req.url).searchParams.get("next")).toBe(next);

    const res = await GET(req);
    expect(res.headers.get("location")).toBe(`${ORIGIN}/`);
  });

  it("goes to the login page when the code exchange fails", async () => {
    h.exchange.mockResolvedValue({ data: {}, error: { message: "invalid flow state" } });
    const res = await GET(callback({ code: "abc", next: "/account" }));
    expect(res.headers.get("location")).toBe(`${ORIGIN}/auth/login`);
  });

  it("goes to the login page without a code, and never tries an exchange", async () => {
    const res = await GET(callback({ next: "/account" }));
    expect(res.headers.get("location")).toBe(`${ORIGIN}/auth/login`);
    expect(h.exchange).not.toHaveBeenCalled();
  });
});
