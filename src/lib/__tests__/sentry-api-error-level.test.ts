import { describe, it, expect, beforeEach, vi } from "vitest";

const { scope, captureException } = vi.hoisted(() => ({
  scope: {
    setLevel: vi.fn(),
    setTag: vi.fn(),
    setFingerprint: vi.fn(),
    setContext: vi.fn(),
    setExtra: vi.fn(),
    setUser: vi.fn(),
  },
  captureException: vi.fn(),
}));

vi.mock("@sentry/nextjs", () => ({
  captureException,
  withScope: (fn: (s: typeof scope) => void) => fn(scope),
}));

import { captureAPIError } from "../sentry";

beforeEach(() => vi.clearAllMocks());

describe("captureAPIError level (opt-in)", () => {
  it("sets the level it is given", () => {
    captureAPIError(new Error("budget"), { endpoint: "/x", method: "GET", level: "warning" });
    expect(scope.setLevel).toHaveBeenCalledWith("warning");
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it("without one, leaves the level alone, as every existing caller expects", () => {
    captureAPIError(new Error("boom"), { endpoint: "/x", method: "GET", stage: "s" });
    expect(scope.setLevel).not.toHaveBeenCalled();
    expect(captureException).toHaveBeenCalledTimes(1);
  });
});
