/**
 * POST /auth/recover/verify — the reset page's Continue button. It spends the
 * token from the cookie and answers with the account.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { NextResponse } from "next/server";
import type { AuthFailure } from "@/lib/auth/recovery";

type User = { id?: string; email?: string };
type Result = { data: { user: User | null }; error: AuthFailure | null };

const TOKEN = "0123456789abcdef".repeat(3);
const ORIGIN = "https://www.triplypro.com";
const COOKIE = "triply_recovery_token";
const ACCOUNT: User = { id: "u-1", email: "someone@example.com" };

const h = vi.hoisted(() => ({
  cookie: undefined as string | undefined,
  verifyOtp: vi.fn(),
  getUser: vi.fn(),
  capture: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "triply_recovery_token" && h.cookie !== undefined ? { name, value: h.cookie } : undefined,
  }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { verifyOtp: h.verifyOtp, getUser: h.getUser } }),
}));
vi.mock("@/lib/sentry", () => ({ captureAPIError: h.capture }));

const { POST } = await import("../route");

const found = (user: User): Result => ({ data: { user }, error: null });
const failed = (error: AuthFailure): Result => ({ data: { user: null }, error });
const NOBODY = failed({ status: 400, name: "AuthSessionMissingError" });

async function press(headers: Record<string, string> = { origin: ORIGIN }): Promise<NextResponse> {
  return POST(new Request(`${ORIGIN}/auth/recover/verify`, { method: "POST", headers }));
}

/** True when the response tells the browser to drop the token cookie, at the path it was set on. */
function clearsToken(res: NextResponse): boolean {
  const cookie = res.cookies.get(COOKIE);
  return cookie !== undefined && cookie.value === "" && cookie.maxAge === 0 && cookie.path === "/auth/recover";
}

/** The keys of the Sentry reports sent, in order. */
function reportKeys(): string[] {
  return h.capture.mock.calls.map(([, context]) => (context.fingerprint as string[])[1]);
}

beforeEach(() => {
  h.cookie = TOKEN;
  h.verifyOtp.mockReset();
  h.getUser.mockReset();
  h.capture.mockReset();
  h.verifyOtp.mockResolvedValue(found(ACCOUNT));
  h.getUser.mockResolvedValue(NOBODY);
});

afterEach(() => vi.useRealTimers());

