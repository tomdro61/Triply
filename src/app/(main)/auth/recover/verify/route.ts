import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { captureAPIError } from "@/lib/sentry";
import {
  RECOVERY_COOKIE,
  RECOVERY_COOKIE_PATH,
  isRecoveryTokenShape,
  tokenCheckResult,
} from "@/lib/auth/recovery";

const ENDPOINT = "/auth/recover/verify";

function answer(status: number, body: Record<string, string>, clearToken: boolean) {
  const response = NextResponse.json(body, { status });
  response.headers.set("Cache-Control", "no-store");
  if (clearToken) {
    response.cookies.set(RECOVERY_COOKIE, "", {
      httpOnly: true,
      secure: true,
      sameSite: "strict",
      path: RECOVERY_COOKIE_PATH,
      maxAge: 0,
    });
  }
  return response;
}

/**
 * POST /auth/recover/verify — the reset page's Continue button.
 *
 * Spends the one-time token that `/auth/confirm` put in a cookie and signs
 * the person in for the password change. Answers:
 *   200 { email }  go on; the page shows whose password is being set
 *   410            the link is spent or too old, and nobody is signed in
 *   502            Supabase could not be reached; the token is kept for a retry
 */
export async function POST(request: Request) {
  // Our own page only. A browser sends Origin on every POST.
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== new URL(request.url).origin) {
    return answer(403, { error: "forbidden" }, false);
  }

  const cookieStore = await cookies();
  const stored = cookieStore.get(RECOVERY_COOKIE)?.value;
  const token = isRecoveryTokenShape(stored) ? stored : null;
  const supabase = await createClient();

  if (token) {
    const { data, error } = await supabase.auth.verifyOtp({ type: "recovery", token_hash: token });
    const result = tokenCheckResult(error);

    if (result === "unreachable") {
      captureAPIError(new Error("password reset: the link could not be checked"), {
        endpoint: ENDPOINT,
        method: "POST",
        statusCode: error?.status,
        code: error?.code,
        stage: "verify_token",
      });
      return answer(502, { error: "check_failed" }, false);
    }

    if (result === "ok") {
      const email = data.user?.email;
      if (email) return answer(200, { email }, true);
      // Accepted, but no account came back: not a state to guess from.
      captureAPIError(new Error("password reset: the link was accepted without an account"), {
        endpoint: ENDPOINT,
        method: "POST",
        stage: "verify_token",
      });
      return answer(502, { error: "check_failed" }, true);
    }
    // Refused: fall through. A second tab may have spent it a moment ago.
  }

  // No token, or a spent one: someone already signed in can still go on.
  const { data: session, error: sessionError } = await supabase.auth.getUser();
  if (session.user?.email) return answer(200, { email: session.user.email }, true);

  // "Not signed in" arrives as a 4xx here; only a failure to ask is a fault.
  if (sessionError && tokenCheckResult(sessionError) === "unreachable") {
    captureAPIError(new Error("password reset: the session could not be read"), {
      endpoint: ENDPOINT,
      method: "POST",
      statusCode: sessionError.status,
      code: sessionError.code,
      stage: "read_session",
    });
    return answer(502, { error: "check_failed" }, false);
  }

  return answer(410, { error: "expired" }, true);
}
