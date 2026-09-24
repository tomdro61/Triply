import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
  createAdminClient: vi.fn(),
}));
const sentry = vi.hoisted(() => ({ captureBookingError: vi.fn() }));
vi.mock("@/lib/sentry", () => ({ captureBookingError: sentry.captureBookingError }));

import {
  linkableUserIdForEmail,
  sessionIdentityFromRequest,
  __setAuthUserLookupForTests,
  LOOKUP_TIMEOUT_MS,
} from "../customer-link";
import { createClient, createAdminClient } from "@/lib/supabase/server";

beforeEach(() => sentry.captureBookingError.mockClear());
afterEach(() => __setAuthUserLookupForTests(null));

describe("linkableUserIdForEmail — the rule that closes the account-takeover hole", () => {
  it("links when the account's verified email IS the booking email (case/space-insensitive)", async () => {
    __setAuthUserLookupForTests(async () => ({ verifiedEmail: "ada@example.com" }));
    expect(await linkableUserIdForEmail("u1", "  Ada@Example.com ")).toBe("u1");
  });

  it("refuses when the account's verified email is a DIFFERENT address (the attack)", async () => {
    __setAuthUserLookupForTests(async () => ({ verifiedEmail: "attacker@example.com" }));
    expect(await linkableUserIdForEmail("u1", "victim@example.com")).toBeNull();
  });

  it("refuses when the account's email is not confirmed", async () => {
    __setAuthUserLookupForTests(async () => ({ verifiedEmail: null }));
    expect(await linkableUserIdForEmail("u1", "ada@example.com")).toBeNull();
  });

  it("refuses for guests and unknown users", async () => {
    __setAuthUserLookupForTests(async () => null);
    expect(await linkableUserIdForEmail(null, "ada@example.com")).toBeNull();
    expect(await linkableUserIdForEmail(undefined, "ada@example.com")).toBeNull();
    expect(await linkableUserIdForEmail("ghost", "ada@example.com")).toBeNull();
  });

  it("never throws — a failed lookup is reported and treated as no link", async () => {
    __setAuthUserLookupForTests(async () => {
      throw new Error("auth admin down");
    });
    expect(await linkableUserIdForEmail("u1", "ada@example.com")).toBeNull();
    expect(sentry.captureBookingError).toHaveBeenCalledTimes(1);
  });
});

describe("sessionIdentityFromRequest", () => {
  it("returns the session user with the email only when confirmed", async () => {
    vi.mocked(createClient).mockResolvedValue({
      auth: {
        getUser: async () => ({
          data: { user: { id: "u1", email: "Ada@Example.com", email_confirmed_at: "2026-01-01" } },
          error: null,
        }),
      },
    } as never);
    expect(await sessionIdentityFromRequest()).toEqual({
      identity: { userId: "u1", verifiedEmail: "ada@example.com" },
      reason: "ok",
    });

    vi.mocked(createClient).mockResolvedValue({
      auth: {
        getUser: async () => ({
          data: { user: { id: "u2", email: "x@example.com", email_confirmed_at: null } },
          error: null,
        }),
      },
    } as never);
    expect(await sessionIdentityFromRequest()).toEqual({
      identity: { userId: "u2", verifiedEmail: null },
      reason: "ok",
    });
  });

  it("a missing session is a plain guest, not a fault (nothing reported)", async () => {
    vi.mocked(createClient).mockResolvedValue({
      auth: { getUser: async () => ({ data: { user: null }, error: null }) },
    } as never);
    expect(await sessionIdentityFromRequest()).toEqual({ identity: null, reason: "guest" });

    vi.mocked(createClient).mockResolvedValue({
      auth: {
        getUser: async () => ({
          data: { user: null },
          error: { name: "AuthSessionMissingError", message: "Auth session missing!", status: 400 },
        }),
      },
    } as never);
    expect(await sessionIdentityFromRequest()).toEqual({ identity: null, reason: "guest" });
    expect(sentry.captureBookingError).not.toHaveBeenCalled();
  });

  it("an auth fault is REPORTED and returned as auth_error — getUser resolves { error }, it does not throw", async () => {
    vi.mocked(createClient).mockResolvedValue({
      auth: {
        getUser: async () => ({
          data: { user: null },
          error: { name: "AuthRetryableFetchError", message: "fetch failed", status: 502 },
        }),
      },
    } as never);
    expect(await sessionIdentityFromRequest()).toEqual({ identity: null, reason: "auth_error" });
    expect(sentry.captureBookingError).toHaveBeenCalledTimes(1);
    expect(String(sentry.captureBookingError.mock.calls[0][0])).toMatch(/auth.getUser failed \(502\)/);

    sentry.captureBookingError.mockClear();
    vi.mocked(createClient).mockRejectedValue(new Error("no cookies here"));
    expect(await sessionIdentityFromRequest()).toEqual({ identity: null, reason: "auth_error" });
    expect(sentry.captureBookingError).toHaveBeenCalledTimes(1);
  });
});

