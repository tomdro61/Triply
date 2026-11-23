import { describe, it, expect, vi } from "vitest";
import { RECOVERY_COPY } from "../recovery";
import { saveNewPassword, type SessionReader } from "../recovery-save";

const URL_BASE = "https://project.supabase.invalid";
const KEY = "anon-key";
const PASSWORD = "correct horse battery";

type Fetch = typeof fetch;

function reply(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A browser whose stored session can change between calls, as another tab would change it. */
function browser(tokens: { now: string | null }, owners: Record<string, string>): SessionReader {
  return {
    getSession: async () => ({
      data: { session: tokens.now ? { access_token: tokens.now } : null },
      error: null,
    }),
    getUser: async (jwt: string) =>
      owners[jwt]
        ? { data: { user: { id: owners[jwt] } }, error: null }
        : { data: { user: null }, error: { status: 403, code: "bad_jwt" } },
  };
}

function save(auth: SessionReader, fetchImpl: Fetch, expectedUserId = "user-a") {
  return saveNewPassword({ auth, expectedUserId, password: PASSWORD, supabaseUrl: URL_BASE, anonKey: KEY, fetchImpl });
}

describe("saveNewPassword", () => {
  it("sends the password with the token it checked, and reports done", async () => {
    const fetchImpl = vi.fn<Fetch>(async () => reply(200, { id: "user-a" }));

    const result = await save(browser({ now: "token-a" }, { "token-a": "user-a" }), fetchImpl);

    expect(result).toEqual({ step: "done", message: null, report: null, failure: null });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${URL_BASE}/auth/v1/user`);
    expect(init?.method).toBe("PUT");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer token-a");
    expect(new Headers(init?.headers).get("apikey")).toBe(KEY);
    expect(JSON.parse(String(init?.body))).toEqual({ password: PASSWORD });
  });

  it("[codex] another tab signs in as someone else AFTER the check: the save still goes to the checked account", async () => {
    const tokens = { now: "token-a" as string | null };
    const auth = browser(tokens, { "token-a": "user-a", "token-b": "user-b" });
    const getUser = auth.getUser;
    // The other tab's sign-in lands while "whose token is this?" is in flight.
    auth.getUser = async (jwt) => {
      const answer = await getUser(jwt);
      tokens.now = "token-b";
      return answer;
    };
    const fetchImpl = vi.fn<Fetch>(async () => reply(200));

    const result = await save(auth, fetchImpl);

    expect(result.step).toBe("done");
    // Account A's token, never B's: the session is read once.
    expect(new Headers(fetchImpl.mock.calls[0][1]?.headers).get("authorization")).toBe("Bearer token-a");
  });

  it("reads the session ONCE: the check is asked about the captured token, not a second read", async () => {
    const tokens = { now: "token-a" as string | null };
    const auth = browser(tokens, { "token-a": "user-a", "token-b": "user-b" });
    const getSession = auth.getSession;
    let reads = 0;
    // The other tab's sign-in lands right after the token is taken.
    auth.getSession = async () => {
      reads += 1;
      const answer = await getSession();
      tokens.now = "token-b";
      return answer;
    };
    const getUser = vi.fn(auth.getUser);
    auth.getUser = getUser;
    const fetchImpl = vi.fn<Fetch>(async () => reply(200));

    const result = await save(auth, fetchImpl);

    expect(reads).toBe(1);
    expect(getUser).toHaveBeenCalledWith("token-a");
    expect(result.step).toBe("done");
    expect(new Headers(fetchImpl.mock.calls[0][1]?.headers).get("authorization")).toBe("Bearer token-a");
  });

  it("stops, with nothing sent, when the browser is already on a different account", async () => {
    const fetchImpl = vi.fn<Fetch>(async () => reply(200));

    const result = await save(browser({ now: "token-b" }, { "token-b": "user-b" }), fetchImpl);

    expect(result.step).toBe("account_changed");
    expect(result.report).toMatchObject({ key: "save-account-changed", level: "info" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("asks for a new link, with nothing sent, when there is no session", async () => {
    const fetchImpl = vi.fn<Fetch>(async () => reply(200));

    const result = await save(browser({ now: null }, {}), fetchImpl);

    expect(result.step).toBe("expired");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("asks for a new link, with nothing sent, when Supabase no longer knows the token", async () => {
    const fetchImpl = vi.fn<Fetch>(async () => reply(200));

    const result = await save(browser({ now: "token-old" }, {}), fetchImpl);

    expect(result.step).toBe("expired");
    expect(result.failure).toMatchObject({ status: 403, code: "bad_jwt" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not guess when the session cannot be read: nothing sent, 'could not check'", async () => {
    const auth = browser({ now: "token-a" }, { "token-a": "user-a" });
    auth.getUser = async () => ({ data: { user: null }, error: { status: 503 } });
    const fetchImpl = vi.fn<Fetch>(async () => reply(200));

    const result = await save(auth, fetchImpl);

    expect(result.step).toBe("check_failed");
    expect(result.report?.key).toBe("save-check-failed");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    [422, { error_code: "weak_password", msg: "weak" }, "form", RECOVERY_COPY.refused, null],
    [422, { error_code: "same_password" }, "form", RECOVERY_COPY.samePassword, null],
    [401, { error_code: "bad_jwt" }, "expired", null, "save-session-gone"],
    [403, { error_code: "session_not_found" }, "expired", null, "save-session-gone"],
    [400, { error_code: "reauthentication_needed" }, "form", RECOVERY_COPY.saveFailed, "save-failed"],
    [500, { msg: "boom" }, "form", RECOVERY_COPY.saveFailed, "save-failed"],
    [429, { error_code: "over_request_rate_limit" }, "form", RECOVERY_COPY.saveFailed, "save-failed"],
  ])("reads Supabase's answer %i %j as %s", async (status, body, step, message, key) => {
    const result = await save(
      browser({ now: "token-a" }, { "token-a": "user-a" }),
      vi.fn<Fetch>(async () => reply(status, body))
    );

    expect(result.step).toBe(step);
    expect(result.message).toBe(message);
    expect(result.report?.key ?? null).toBe(key);
  });

  it("a refusal whose body is not JSON has no code: 'could not save', reported", async () => {
    const result = await save(
      browser({ now: "token-a" }, { "token-a": "user-a" }),
      vi.fn<Fetch>(async () => new Response("<html>bad gateway</html>", { status: 502 }))
    );

    expect(result).toMatchObject({ step: "form", message: RECOVERY_COPY.saveFailed, failure: { status: 502 } });
    expect(result.report?.key).toBe("save-failed");
  });

  it("no answer at all is 'could not save', never 'done' and never 'expired'", async () => {
    const result = await save(
      browser({ now: "token-a" }, { "token-a": "user-a" }),
      vi.fn<Fetch>(async () => {
        throw new TypeError("Failed to fetch");
      })
    );

    expect(result).toMatchObject({
      step: "form",
      message: RECOVERY_COPY.saveFailed,
      failure: { status: 0, name: "TypeError" },
    });
  });

  it("never puts the password, the token or Supabase's message in what it returns", async () => {
    const result = await save(
      browser({ now: "token-a" }, { "token-a": "user-a" }),
      vi.fn<Fetch>(async () => reply(500, { msg: `failed for someone@example.com with ${PASSWORD}` }))
    );

    const text = JSON.stringify(result);
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain("token-a");
    expect(text).not.toContain("@");
  });
});
