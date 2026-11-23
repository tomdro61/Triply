/**
 * GET /auth/confirm — the password-reset email's link. It stores the token in
 * a cookie and moves on; it never contacts Supabase.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextResponse } from "next/server";

const h = vi.hoisted(() => ({ capture: vi.fn() }));
vi.mock("@/lib/sentry", () => ({ captureAPIError: h.capture }));

const { GET } = await import("../route");

const ORIGIN = "https://www.triplypro.com";
const TOKEN = "0123456789abcdef".repeat(3);

function link(params: Record<string, string>): Request {
  return new Request(`${ORIGIN}/auth/confirm?${new URLSearchParams(params)}`);
}

async function open(request: Request): Promise<NextResponse> {
  return GET(request);
}

beforeEach(() => h.capture.mockReset());

describe("GET /auth/confirm", () => {
  it("stores the token in a cookie and goes to the reset page with a clean address", async () => {
    const res = await open(link({ token_hash: TOKEN, type: "recovery" }));

    expect(res.status).toBe(307);
    const location = res.headers.get("location");
    expect(location).toBe(`${ORIGIN}/auth/reset-password?link=1`);
    expect(location).not.toContain(TOKEN);

    // Read as parsed attributes: a text match would pass on Max-Age=6000.
    expect(res.cookies.get("triply_recovery_token")).toMatchObject({
      value: TOKEN,
      httpOnly: true,
      secure: true,
      sameSite: "strict",
      path: "/auth/recover",
      maxAge: 600,
    });
    expect(res.cookies.getAll()).toHaveLength(1);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(h.capture).not.toHaveBeenCalled();
  });

  it.each([
    ["no token", { type: "recovery" }, "token"],
    ["no type", { token_hash: TOKEN }, "type"],
    ["another type", { token_hash: TOKEN, type: "signup" }, "type"],
    ["a token with a cookie separator", { token_hash: `${TOKEN};Path=/`, type: "recovery" }, "token"],
    ["a token that is too short", { token_hash: "abc", type: "recovery" }, "token"],
  ])("sends %s back to ask for a new link, with no cookie, and says which check failed", async (_name, params, reason) => {
    const res = await open(link(params));

    expect(res.headers.get("location")).toBe(`${ORIGIN}/auth/forgot-password?error=expired`);
    expect(res.cookies.getAll()).toHaveLength(0);

    expect(h.capture).toHaveBeenCalledTimes(1);
    const [error, context] = h.capture.mock.calls[0];
    expect(context).toMatchObject({ level: "warning", fingerprint: ["password-reset", "confirm-bad-link"] });
    expect(context.extra).toMatchObject({ reason });
    // Which check, never the value.
    expect(`${(error as Error).message} ${JSON.stringify(context)}`).not.toContain(TOKEN);
  });

  it("stays on the host the link was opened on", async () => {
    const res = await open(
      new Request(`https://preview.example.test/auth/confirm?token_hash=${TOKEN}&type=recovery`)
    );
    expect(res.headers.get("location")).toBe("https://preview.example.test/auth/reset-password?link=1");
  });
});
