import { describe, it, expect } from "vitest";
import {
  MIN_PASSWORD_LENGTH,
  RECOVERY_COOKIE,
  RECOVERY_COOKIE_MAX_AGE_SECONDS,
  RECOVERY_COOKIE_OPTIONS,
  RECOVERY_COPY,
  classifyAuthFailure,
  directVisitOutcome,
  forgotOutcome,
  isRecoveryTokenShape,
  isSessionGone,
  newPasswordProblem,
  saveGuard,
  saveOutcome,
  verifyOutcome,
} from "../recovery";

describe("the token cookie", () => {
  it("is named so the Sentry SDK's own cookie filter drops it", () => {
    expect(RECOVERY_COOKIE).toContain("token");
  });

  it("lives ten minutes and goes only to the route that spends it", () => {
    expect(RECOVERY_COOKIE_MAX_AGE_SECONDS).toBe(600);
    expect(RECOVERY_COOKIE_OPTIONS).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: "strict",
      path: "/auth/recover",
    });
  });
});

describe("isRecoveryTokenShape", () => {
  it.each([
    "a".repeat(16),
    "a".repeat(256),
    "f".repeat(56),
    "pkce_" + "0123456789abcdef".repeat(3) + "01234567",
    "A-b_9".repeat(10),
  ])("accepts %j", (token) => expect(isRecoveryTokenShape(token)).toBe(true));

  it.each([
    null,
    undefined,
    "",
    "short",
    "a".repeat(15),
    "a".repeat(257),
    "a".repeat(20) + " ",
    " " + "a".repeat(20),
    "a".repeat(20) + ";path=/",
    "a".repeat(20) + "\n",
    "a".repeat(20) + "%0d",
    "a".repeat(20) + "/..",
  ])("refuses %j", (token) => expect(isRecoveryTokenShape(token)).toBe(false));
});

describe("classifyAuthFailure", () => {
  it("is ok with no error", () => {
    expect(classifyAuthFailure(null)).toBe("ok");
    expect(classifyAuthFailure(undefined)).toBe("ok");
  });

  it.each([400, 401, 403, 404, 422, 499])("is refused on %i", (status) =>
    expect(classifyAuthFailure({ status })).toBe("refused")
  );

  // A rate limit says nothing about the token or the session.
  it.each([429, 500, 502, 399, 0, undefined])("is unreachable on %j", (status) =>
    expect(classifyAuthFailure({ status })).toBe("unreachable")
  );
});

describe("isSessionGone", () => {
  it("knows supabase-js's own missing-session error: status 400 and no code", () => {
    expect(isSessionGone({ status: 400, name: "AuthSessionMissingError" })).toBe(true);
  });

  it.each(["session_not_found", "session_expired", "refresh_token_not_found", "refresh_token_already_used", "bad_jwt", "user_not_found"])(
    "knows the code %s on a 400",
    (code) => expect(isSessionGone({ status: 400, code })).toBe(true)
  );

  it.each([401, 403])("knows status %i", (status) => expect(isSessionGone({ status })).toBe(true));

  it.each([
    { status: 400 },
    { status: 422, code: "weak_password" },
    { status: 400, code: "validation_failed" },
    { status: 500 },
    { status: 0 },
    {},
  ])("is false for %j", (error) => expect(isSessionGone(error)).toBe(false));
});

describe("forgotOutcome", () => {
  it("shows the neutral message on success, with nothing reported", () => {
    expect(forgotOutcome(null)).toEqual({ view: "sent", report: null });
  });

  it("shows the SAME message when rate-limited, and reports it loudly under its own key", () => {
    const outcome = forgotOutcome({ status: 429, code: "over_email_send_rate_limit" });
    expect(outcome.view).toBe("sent");
    // A used-up project-wide limit tells every customer "sent" while nothing arrives.
    expect(outcome.report).toMatchObject({ key: "forgot-rate-limit", level: "warning" });
  });

  it.each(["validation_failed", "email_address_invalid"])("treats %s as a mistyped address, not a fault", (code) => {
    expect(forgotOutcome({ status: 400, code })).toEqual({ view: "invalid", report: null });
  });

  it.each([
    { status: 400, code: "captcha_failed" },
    { status: 400, code: "email_address_not_authorized" },
    { status: 400 },
    { status: 422 },
    { status: 0 },
    { status: 500 },
    {},
  ])("reports %j as a failure at the default (error) level", (error) => {
    const outcome = forgotOutcome(error);
    expect(outcome.view).toBe("failed");
    expect(outcome.report?.key).toBe("forgot-failed");
    expect(outcome.report?.level).toBeUndefined();
  });
});

describe("verifyOutcome", () => {
  const body = { email: "someone@example.com", userId: "u-1", switched: false };

  it("goes on with the account", () => {
    expect(verifyOutcome(200, body)).toEqual({ step: "form", ...body });
  });

  it("carries the switched-account notice only when the route said true", () => {
    expect(verifyOutcome(200, { ...body, switched: true })).toMatchObject({ switched: true });
    expect(verifyOutcome(200, { ...body, switched: "yes" })).toMatchObject({ switched: false });
    expect(verifyOutcome(200, { email: body.email, userId: body.userId })).toMatchObject({ switched: false });
  });

  it.each([
    null,
    {},
    "text",
    { email: "", userId: "u-1" },
    { email: 5, userId: "u-1" },
    { email: "someone@example.com" },
    { email: "someone@example.com", userId: "" },
    { email: "someone@example.com", userId: 7 },
  ])("does not go on when a 200 is missing the account (%j)", (bad) =>
    expect(verifyOutcome(200, bad)).toEqual({ step: "check_failed" })
  );

  it("calls a 410 expired", () => {
    expect(verifyOutcome(410, { error: "expired" })).toEqual({ step: "expired" });
  });

  it.each([0, 403, 429, 500, 502])("never calls status %i expired, even with an account in the body", (status) => {
    expect(verifyOutcome(status, body)).toEqual({ step: "check_failed" });
  });
});

