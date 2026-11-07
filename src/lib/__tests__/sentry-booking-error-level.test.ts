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

import { captureBookingError } from "../sentry";

beforeEach(() => vi.clearAllMocks());

describe("captureBookingError level (opt-in — a promo price drop is reported below error)", () => {
  it("sets the level it is given", () => {
    captureBookingError(new Error("price drop"), { step: "checkout", level: "warning" });
    expect(scope.setLevel).toHaveBeenCalledWith("warning");
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it("without one, leaves the level alone, as every existing caller expects", () => {
    captureBookingError(new Error("boom"), { step: "checkout" });
    expect(scope.setLevel).not.toHaveBeenCalled();
    expect(captureException).toHaveBeenCalledTimes(1);
  });
});
