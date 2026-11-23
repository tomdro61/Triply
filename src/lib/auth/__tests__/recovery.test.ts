import { describe, it, expect } from "vitest";
import {
  MIN_PASSWORD_LENGTH,
  RECOVERY_COPY,
  forgotOutcome,
  isRecoveryTokenShape,
  newPasswordProblem,
  saveOutcome,
  tokenCheckResult,
  verifyOutcome,
} from "../recovery";

describe("isRecoveryTokenShape", () => {
  it.each(["a".repeat(16), "f".repeat(56), "pkce_" + "0123456789abcdef".repeat(3), "A-b_9".repeat(10)])(
    "accepts %j",
    (token) => expect(isRecoveryTokenShape(token)).toBe(true)
  );

  it.each([
    null,
    undefined,
    "",
    "short",
    "a".repeat(15),
    "a".repeat(257),
    "a".repeat(20) + " ",
    "a".repeat(20) + ";path=/",
    "a".repeat(20) + "\n",
    "a".repeat(20) + "%0d",
    "a".repeat(20) + "/..",
  ])("refuses %j", (token) => expect(isRecoveryTokenShape(token)).toBe(false));
});

describe("forgotOutcome", () => {
  it("shows the neutral message on success, with nothing reported", () => {
    expect(forgotOutcome(null)).toEqual({ view: "sent", report: "none" });
  });

  it("shows the SAME message when rate-limited, and counts it", () => {
    // Only an address with an account is ever rate-limited.
    expect(forgotOutcome({ status: 429, code: "over_email_send_rate_limit" })).toEqual({
      view: "sent",
      report: "info",
    });
  });

  it.each([400, 422])("treats %i as a mistyped address, not a fault", (status) => {
    expect(forgotOutcome({ status })).toEqual({ view: "invalid", report: "none" });
  });

  it.each([0, 500, 503, undefined])("reports status %j as a failure", (status) => {
    expect(forgotOutcome({ status })).toEqual({ view: "failed", report: "error" });
  });
});

describe("verifyOutcome", () => {
  it("goes on with the account's email", () => {
    expect(verifyOutcome(200, { email: "someone@example.com" })).toEqual({
      step: "form",
      email: "someone@example.com",
    });
  });

  it.each([null, {}, { email: "" }, { email: 5 }, "text"])(
    "does not go on when a 200 carries no email (%j)",
    (body) => expect(verifyOutcome(200, body)).toEqual({ step: "check_failed" })
  );

  it("calls a 410 expired", () => {
    expect(verifyOutcome(410, { error: "expired" })).toEqual({ step: "expired" });
  });

  it.each([0, 403, 429, 500, 502])("never calls status %i expired", (status) => {
    expect(verifyOutcome(status, { email: "someone@example.com" })).toEqual({ step: "check_failed" });
  });
});

describe("newPasswordProblem", () => {
  const ok = "x".repeat(MIN_PASSWORD_LENGTH);

  it("accepts a long enough password typed twice", () => {
    expect(newPasswordProblem(ok, ok)).toBeNull();
  });

  it("refuses one character short", () => {
    const short = "x".repeat(MIN_PASSWORD_LENGTH - 1);
    expect(newPasswordProblem(short, short)).toBe(RECOVERY_COPY.tooShort);
  });

  it("refuses two different entries", () => {
    expect(newPasswordProblem(ok, ok + "y")).toBe(RECOVERY_COPY.mismatch);
  });
});

describe("saveOutcome", () => {
  it("is done when there is no error", () => {
    expect(saveOutcome(null)).toEqual({ step: "done" });
  });

  it.each([401, 403])("asks for a new link when the session is gone (%i)", (status) => {
    expect(saveOutcome({ status })).toEqual({ step: "expired", report: "info" });
  });

  it("names a reused password", () => {
    expect(saveOutcome({ status: 422, code: "same_password" })).toEqual({
      step: "form",
      message: RECOVERY_COPY.samePassword,
      report: "none",
    });
  });

  it.each([400, 422])("keeps the form on a refused password (%i), unreported", (status) => {
    expect(saveOutcome({ status, code: "weak_password" })).toEqual({
      step: "form",
      message: RECOVERY_COPY.refused,
      report: "none",
    });
  });

  it.each([0, 500, undefined])("reports status %j as a failure and keeps the form", (status) => {
    expect(saveOutcome({ status })).toEqual({
      step: "form",
      message: RECOVERY_COPY.saveFailed,
      report: "error",
    });
  });
});

describe("tokenCheckResult", () => {
  it("is ok with no error", () => expect(tokenCheckResult(null)).toBe("ok"));

  it.each([400, 401, 403, 404, 422])("is refused on %i", (status) =>
    expect(tokenCheckResult({ status })).toBe("refused")
  );

  // A rate limit says nothing about the token, so it must not spend it.
  it.each([429, 500, 502, 0, undefined])("is unreachable on %j", (status) =>
    expect(tokenCheckResult({ status })).toBe("unreachable")
  );
});
