import { NextRequest, NextResponse } from "next/server";
import { parseRatingParam } from "@/lib/reviews/schema";
import { REVIEW_COOKIE, REVIEW_COOKIE_MAX_AGE_S, REVIEW_TOKEN_SHAPE } from "@/lib/reviews/token";

/**
 * GET /review/{token}?r=N — the link in the post-trip email.
 *
 * Moves the token (a credential for this booking's review) out of the URL:
 * it is set as an HttpOnly cookie and the browser is redirected to the
 * token-free /review?r=N. Analytics (GA4 page_location), session recording and
 * Sentry only ever see /review. Nothing is verified or written here — the
 * /review page verifies the token, and only an explicit Save writes — so a
 * mail scanner fetching every link changes nothing.
 */

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const wellFormed = REVIEW_TOKEN_SHAPE.test(token);

  const target = new URL("/review", request.nextUrl.origin);
  const rating = parseRatingParam(request.nextUrl.searchParams.get("r") ?? undefined);
  if (rating !== null) target.searchParams.set("r", String(rating));
  // Not a token we could have issued: no cookie, and the page says so.
  if (!wellFormed) target.searchParams.set("link", "invalid");

  const res = NextResponse.redirect(target, 303);
  res.headers.set("Cache-Control", "no-store");
  res.headers.set("Referrer-Policy", "no-referrer");
  res.headers.set("X-Robots-Tag", "noindex");
  if (wellFormed) {
    res.cookies.set(REVIEW_COOKIE, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: REVIEW_COOKIE_MAX_AGE_S,
    });
  }
  return res;
}