describe("isSessionMissing — what counts as a plain guest", () => {
  it("a 401 that is NOT a session error (rotated/invalid anon key) is a reported fault, not a guest", async () => {
    vi.mocked(createClient).mockResolvedValue({
      auth: {
        getUser: async () => ({
          data: { user: null },
          error: { name: "AuthApiError", message: "Invalid API key", status: 401, code: undefined },
        }),
      },
    } as never);
    expect(await sessionIdentityFromRequest()).toEqual({ identity: null, reason: "auth_error" });
    expect(sentry.captureBookingError).toHaveBeenCalledTimes(1);
  });

  it("a stale/absent token, by its stable code, is a guest with nothing reported", async () => {
    for (const code of ["bad_jwt", "refresh_token_not_found", "session_not_found"]) {
      vi.mocked(createClient).mockResolvedValue({
        auth: {
          getUser: async () => ({
            data: { user: null },
            error: { name: "AuthApiError", message: "whatever GoTrue says this year", status: 401, code },
          }),
        },
      } as never);
      expect(await sessionIdentityFromRequest()).toEqual({ identity: null, reason: "guest" });
    }
    expect(sentry.captureBookingError).not.toHaveBeenCalled();
  });
});

describe("linkableUserIdForEmail is bounded — it runs after capture and before the bookings INSERT", () => {
  it("a hung auth lookup times out, is reported, and means 'don't link'", async () => {
    vi.useFakeTimers();
    try {
      __setAuthUserLookupForTests(() => new Promise(() => {}));
      const pending = linkableUserIdForEmail("u1", "ada@example.com");
      await vi.advanceTimersByTimeAsync(LOOKUP_TIMEOUT_MS + 1);
      expect(await pending).toBeNull();
      expect(sentry.captureBookingError).toHaveBeenCalledTimes(1);
      expect(String(sentry.captureBookingError.mock.calls[0][0])).toMatch(/timed out after/);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the real admin lookup (no test seam) — getUserById resolves { error }, it does not throw", () => {
  it("a 404 (unknown user) is a quiet no-link; a 5xx is reported and still a no-link", async () => {
    vi.mocked(createAdminClient).mockResolvedValue({
      auth: { admin: { getUserById: async () => ({ data: { user: null }, error: { message: "User not found", status: 404 } }) } },
    } as never);
    expect(await linkableUserIdForEmail("u1", "ada@example.com")).toBeNull();
    expect(sentry.captureBookingError).not.toHaveBeenCalled();

    vi.mocked(createAdminClient).mockResolvedValue({
      auth: { admin: { getUserById: async () => ({ data: { user: null }, error: { message: "upstream", status: 503 } }) } },
    } as never);
    expect(await linkableUserIdForEmail("u1", "ada@example.com")).toBeNull();
    expect(sentry.captureBookingError).toHaveBeenCalledTimes(1);
    expect(String(sentry.captureBookingError.mock.calls[0][0])).toMatch(/getUserById failed \(503\)/);
  });

  it("links through the real lookup when the verified email matches", async () => {
    vi.mocked(createAdminClient).mockResolvedValue({
      auth: {
        admin: {
          getUserById: async () => ({
            data: { user: { id: "u1", email: "Ada@Example.com", email_confirmed_at: "2026-01-01" } },
            error: null,
          }),
        },
      },
    } as never);
    expect(await linkableUserIdForEmail("u1", "ada@example.com")).toBe("u1");
  });
});
