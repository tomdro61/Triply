/**
 * Password reset: the rules shared by the two pages and the two routes.
 *
 * The emailed link carries a one-time token. `/auth/confirm` moves it out of
 * the address into a short-lived cookie, and it is spent only when the person
 * presses Continue (`/auth/recover/verify`), so a mail scanner that opens the
 * link does not use it up and no PAGE is shown with the token in its address.
 * The link's own request still carries it: lib/sentry-scrub.ts removes it (and
 * the cookie) from what Sentry is sent.
 *
 * Pure: no browser or server API.
 */

/**
 * "token" in the name is on purpose: the Sentry SDK filters cookies whose name
 * contains it. lib/sentry-scrub.ts removes the value as well, by this name.
 */
export const RECOVERY_COOKIE = "triply_recovery_token";
export const RECOVERY_COOKIE_MAX_AGE_SECONDS = 10 * 60;
/** Sent only to the route that spends it. */
export const RECOVERY_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: "strict",
  path: "/auth/recover",
} as const;

/** The stricter of the two minimums in use on the site (partners need 8). */
export const MIN_PASSWORD_LENGTH = 8;

/** Supabase refuses a second email to the same account inside 60 seconds; one
 *  sent after that replaces the first email's link. */
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
  needsLink: "To choose a new password, ask for a reset link first.",
  checkFailed: "We couldn't check your link. Please try again.",
  saveFailed: "We couldn't save your new password. Please try again.",
  accountChanged: "You're now signed in to a different account in this browser. Ask for a new link to continue.",
  tooShort: `Your password needs at least ${MIN_PASSWORD_LENGTH} characters.`,
  mismatch: "The two passwords don't match.",
  refused: "That password can't be used. Choose a different one that is longer or harder to guess.",
  samePassword: "That is your current password. Choose a different one.",
} as const;

/** What we keep of a Supabase auth error. Never its message: that can quote the email. */
export type AuthFailure = { status?: number; code?: string; name?: string };

/** A Sentry report, decided here so the tests cover it. `key` groups it into its own issue. */
export type RecoveryReport = { message: string; key: string; level?: "info" | "warning" };

/** ok = no error. refused = Supabase said no. unreachable = we could not get an answer. */
export type AuthAnswer = "ok" | "refused" | "unreachable";

/** A 429 is "unreachable": a rate limit says nothing about the token or the session. */
export function classifyAuthFailure(error: AuthFailure | null | undefined): AuthAnswer {
  if (!error) return "ok";
  const status = error.status;
  if (typeof status === "number" && status >= 400 && status < 500 && status !== 429) return "refused";
  return "unreachable";
}

/**
 * True when the error means "there is no usable session". supabase-js reports a
 * missing session as status 400 with no code (AuthSessionMissingError), so the
 * status alone cannot tell it from a refused password.
 */
const SESSION_GONE_CODES: ReadonlySet<string> = new Set([
  "session_not_found",
  "session_expired",
  "refresh_token_not_found",
  "refresh_token_already_used",
  "bad_jwt",
  "user_not_found",
]);
export function isSessionGone(error: AuthFailure): boolean {
  if (error.name === "AuthSessionMissingError") return true;
  if (error.code !== undefined && SESSION_GONE_CODES.has(error.code)) return true;
  return error.status === 401 || error.status === 403;
}

/** What the forgot-password page shows, and what goes to Sentry. */
export type ForgotOutcome = { view: "sent" | "invalid" | "failed"; report: RecoveryReport | null };

const INVALID_EMAIL_CODES: ReadonlySet<string> = new Set(["validation_failed", "email_address_invalid"]);

/**
 * A rate-limit answer (429) shows the SAME message as success, so the page
 * never tells a stranger which emails are registered. It is reported at
 * warning level under its own key: when the project-wide email limit is
 * reached, every customer is told "sent" and nothing arrives.
 */
export function forgotOutcome(error: AuthFailure | null): ForgotOutcome {
  if (!error) return { view: "sent", report: null };
  if (error.status === 429) {
    return {
      view: "sent",
      report: { message: "password reset: email rate limit reached", key: "forgot-rate-limit", level: "warning" },
    };
  }
  // A mistyped address: the person's to fix, not a fault.
  if (error.code !== undefined && INVALID_EMAIL_CODES.has(error.code)) return { view: "invalid", report: null };
  return {
    view: "failed",
    report: { message: "password reset: the email could not be requested", key: "forgot-failed" },
  };
}

