import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const sentryMock = vi.hoisted(() => ({ captureMessage: vi.fn(), scope: { setLevel: vi.fn(), setTag: vi.fn(), setFingerprint: vi.fn(), setContext: vi.fn() } }));
vi.mock("@sentry/nextjs", () => ({
  withScope: (fn: (scope: typeof sentryMock.scope) => void) => fn(sentryMock.scope),
  captureMessage: sentryMock.captureMessage,
  captureException: vi.fn(),
}));

import { captureContactHoneypotDrop, __resetHoneypotCaptureForTests } from "../sentry";

const ctx = { subject: "Other", emailDomain: "spam.example", ipKey: "203.0.113.7" };

beforeEach(() => {
  __resetHoneypotCaptureForTests();
  sentryMock.captureMessage.mockReset();
  sentryMock.scope.setContext.mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-07T12:00:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("captureContactHoneypotDrop", () => {
  it("emits one event per 10 minutes per instance and carries the suppressed count", () => {
    for (let i = 0; i < 50; i++) captureContactHoneypotDrop(ctx);
    expect(sentryMock.captureMessage).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10 * 60_000 + 1);
    captureContactHoneypotDrop(ctx);
    expect(sentryMock.captureMessage).toHaveBeenCalledTimes(2);
    expect(sentryMock.scope.setContext).toHaveBeenLastCalledWith(
      "contact",
      expect.objectContaining({ suppressedSinceLastCapture: 49 })
    );
    expect(sentryMock.captureMessage.mock.calls[1][0]).toContain("+49 suppressed");
  });

  it("bounds the caller-supplied domain in the event", () => {
    captureContactHoneypotDrop({ ...ctx, emailDomain: "x".repeat(500) });
    const title: string = sentryMock.captureMessage.mock.calls[0][0];
    expect(title.length).toBeLessThan(220);
  });
});
