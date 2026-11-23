/**
 * Password reset: the rules shared by the two pages and the two routes.
 *
 * The emailed link carries a one-time token. `/auth/confirm` moves it out of
 * the address into a short-lived cookie, and it is spent only when the person
 * presses Continue (`/auth/recover/verify`), so a mail scanner that opens the
 * link does not use it up and no page is ever shown with the token in its URL.
 *
 * Pure: no browser or server API, so every branch here is unit-tested.
 */

export const RECOVERY_COOKIE = "triply_recovery";
/** Both routes live under /auth, so the cookie goes nowhere else. */
export const RECOVERY_COOKIE_PATH = "/auth";
export const RECOVERY_COOKIE_MAX_AGE_SECONDS = 10 * 60;

/** The stricter of the two minimums in use on the site (partners need 8). */
export const MIN_PASSWORD_LENGTH = 8;

/** How long the "send" button stays off after a request: Supabase refuses a
 *  second email to the same account for 60 seconds. */
export const RESEND_COOLDOWN_MS = 60_000;

/** A token is letters, digits, "-" and "_". Anything else is not ours. */
export function isRecoveryTokenShape(value: string | null | undefined): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{16,256}$/.test(value);
}

export const RECOVERY_COPY = {
  sent: "If an account exists for that email, we've sent a link to reset your password. Use the newest email: earlier links stop working.",
  invalidEmail: "Please check the email address and try again.",
  sendFailed: "We couldn't send the email. Please try again.",
  expired: "That link has expired or was already used. Enter your email to get a new one.",
  checkFailed: "We couldn't check your link. Please try again.",
  saveFailed: "We couldn't save your new password. Please try again.",
  tooShort: `Your password needs at least ${MIN_PASSWORD_LENGTH} characters.`,
  mismatch: "The two passwords don't match.",
  refused: "That password can't be used. Choose a different one that is longer or harder to guess.",
  samePassword: "That is your current password. Choose a different one.",
} as const;

type AuthFailure = { status?: number; code?: string } | null | undefined;

/** What the forgot-password page shows, and what goes to Sentry. */
export type ForgotOutcome = {
  view: "sent" | "invalid" | "failed";
  report: "none" | "info" | "error";
};

/**
 * A rate-limit answer (429) shows the SAME message as success: Supabase only
 * rate-limits an address that has an account, so a different message would
 * tell a stranger which emails are registered.
 */
export function forgotOutcome(error: AuthFailure): ForgotOutcome {
  if (!error) return { view: "sent", report: "none" };
  if (error.status === 429) return { view: "sent", report: "info" };
  // A mistyped address. The person's to fix, not a fault.
  if (error.status === 400 || error.status === 422) return { view: "invalid", report: "none" };
  return { view: "failed", report: "error" };
}

/** What the verify route answered, read by the reset page. */
export type VerifyOutcome =
  | { step: "form"; email: string }
  | { step: "expired" }
  | { step: "check_failed" };

/**
 * 200 with an email = go on. 410 = the link is spent or too old. Anything
 * else (a network failure reaches here as status 0) is "could not check":
 * never called expired, because the link may still be good.
 */
export function verifyOutcome(status: number, body: unknown): VerifyOutcome {
  if (status === 200) {
    const email = typeof body === "object" && body !== null && "email" in body ? body.email : null;
    if (typeof email === "string" && email.length > 0) return { step: "form", email };
    return { step: "check_failed" };
  }
  if (status === 410) return { step: "expired" };
  return { step: "check_failed" };
}

/** Checked before the request, so the common mistakes cost no round trip. */
export function newPasswordProblem(password: string, confirm: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return RECOVERY_COPY.tooShort;
  if (password !== confirm) return RECOVERY_COPY.mismatch;
  return null;
}

/** What the reset page does after `updateUser`. */
export type SaveOutcome =
  | { step: "done" }
  | { step: "expired"; report: "info" }
  | { step: "form"; message: string; report: "none" | "error" };

export function saveOutcome(error: AuthFailure): SaveOutcome {
  if (!error) return { step: "done" };
  // The session behind the link is gone: ask for a new link.
  if (error.status === 401 || error.status === 403) return { step: "expired", report: "info" };
  if (error.code === "same_password") {
    return { step: "form", message: RECOVERY_COPY.samePassword, report: "none" };
  }
  // Supabase's own password rule (length, leaked-password check).
  if (error.status === 422 || error.status === 400) {
    return { step: "form", message: RECOVERY_COPY.refused, report: "none" };
  }
  return { step: "form", message: RECOVERY_COPY.saveFailed, report: "error" };
}

/**
 * What the verify route does with Supabase's answer to the token.
 * A refusal (4xx) spends the cookie; a failure to reach Supabase keeps it so
 * the person can press Continue again.
 */
export function tokenCheckResult(error: AuthFailure): "ok" | "refused" | "unreachable" {
  if (!error) return "ok";
  const status = error.status;
  if (typeof status === "number" && status >= 400 && status < 500 && status !== 429) return "refused";
  return "unreachable";
}
