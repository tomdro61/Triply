import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  RECOVERY_COOKIE,
  RECOVERY_COOKIE_OPTIONS,
  classifyAuthFailure,
  isRecoveryTokenShape,
  type AuthFailure,
} from "@/lib/auth/recovery";
import { reportRecovery, thrownFailure } from "@/lib/auth/recovery-report";

// Two short calls to Supabase. A hung one must not hold the page's spinner.
export const maxDuration = 20;
const SUPABASE_TIMEOUT_MS = 8_000;

const WHERE = { endpoint: "/auth/recover/verify", method: "POST" } as const;

function answer(status: number, body: Record<string, string | boolean>, clearToken: boolean) {
  const response = NextResponse.json(body, { status });
  response.headers.set("Cache-Control", "no-store");
  if (clearToken) response.cookies.set(RECOVERY_COOKIE, "", { ...RECOVERY_COOKIE_OPTIONS, maxAge: 0 });
  return response;
}

type Asked<T> = { data: T | null; failure: AuthFailure | null };

/** One Supabase call: its data, or what we keep of its failure. Never throws. */
async function ask<T>(
  call: () => Promise<{ data: T; error: null } | { data: unknown; error: AuthFailure }>
): Promise<Asked<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<Asked<T>>((resolve) => {
      timer = setTimeout(
        () => resolve({ data: null, failure: { status: 0, name: "Timeout" } }),
        SUPABASE_TIMEOUT_MS
      );
    });
    const asked = call().then((result): Asked<T> =>
      result.error
        ? { data: null, failure: { status: result.error.status, code: result.error.code, name: result.error.name } }
        : { data: result.data, failure: null }
    );
    return await Promise.race([asked, timeout]);
  } catch (error) {
    return { data: null, failure: thrownFailure(error) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * POST /auth/recover/verify — the reset page's Continue button.
 *
 * Spends the one-time token that `/auth/confirm` put in a cookie and signs
 * the person in for the password change. Answers:
 *   200 { email, userId, switched }  go on; the page shows whose password is
 *        being set. `switched`: the browser was signed in to another account.
 *   403  the request did not come from our own page
 *   410  the link is spent or too old, and nobody is signed in
 *   502  no usable answer from Supabase. The token is kept for a retry, except
 *        when Supabase accepted it without naming an account (it is spent).
 */
export async function POST(request: Request) {
  // Our own page only. A browser sends Origin on every POST; a caller without
  // one is not a browser and holds no customer's cookie.
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== new URL(request.url).origin) {
    reportRecovery(
      { message: "password reset: Continue arrived from another origin", key: "verify-origin", level: "warning" },
      WHERE,
      null,
      { origin: origin.slice(0, 100), expected: new URL(request.url).origin }
    );
    return answer(403, { error: "forbidden" }, false);
  }

  const cookieStore = await cookies();
  const stored = cookieStore.get(RECOVERY_COOKIE)?.value;
  const token = isRecoveryTokenShape(stored) ? stored : null;
  const supabase = await createClient();

  if (token) {
    // Who the browser is signed in as now, to say so if the link changes it.
    // Best effort: a failure here only loses the notice.
    const before = await ask(() => supabase.auth.getUser());
    const previousUserId = before.data?.user?.id ?? null;

    const verified = await ask(() => supabase.auth.verifyOtp({ type: "recovery", token_hash: token }));
    const result = classifyAuthFailure(verified.failure);

    if (result === "unreachable") {
      reportRecovery(
        { message: "password reset: the link could not be checked", key: "verify-unreachable" },
        WHERE,
        verified.failure
      );
      return answer(502, { error: "check_failed" }, false);
    }

    if (result === "ok") {
      const user = verified.data?.user;
      if (user?.id && user.email) {
        return answer(
          200,
          { email: user.email, userId: user.id, switched: previousUserId !== null && previousUserId !== user.id },
          true
        );
      }
      // Accepted, but no account came back: not a state to guess from.
      reportRecovery(
        { message: "password reset: the link was accepted without an account", key: "verify-no-account" },
        WHERE
      );
      return answer(502, { error: "check_failed" }, true);
    }

    // Refused. "otp_expired" is the everyday case (old, used, or replaced by a
    // newer email); any other code may mean the email template or a setting is
    // wrong for everyone, so it is louder.
    const code = verified.failure?.code ?? "none";
    reportRecovery(
      {
        message: "password reset: a link was refused",
        key: `verify-refused-${code}`,
        level: code === "otp_expired" ? "info" : "warning",
      },
      WHERE,
      verified.failure
    );
    // Fall through: a second tab may have spent it a moment ago.
  }

  // No token, or a spent one: someone already signed in can still go on.
  const session = await ask(() => supabase.auth.getUser());
  const user = session.data?.user;
  if (user?.id && user.email) {
    return answer(200, { email: user.email, userId: user.id, switched: false }, true);
  }

  // "Not signed in" is a refusal here; only a failure to ask is a fault.
  if (classifyAuthFailure(session.failure) === "unreachable") {
    reportRecovery(
      { message: "password reset: the session could not be read", key: "verify-session-unreachable" },
      WHERE,
      session.failure
    );
    return answer(502, { error: "check_failed" }, false);
  }

  return answer(410, { error: "expired" }, true);
}
