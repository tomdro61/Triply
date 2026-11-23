/**
 * POST /auth/recover/verify — the reset page's Continue button. It spends the
 * token from the cookie and answers with the account's email.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

type AuthError = { status?: number; code?: string } | null;
type UserResult = { data: { user: { email?: string } | null }; error: AuthError };

const TOKEN = "0123456789abcdef".repeat(3);
const ORIGIN = "https://www.triplypro.com";

const h = vi.hoisted(() => ({
  cookie: undefined as string | undefined,
  verifyOtp: vi.fn(),
  getUser: vi.fn(),
  capture: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "triply_recovery" && h.cookie !== undefined ? { name, value: h.cookie } : undefined,
  }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { verifyOtp: h.verifyOtp, getUser: h.getUser } }),
}));
vi.mock("@/lib/sentry", () => ({ captureAPIError: h.capture }));

const { POST } = await import("../route");

const accepted = (email: string | undefined): UserResult => ({ data: { user: { email } }, error: null });
const failed = (error: AuthError): UserResult => ({ data: { user: null }, error });

function press(headers: Record<string, string> = { origin: ORIGIN }): Request {
  return new Request(`${ORIGIN}/auth/recover/verify`, { method: "POST", headers });
}

/** True when the response tells the browser to drop the token cookie. */
function clearsToken(res: Response): boolean {
  const cookie = res.headers.get("set-cookie") ?? "";
  return /triply_recovery=;/.test(cookie) && /Max-Age=0/i.test(cookie) && /Path=\/auth(;|$)/i.test(cookie);
}

beforeEach(() => {
  h.cookie = TOKEN;
  h.verifyOtp.mockReset();
  h.getUser.mockReset();
  h.capture.mockReset();
  h.verifyOtp.mockResolvedValue(accepted("someone@example.com"));
  h.getUser.mockResolvedValue(failed({ status: 400, code: "session_not_found" }));
});

describe("POST /auth/recover/verify", () => {
  it("spends the token and answers with the account's email", async () => {
    const res = await POST(press());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email: "someone@example.com" });
    expect(h.verifyOtp).toHaveBeenCalledWith({ type: "recovery", token_hash: TOKEN });
    expect(clearsToken(res)).toBe(true);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(h.capture).not.toHaveBeenCalled();
  });

  it("refuses a request from another site before touching the token", async () => {
    const res = await POST(press({ origin: "https://evil.example" }));

    expect(res.status).toBe(403);
    expect(h.verifyOtp).not.toHaveBeenCalled();
    expect(h.getUser).not.toHaveBeenCalled();
    expect(clearsToken(res)).toBe(false);
  });

  it("answers 410 for a spent link when nobody is signed in, and drops the cookie", async () => {
    h.verifyOtp.mockResolvedValue(failed({ status: 403, code: "otp_expired" }));

    const res = await POST(press());

    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ error: "expired" });
    expect(clearsToken(res)).toBe(true);
    expect(h.capture).not.toHaveBeenCalled();
  });

  it("goes on for a spent link when a second tab already signed the person in", async () => {
    h.verifyOtp.mockResolvedValue(failed({ status: 403, code: "otp_expired" }));
    h.getUser.mockResolvedValue(accepted("someone@example.com"));

    const res = await POST(press());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email: "someone@example.com" });
  });

  it.each([
    ["Supabase is down", { status: 503 }],
    ["the request never arrived", { status: 0 }],
    ["there is no status", {}],
    ["Supabase rate-limits us", { status: 429 }],
  ])("keeps the token and answers 502 when %s", async (_name, error) => {
    h.verifyOtp.mockResolvedValue(failed(error));

    const res = await POST(press());

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "check_failed" });
    expect(clearsToken(res)).toBe(false);
    // Not answered from the session: the link may still be good.
    expect(h.getUser).not.toHaveBeenCalled();
    expect(h.capture).toHaveBeenCalledTimes(1);
  });

  it("does not go on when the token is accepted but no account comes back", async () => {
    h.verifyOtp.mockResolvedValue(accepted(undefined));

    const res = await POST(press());

    expect(res.status).toBe(502);
    expect(h.capture).toHaveBeenCalledTimes(1);
  });

  it("with no cookie, uses the signed-in account without calling verify", async () => {
    h.cookie = undefined;
    h.getUser.mockResolvedValue(accepted("someone@example.com"));

    const res = await POST(press());

    expect(res.status).toBe(200);
    expect(h.verifyOtp).not.toHaveBeenCalled();
  });

  it("with no cookie and nobody signed in, answers 410", async () => {
    h.cookie = undefined;

    const res = await POST(press());

    expect(res.status).toBe(410);
    expect(h.verifyOtp).not.toHaveBeenCalled();
  });

  it("never sends a malformed cookie value to Supabase", async () => {
    h.cookie = "not a token; drop";

    const res = await POST(press());

    expect(h.verifyOtp).not.toHaveBeenCalled();
    expect(res.status).toBe(410);
  });

  it("answers 502, not 410, when the session cannot be read", async () => {
    h.cookie = undefined;
    h.getUser.mockResolvedValue(failed({ status: 500 }));

    const res = await POST(press());

    expect(res.status).toBe(502);
    expect(h.capture).toHaveBeenCalledTimes(1);
  });

  it("puts no email address in a Sentry report", async () => {
    h.verifyOtp.mockResolvedValue(failed({ status: 503 }));
    await POST(press());

    const [error, context] = h.capture.mock.calls[0];
    expect(error).toBeInstanceOf(Error);
    expect(`${(error as Error).message} ${JSON.stringify(context)}`).not.toContain("@");
  });

  it("accepts a request with no Origin header (a non-browser caller holds no cookie anyway)", async () => {
    const res = await POST(press({}));
    expect(res.status).toBe(200);
  });
});