/** What the verify route answered, read by the reset page. */
export type VerifyOutcome =
  | { step: "form"; email: string; userId: string; switched: boolean }
  | { step: "expired" }
  | { step: "check_failed" };

function field(body: unknown, key: string): unknown {
  return typeof body === "object" && body !== null ? Reflect.get(body, key) : undefined;
}

/**
 * 200 with an account = go on. 410 = the link is spent or too old. Anything
 * else (a network failure reaches here as status 0) is "could not check":
 * never called expired, because the link may still be good.
 */
export function verifyOutcome(status: number, body: unknown): VerifyOutcome {
  if (status === 200) {
    const email = field(body, "email");
    const userId = field(body, "userId");
    if (typeof email === "string" && email.length > 0 && typeof userId === "string" && userId.length > 0) {
      return { step: "form", email, userId, switched: field(body, "switched") === true };
    }
    return { step: "check_failed" };
  }
  if (status === 410) return { step: "expired" };
  return { step: "check_failed" };
}

/** The reset page opened WITHOUT a link: who is signed in, if anyone. */
export type DirectVisitOutcome =
  | { step: "form"; email: string; userId: string }
  | { step: "needs_link" }
  | { step: "check_failed" };

export function directVisitOutcome(
  user: { id?: string; email?: string } | null | undefined,
  error: AuthFailure | null | undefined
): DirectVisitOutcome {
  if (user?.id && user.email) return { step: "form", email: user.email, userId: user.id };
  if (classifyAuthFailure(error) === "unreachable") return { step: "check_failed" };
  return { step: "needs_link" };
}

/** Checked before the request, so the common mistakes cost no round trip. */
export function newPasswordProblem(password: string, confirm: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return RECOVERY_COPY.tooShort;
  if (password !== confirm) return RECOVERY_COPY.mismatch;
  return null;
}

/**
 * Just before saving: is the browser still signed in to the account the form
 * names? Another tab can change the session while the form is open, and
 * `updateUser` acts on whatever session the browser holds now.
 */
export type SaveGuard =
  | { ok: true }
  | { ok: false; step: "expired" | "account_changed" | "check_failed"; report: RecoveryReport | null };

export function saveGuard(
  expectedUserId: string,
  user: { id?: string } | null | undefined,
  error: AuthFailure | null | undefined
): SaveGuard {
  if (user?.id) {
    if (user.id === expectedUserId) return { ok: true };
    return {
      ok: false,
      step: "account_changed",
      report: { message: "password reset: the account changed before saving", key: "save-account-changed", level: "info" },
    };
  }
  if (classifyAuthFailure(error) === "unreachable") {
    return {
      ok: false,
      step: "check_failed",
      report: { message: "password reset: the session could not be read before saving", key: "save-check-failed" },
    };
  }
  return {
    ok: false,
    step: "expired",
    report: { message: "password reset: the session was gone when saving", key: "save-session-gone", level: "info" },
  };
}

/** What the reset page does after `updateUser`. */
export type SaveOutcome =
  | { step: "done"; report: null }
  | { step: "expired"; report: RecoveryReport }
  | { step: "form"; message: string; report: RecoveryReport | null };

export function saveOutcome(error: AuthFailure | null): SaveOutcome {
  if (!error) return { step: "done", report: null };
  if (error.code === "same_password") return { step: "form", message: RECOVERY_COPY.samePassword, report: null };
  // Supabase's own password rule (length, leaked-password check).
  if (error.code === "weak_password") return { step: "form", message: RECOVERY_COPY.refused, report: null };
  if (isSessionGone(error)) {
    return {
      step: "expired",
      report: { message: "password reset: the session was gone when saving", key: "save-session-gone", level: "info" },
    };
  }
  return {
    step: "form",
    message: RECOVERY_COPY.saveFailed,
    report: { message: "password reset: the new password could not be saved", key: "save-failed" },
  };
}
