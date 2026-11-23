import { NextResponse } from "next/server";
import {
  RECOVERY_COOKIE,
  RECOVERY_COOKIE_MAX_AGE_SECONDS,
  RECOVERY_COOKIE_OPTIONS,
  isRecoveryTokenShape,
} from "@/lib/auth/recovery";
import { reportRecovery } from "@/lib/auth/recovery-report";

/**
 * GET /auth/confirm — where the password-reset email's link lands.
 *
 * It checks nothing with Supabase. It moves the one-time token out of the
 * address into a short-lived cookie and sends the person to the reset page,
 * which spends the token only when they press Continue. So a mail scanner
 * that opens the link does not use it up, and no page is shown with the token
 * in its address. This request's own URL still carries the token:
 * lib/sentry-scrub.ts removes it from what Sentry is sent.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const type = url.searchParams.get("type");
  const token = url.searchParams.get("token_hash");

  if (type !== "recovery" || !isRecoveryTokenShape(token)) {
    // Which check failed, never the value. A wrong email template would send
    // every customer here, so it must be visible.
    reportRecovery(
      { message: "password reset: a link arrived in the wrong shape", key: "confirm-bad-link", level: "warning" },
      { endpoint: "/auth/confirm", method: "GET" },
      null,
      { reason: type !== "recovery" ? "type" : "token" }
    );
    return NextResponse.redirect(new URL("/auth/forgot-password?error=expired", url.origin));
  }

  // `link=1` only tells the page to offer Continue; it is not a secret.
  const response = NextResponse.redirect(new URL("/auth/reset-password?link=1", url.origin));
  response.cookies.set(RECOVERY_COOKIE, token, {
    ...RECOVERY_COOKIE_OPTIONS,
    maxAge: RECOVERY_COOKIE_MAX_AGE_SECONDS,
  });
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}
