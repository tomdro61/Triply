import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { captureAPIError } from "@/lib/sentry";
import { isSameOrigin } from "@/lib/http/origin";
import { isReviewConfigError, REVIEW_COOKIE, verifyReviewToken } from "@/lib/reviews/token";
import { reviewSubmitSchema } from "@/lib/reviews/schema";
import { loadReviewContext, upsertReview } from "@/lib/reviews/store";

/**
 * POST /api/reviews — record a post-trip review (the review page's Save).
 *
 * Auth is the signed link itself, carried in the HttpOnly review cookie that
 * /review/{token} sets (src/lib/reviews/token.ts): it names the booking and
 * expires. Nothing is written unless the token verifies and the booking is
 * still a reviewable stay. Same-origin only (the review page is the one caller).
 *
 * Body (Zod, src/lib/reviews/schema.ts): { bookingId, rating, details? }. The
 * bookingId must be the cookie's booking (412 otherwise — another review link
 * replaced the cookie since this page loaded).
 */

export const dynamic = "force-dynamic";

const CTX = { endpoint: "/api/reviews", method: "POST" as const };
/** The form is a rating, two choices, a 500-char comment and a checkbox. */
const MAX_BODY_BYTES = 4_096;

export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const token = request.cookies.get(REVIEW_COOKIE)?.value;
  if (!token) {
    return NextResponse.json({ error: "Invalid link" }, { status: 401 });
  }

  let body: unknown;
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) {
      return NextResponse.json({ error: "Request too large" }, { status: 413 });
    }
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = reviewSubmitSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid review", issues: parsed.error.issues.map((i) => i.message) }, { status: 400 });
  }
  const { bookingId, rating, details } = parsed.data;

  let verified: ReturnType<typeof verifyReviewToken>;
  try {
    verified = verifyReviewToken(token, Date.now());
  } catch (error) {
    if (isReviewConfigError(error)) {
      captureAPIError(error, { ...CTX, stage: "config", statusCode: 503 });
      return NextResponse.json({ error: "Reviews are temporarily unavailable" }, { status: 503 });
    }
    throw error;
  }
  if (!verified.ok) {
    // 410 for a link we issued that has run out; 401 for anything else.
    const status = verified.reason === "expired" ? 410 : 401;
    return NextResponse.json({ error: verified.reason === "expired" ? "Link expired" : "Invalid link" }, { status });
  }
  if (verified.bookingId !== bookingId.toLowerCase()) {
    // Another review link was opened since this page loaded (it replaced the cookie).
    return NextResponse.json({ error: "Stale page" }, { status: 412 });
  }

  try {
    const supabase = await createAdminClient();
    const ctx = await loadReviewContext(supabase, verified.bookingId);
    if (ctx.kind === "not_found") {
      // A valid signature for a missing booking: a lost row or a shared secret.
      captureAPIError(new Error(`reviews: signed token for a booking that does not exist (${verified.bookingId})`), {
        ...CTX,
        stage: "not_found",
        statusCode: 404,
      });
      return NextResponse.json({ error: "Booking not found" }, { status: 404 });
    }
    if (ctx.kind === "not_reviewable") {
      return NextResponse.json({ error: "This booking can't be reviewed" }, { status: 409 });
    }
    await upsertReview(supabase, ctx.booking, rating, details);
    return NextResponse.json({ ok: true });
  } catch (error) {
    captureAPIError(error instanceof Error ? error : new Error(String(error)), { ...CTX, stage: "write", statusCode: 500 });
    return NextResponse.json({ error: "Could not save your review" }, { status: 500 });
  }
}