describe("POST /auth/recover/verify", () => {
  it("spends the token and answers with the account", async () => {
    const res = await press();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email: "someone@example.com", userId: "u-1", switched: false });
    expect(h.verifyOtp).toHaveBeenCalledWith({ type: "recovery", token_hash: TOKEN });
    expect(clearsToken(res)).toBe(true);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(h.capture).not.toHaveBeenCalled();
  });

  it("says so when the link replaced a different signed-in account", async () => {
    h.getUser.mockResolvedValue(found({ id: "u-other", email: "other@example.com" }));

    const res = await press();

    expect(await res.json()).toEqual({ email: "someone@example.com", userId: "u-1", switched: true });
  });

  it("does not say 'switched' for the same account, or when the earlier session could not be read", async () => {
    h.getUser.mockResolvedValue(found(ACCOUNT));
    expect(await (await press()).json()).toMatchObject({ switched: false });

    h.getUser.mockResolvedValue(failed({ status: 503 }));
    const res = await press();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ switched: false });
  });

  it.each([
    "https://evil.example",
    "null",
    "http://www.triplypro.com",
    "https://www.triplypro.com:8443",
    "https://triplypro.com",
    "https://www.triplypro.com.evil.example",
  ])("refuses Origin %j before touching the token, and reports it", async (origin) => {
    const res = await press({ origin });

    expect(res.status).toBe(403);
    expect(h.verifyOtp).not.toHaveBeenCalled();
    expect(h.getUser).not.toHaveBeenCalled();
    expect(clearsToken(res)).toBe(false);
    expect(reportKeys()).toEqual(["verify-origin"]);
    expect(h.capture.mock.calls[0][1]).toMatchObject({ level: "warning" });
  });

  it("accepts a request with no Origin header (a non-browser caller holds no customer cookie)", async () => {
    const res = await press({});
    expect(res.status).toBe(200);
  });

  it("answers 410 for a spent link when nobody is signed in, drops the cookie, and notes it quietly", async () => {
    h.verifyOtp.mockResolvedValue(failed({ status: 403, code: "otp_expired" }));

    const res = await press();

    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ error: "expired" });
    expect(clearsToken(res)).toBe(true);
    expect(reportKeys()).toEqual(["verify-refused-otp_expired"]);
    expect(h.capture.mock.calls[0][1]).toMatchObject({ level: "info" });
  });

  it("reports any OTHER refusal louder: the template or a setting may be wrong for everyone", async () => {
    h.verifyOtp.mockResolvedValue(failed({ status: 400, code: "validation_failed" }));

    const res = await press();

    expect(res.status).toBe(410);
    expect(reportKeys()).toEqual(["verify-refused-validation_failed"]);
    expect(h.capture.mock.calls[0][1]).toMatchObject({ level: "warning" });
  });

  it("goes on for a spent link when a second tab already signed the person in", async () => {
    h.verifyOtp.mockResolvedValue(failed({ status: 403, code: "otp_expired" }));
    h.getUser.mockResolvedValue(found(ACCOUNT));

    const res = await press();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email: "someone@example.com", userId: "u-1", switched: false });
    expect(clearsToken(res)).toBe(true);
  });

  it.each([
    ["Supabase is down", { status: 503 }],
    ["the request never arrived", { status: 0 }],
    ["there is no status", {}],
    ["Supabase rate-limits us", { status: 429 }],
  ])("keeps the token and answers 502 when %s", async (_name, error) => {
    h.verifyOtp.mockResolvedValue(failed(error));

    const res = await press();

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "check_failed" });
    expect(clearsToken(res)).toBe(false);
    expect(res.cookies.get(COOKIE)).toBeUndefined();
    // Not answered from the session afterwards: the link may still be good.
    expect(h.getUser).toHaveBeenCalledTimes(1);
    expect(reportKeys()).toEqual(["verify-unreachable"]);
    // The default level, so the one alert rule sees it.
    expect(h.capture.mock.calls[0][1].level).toBeUndefined();
  });

  it("treats a call that throws like one that got no answer: 502, token kept, reported with the error's class", async () => {
    h.verifyOtp.mockRejectedValue(new TypeError("boom"));

    const res = await press();

    expect(res.status).toBe(502);
    expect(clearsToken(res)).toBe(false);
    expect(reportKeys()).toEqual(["verify-unreachable"]);
    expect(h.capture.mock.calls[0][1].extra).toMatchObject({ status: 0, name: "TypeError" });
  });

  it("does not wait forever on Supabase: 502 and the token kept after the time limit", async () => {
    vi.useFakeTimers();
    h.verifyOtp.mockReturnValue(new Promise(() => {}));

    const pending = press();
    await vi.advanceTimersByTimeAsync(8_001);
    const res = await pending;

    expect(res.status).toBe(502);
    expect(clearsToken(res)).toBe(false);
    expect(h.capture.mock.calls[0][1].extra).toMatchObject({ name: "Timeout" });
  });

  it.each([
    ["no account at all", { data: { user: null }, error: null }],
    ["an account with no email", found({ id: "u-1" })],
    ["an account with no id", found({ email: "someone@example.com" })],
  ])("does not go on when the token is accepted with %s; the spent cookie is dropped", async (_name, result) => {
    h.verifyOtp.mockResolvedValue(result);

    const res = await press();

    expect(res.status).toBe(502);
    expect(clearsToken(res)).toBe(true);
    expect(reportKeys()).toEqual(["verify-no-account"]);
  });

  it("with no cookie, uses the signed-in account without calling verify, and clears nothing it needs", async () => {
    h.cookie = undefined;
    h.getUser.mockResolvedValue(found(ACCOUNT));

    const res = await press();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email: "someone@example.com", userId: "u-1", switched: false });
    expect(h.verifyOtp).not.toHaveBeenCalled();
    expect(clearsToken(res)).toBe(true);
    expect(h.capture).not.toHaveBeenCalled();
  });

  it("with no cookie and nobody signed in, answers 410 without a report", async () => {
    h.cookie = undefined;

    const res = await press();

    expect(res.status).toBe(410);
    expect(h.verifyOtp).not.toHaveBeenCalled();
    expect(h.capture).not.toHaveBeenCalled();
  });

  it("never sends a malformed cookie value to Supabase", async () => {
    h.cookie = "not a token; drop";

    const res = await press();

    expect(h.verifyOtp).not.toHaveBeenCalled();
    expect(res.status).toBe(410);
  });

  it("answers 502, not 410, when the session cannot be read", async () => {
    h.cookie = undefined;
    h.getUser.mockResolvedValue(failed({ status: 500 }));

    const res = await press();

    expect(res.status).toBe(502);
    expect(clearsToken(res)).toBe(false);
    expect(reportKeys()).toEqual(["verify-session-unreachable"]);
  });

  it("puts neither an email address nor the token in any Sentry report", async () => {
    // Each path that reports while an account or the token is in reach.
    h.getUser.mockResolvedValue(found({ id: "u-other", email: "other@example.com" }));
    h.verifyOtp.mockResolvedValue(failed({ status: 503 }));
    await press();
    h.verifyOtp.mockResolvedValue(failed({ status: 403, code: "otp_expired" }));
    await press();
    h.verifyOtp.mockResolvedValue(found({ email: "someone@example.com" }));
    await press();
    await press({ origin: "https://evil.example" });

    expect(h.capture.mock.calls.length).toBeGreaterThanOrEqual(4);
    for (const [error, context] of h.capture.mock.calls) {
      const sent = `${(error as Error).message} ${JSON.stringify(context)}`;
      expect(sent).not.toContain("@");
      expect(sent).not.toContain(TOKEN);
    }
  });
});
