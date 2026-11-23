/**
 * GET /auth/confirm — the password-reset email's link. It stores the token in
 * a cookie and moves on; it never contacts Supabase.
 */
import { describe, it, expect } from "vitest";
import { GET } from "../route";

const ORIGIN = "https://www.triplypro.com";
const TOKEN = "0123456789abcdef".repeat(3);

function link(params: Record<string, string>): Request {
  return new Request(`${ORIGIN}/auth/confirm?${new URLSearchParams(params)}`);
}

describe("GET /auth/confirm", () => {
  it("stores the token in a cookie and goes to the reset page with a clean address", async () => {
    const res = await GET(link({ token_hash: TOKEN, type: "recovery" }));

    expect(res.status).toBe(307);
    const location = res.headers.get("location");
    expect(location).toBe(`${ORIGIN}/auth/reset-password?link=1`);
    expect(location).not.toContain(TOKEN);

    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`triply_recovery=${TOKEN}`);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/SameSite=strict/i);
    expect(cookie).toMatch(/Path=\/auth(;|$)/i);
    expect(cookie).toMatch(/Max-Age=600/i);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it.each([
    ["no token", { type: "recovery" }],
    ["no type", { token_hash: TOKEN }],
    ["another type", { token_hash: TOKEN, type: "signup" }],
    ["a token with a cookie separator", { token_hash: `${TOKEN};Path=/`, type: "recovery" }],
    ["a token that is too short", { token_hash: "abc", type: "recovery" }],
  ])("sends %s back to ask for a new link, with no cookie", async (_name, params) => {
    const res = await GET(link(params));
    expect(res.headers.get("location")).toBe(`${ORIGIN}/auth/forgot-password?error=expired`);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("stays on the host the link was opened on", async () => {
    const res = await GET(
      new Request(`https://preview.example.test/auth/confirm?token_hash=${TOKEN}&type=recovery`)
    );
    expect(res.headers.get("location")).toBe("https://preview.example.test/auth/reset-password?link=1");
  });
});
