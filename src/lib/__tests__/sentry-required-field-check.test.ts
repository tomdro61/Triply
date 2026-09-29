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

import { captureRequiredFieldCheck } from "../sentry";

const context = { stripePaymentIntentId: "pi_1", locationId: 343 };

beforeEach(() => vi.clearAllMocks());

describe("captureRequiredFieldCheck", () => {
  it("is a warning with its own tags, never a payment error", () => {
    captureRequiredFieldCheck("skipped", "lookup timed out", context);
    expect(scope.setLevel).toHaveBeenCalledWith("warning");
    expect(scope.setTag).toHaveBeenCalledWith("check", "required_extra_fields");
    expect(scope.setTag).toHaveBeenCalledWith("check.outcome", "skipped");
    expect(scope.setTag).toHaveBeenCalledWith("payment.intentId", "pi_1");
    expect(scope.setTag).toHaveBeenCalledWith("booking.lotId", "343");
    expect(scope.setTag).not.toHaveBeenCalledWith("payment.error", expect.anything());
    expect(captureException).toHaveBeenCalledWith(expect.objectContaining({ message: "lookup timed out" }));
  });

  it("groups skips together, since they follow ResLab's health and not a lot", () => {
    captureRequiredFieldCheck("skipped", "m", context);
    expect(scope.setFingerprint).toHaveBeenCalledWith(["required-extra-fields", "skipped"]);
  });

  it.each(["refused", "lot_not_found"] as const)("groups %s per lot, so one lot failing opens its own issue", (outcome) => {
    captureRequiredFieldCheck(outcome, "m", context);
    expect(scope.setFingerprint).toHaveBeenCalledWith(["required-extra-fields", outcome, "343"]);
  });

  it("attaches detail only when given", () => {
    captureRequiredFieldCheck("refused", "m", { ...context, detail: { missingFields: ["return_flight_number"] } });
    expect(scope.setContext).toHaveBeenCalledWith("detail", { missingFields: ["return_flight_number"] });
    vi.clearAllMocks();
    captureRequiredFieldCheck("refused", "m", context);
    expect(scope.setContext).not.toHaveBeenCalled();
  });
});
