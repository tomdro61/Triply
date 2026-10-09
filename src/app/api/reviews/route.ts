import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { captureAPIError } from "@/lib/sentry";
import { isSameOrigin } from "@/lib/http/origin";
import { isReviewConfigError, verifyReviewToken } from "@/lib/reviews/token";
import { reviewSubmitSchema } from "@/lib/reviews/schema";
import { loadReviewContext, upsertReview } from "@/lib/reviews/store";

/**
 * POST /api/reviews — record a post-trip review.
 *
 * Auth is the signed link itself: the body carries the /review/{token} token,
 * which names the booking and expires (src/lib/reviews/token.ts). Nothing is
 * written unless the token verifies and the booking is still a reviewable
 * stay. Same-origin only (the review page is the one caller).
 *
 * Body (Zod, src/lib/reviews/schema.ts): { token, rating } for a star tap, or
 * { token, rating, details } for the optional form.
 */

export const dynamic = "force-dynamic";

const CTX = { endpoint: "/api/reviews", method: "POST" as const };

export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = reviewSubmitSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid review", issues: parsed.error.issues.map((i) => i.message) }, { status: 400 });
  }
  const { token, rating, details } = parsed.data;

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

  try {
    const supabase = await createAdminClient();
    const ctx = await loadReviewContext(supabase, verified.bookingId);
    if (ctx.kind === "not_found") return NextResponse.json({ error: "Booking not found" }, { status: 404 });
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
