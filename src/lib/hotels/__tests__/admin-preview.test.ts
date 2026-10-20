import { beforeEach, describe, expect, it, vi } from "vitest";

const getUser = vi.fn();
const captureAPIError = vi.fn();
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ auth: { getUser: () => getUser() } }) }));
vi.mock("@/lib/sentry", () => ({ captureAPIError: (...a: unknown[]) => captureAPIError(...a) }));
vi.mock("@/config/admin", () => ({ isAdminEmail: (e: string | null | undefined) => e?.toLowerCase() === "tom@triplypro.com" }));

import { parkStayViewerAllowed, __resetParkStayViewerForTests, PARK_STAY_VIEWER_TIMEOUT_MS, PARK_STAY_VIEWER_REPORT_INTERVAL_MS } from "@/lib/hotels/admin-preview";

const user = (over: Record<string, unknown> = {}) => ({
  data: { user: { id: "u1", email: "Tom@TriplyPro.com", email_confirmed_at: "2026-01-01T00:00:00Z", ...over } },
  error: null,
});

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  getUser.mockReset();
  captureAPIError.mockReset();
  __resetParkStayViewerForTests();
});

describe("parkStayViewerAllowed (plan §20.1) — fails closed", () => {
  it("a confirmed allowlisted admin → true", async () => {
    getUser.mockResolvedValue(user());
    expect(await parkStayViewerAllowed("/x")).toBe(true);
  });

  it("signed out → false, nothing reported", async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: { name: "AuthSessionMissingError", message: "Auth session missing!" } });
    expect(await parkStayViewerAllowed("/x")).toBe(false);
    getUser.mockResolvedValue({ data: { user: null }, error: null });
    expect(await parkStayViewerAllowed("/x")).toBe(false);
    expect(captureAPIError).not.toHaveBeenCalled();
  });

  it("an admin email that is NOT confirmed → false", async () => {
    getUser.mockResolvedValue(user({ email_confirmed_at: null }));
    expect(await parkStayViewerAllowed("/x")).toBe(false);
  });

  it("a confirmed non-admin → false", async () => {
    getUser.mockResolvedValue(user({ email: "someone@example.com" }));
    expect(await parkStayViewerAllowed("/x")).toBe(false);
  });

  it("reports again after the throttle window, so a later outage is still heard", async () => {
    vi.useFakeTimers();
    try {
      getUser.mockResolvedValue({ data: { user: null }, error: { status: 500, message: "gotrue down" } });
      await parkStayViewerAllowed("/x");
      await parkStayViewerAllowed("/x");
      expect(captureAPIError).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(PARK_STAY_VIEWER_REPORT_INTERVAL_MS + 1);
      await parkStayViewerAllowed("/x");
      expect(captureAPIError).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an auth error (resolved, not thrown) → false and reported once within the window", async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: { status: 500, message: "gotrue down", code: "unexpected_failure" } });
    expect(await parkStayViewerAllowed("/api/park-stay/search")).toBe(false);
    expect(await parkStayViewerAllowed("/api/park-stay/search")).toBe(false);
    expect(captureAPIError).toHaveBeenCalledTimes(1);
    expect(captureAPIError.mock.calls[0][1]).toMatchObject({ endpoint: "/api/park-stay/search", stage: "viewer_auth" });
  });

  it("throttles per failure kind: a one-off timeout does not silence a different error", async () => {
    getUser.mockRejectedValueOnce(new Error("boom"));
    await parkStayViewerAllowed("/x");
    getUser.mockResolvedValue({ data: { user: null }, error: { status: 401, message: "invalid api key", code: "bad_api_key", name: "AuthApiError" } });
    await parkStayViewerAllowed("/x");
    expect(captureAPIError).toHaveBeenCalledTimes(2);
  });

  it("every error denial is logged even when Sentry is throttled", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    warn.mockClear();
    try {
      getUser.mockResolvedValue({ data: { user: null }, error: { status: 500, message: "gotrue down" } });
      await parkStayViewerAllowed("/x");
      await parkStayViewerAllowed("/x");
      expect(captureAPIError).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  it("a thrown error → false and reported", async () => {
    getUser.mockRejectedValue(new Error("boom"));
    expect(await parkStayViewerAllowed("/x")).toBe(false);
    expect(captureAPIError).toHaveBeenCalledTimes(1);
  });

  it("a hung auth call → false after the bound", async () => {
    vi.useFakeTimers();
    try {
      getUser.mockReturnValue(new Promise(() => {}));
      const p = parkStayViewerAllowed("/x");
      await vi.advanceTimersByTimeAsync(PARK_STAY_VIEWER_TIMEOUT_MS + 1);
      expect(await p).toBe(false);
      expect(captureAPIError).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