describe("directVisitOutcome", () => {
  it("shows the form for the signed-in account", () => {
    expect(directVisitOutcome({ id: "u-1", email: "someone@example.com" }, null)).toEqual({
      step: "form",
      email: "someone@example.com",
      userId: "u-1",
    });
  });

  it("asks for a link when nobody is signed in (supabase-js: status 400)", () => {
    expect(directVisitOutcome(null, { status: 400, name: "AuthSessionMissingError" })).toEqual({ step: "needs_link" });
    expect(directVisitOutcome(null, null)).toEqual({ step: "needs_link" });
  });

  it.each([0, 429, 500, undefined])("says it could not check on status %j, never 'needs a link'", (status) => {
    expect(directVisitOutcome(null, { status })).toEqual({ step: "check_failed" });
  });

  it("does not show the form for an account with no email", () => {
    expect(directVisitOutcome({ id: "u-1" }, null)).toEqual({ step: "needs_link" });
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

describe("saveGuard", () => {
  it("lets the save through when the browser is still on the form's account", () => {
    expect(saveGuard("u-1", { id: "u-1" }, null)).toEqual({ ok: true });
  });

  it("stops when another tab signed in to a different account", () => {
    expect(saveGuard("u-1", { id: "u-2" }, null)).toMatchObject({ ok: false, step: "account_changed" });
  });

  it("asks for a new link when the session is gone", () => {
    expect(saveGuard("u-1", null, { status: 400, name: "AuthSessionMissingError" })).toMatchObject({
      ok: false,
      step: "expired",
      report: { level: "info" },
    });
  });

  it.each([0, 429, 500, undefined])("does not guess when the session cannot be read (status %j)", (status) => {
    const guard = saveGuard("u-1", null, { status });
    expect(guard).toMatchObject({ ok: false, step: "check_failed" });
    // The default level: a fault, not a notice.
    expect(guard.ok === false && guard.report?.level).toBeUndefined();
  });
});

describe("saveOutcome", () => {
  it("is done when there is no error", () => {
    expect(saveOutcome(null)).toEqual({ step: "done", report: null });
  });

  it("asks for a new link when supabase-js says there is no session (400, no code)", () => {
    // The page must not answer this with "choose a different password".
    expect(saveOutcome({ status: 400, name: "AuthSessionMissingError" })).toMatchObject({
      step: "expired",
      report: { key: "save-session-gone", level: "info" },
    });
  });

  it.each(["refresh_token_not_found", "refresh_token_already_used", "session_not_found"])(
    "asks for a new link on a 400 with code %s",
    (code) => expect(saveOutcome({ status: 400, code })).toMatchObject({ step: "expired" })
  );

  it.each([401, 403])("asks for a new link on status %i", (status) => {
    expect(saveOutcome({ status })).toMatchObject({ step: "expired" });
  });

  it("names a reused password, unreported", () => {
    expect(saveOutcome({ status: 422, code: "same_password" })).toEqual({
      step: "form",
      message: RECOVERY_COPY.samePassword,
      report: null,
    });
  });

  it("keeps the form on Supabase's own password rule, unreported", () => {
    expect(saveOutcome({ status: 422, code: "weak_password" })).toEqual({
      step: "form",
      message: RECOVERY_COPY.refused,
      report: null,
    });
  });

  it.each([
    { status: 400 },
    { status: 422 },
    { status: 400, code: "reauthentication_needed" },
    { status: 429 },
    { status: 0 },
    { status: 500 },
    {},
  ])("reports %j as a failure and never calls it a bad password", (error) => {
    const outcome = saveOutcome(error);
    expect(outcome).toMatchObject({ step: "form", message: RECOVERY_COPY.saveFailed });
    expect(outcome.report?.key).toBe("save-failed");
    expect(outcome.report?.level).toBeUndefined();
  });
});

describe("reports", () => {
  it("no report text carries anything but fixed words", () => {
    const reports = [
      forgotOutcome({ status: 429 }).report,
      forgotOutcome({ status: 500 }).report,
      saveOutcome({ status: 500 }).report,
      saveOutcome({ status: 401 }).report,
    ];
    for (const report of reports) {
      expect(report?.message).toMatch(/^password reset: [a-z ]+$/);
      expect(report?.key).toMatch(/^[a-z-]+$/);
    }
  });

  it("a notice and a failure never share a key (one Sentry issue per key)", () => {
    expect(forgotOutcome({ status: 429 }).report?.key).not.toBe(forgotOutcome({ status: 500 }).report?.key);
    expect(saveOutcome({ status: 401 }).report?.key).not.toBe(saveOutcome({ status: 500 }).report?.key);
  });
});
