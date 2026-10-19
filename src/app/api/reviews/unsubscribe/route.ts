import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { captureAPIError } from "@/lib/sentry";
import { verifyReviewUnsubscribe } from "@/lib/reviews/token";

/**
 * GET/POST /api/reviews/unsubscribe?id=<booking id>&token=<HMAC>
 *
 * Opt-out for the post-trip review email, same shape as
 * /api/checkout-recovery/unsubscribe:
 * - GET only renders a confirm button — link scanners prefetch every GET in
 *   an email and must not opt people out.
 * - POST performs it; also what a mail client sends for
 *   List-Unsubscribe-Post: List-Unsubscribe=One-Click.
 * Address-level: records the address the email went to (review_emails.email)
 * in review_email_optouts, which the cron checks before every send. The link
 * is keyed on the booking id, stable across retries and the reminder.
 */

export const dynamic = "force-dynamic";

const ENDPOINT = "/api/reviews/unsubscribe";
const INVALID_LINK = "This unsubscribe link is invalid or has expired.";
const GENERIC_ERROR = "Something went wrong. Please try again.";

function htmlPage(message: string, status: number, bodyExtra = "") {
  return new NextResponse(
    `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Triply</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<style>body{font-family:Arial,sans-serif;max-width:480px;margin:80px auto;text-align:center;color:#111827;padding:0 20px}
button{font:inherit;background:#f87356;color:#fff;border:0;border-radius:8px;padding:12px 24px;font-weight:bold;cursor:pointer}</style></head>
<body><h1>Triply</h1><p>${message}</p>${bodyExtra}</body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } }
  );
}

type LinkCheck = { ok: true; id: string } | { ok: false; response: NextResponse };

function checkLink(request: NextRequest, method: "GET" | "POST"): LinkCheck {
  const id = request.nextUrl.searchParams.get("id");
  const token = request.nextUrl.searchParams.get("token");
  if (!id || !token) return { ok: false, response: htmlPage(INVALID_LINK, 400) };
  let valid: boolean;
  try {
    valid = verifyReviewUnsubscribe(id, token);
  } catch (error) {
    // Missing signing secret: our fault, not the link's — say "try again".
    captureAPIError(error instanceof Error ? error : new Error(String(error)), {
      endpoint: ENDPOINT,
      method,
      stage: "verify_token",
    });
    return { ok: false, response: htmlPage(GENERIC_ERROR, 500) };
  }
  return valid ? { ok: true, id: id.toLowerCase() } : { ok: false, response: htmlPage(INVALID_LINK, 400) };
}

async function lookupEmail(
  bookingId: string,
  method: "GET" | "POST"
): Promise<{ ok: true; email: string } | { ok: false; response: NextResponse }> {
  const supabase = await createAdminClient();
  const { data, error } = await supabase
    .from("review_emails")
    .select("email")
    .eq("booking_id", bookingId)
    .limit(1)
    .abortSignal(AbortSignal.timeout(3_000));
  if (error) {
    captureAPIError(new Error(error.message), { endpoint: ENDPOINT, method, stage: "lookup", code: error.code });
    return { ok: false, response: htmlPage(GENERIC_ERROR, 500) };
  }
  const row = Array.isArray(data) ? data[0] : undefined;
  const email = row && typeof row.email === "string" ? row.email.toLowerCase() : null;
  if (!email) return { ok: false, response: htmlPage("This link no longer exists.", 404) };
  return { ok: true, email };
}

export async function GET(request: NextRequest) {
  const link = checkLink(request, "GET");
  if (!link.ok) return link.response;
  try {
    const found = await lookupEmail(link.id, "GET");
    if (!found.ok) return found.response;
  } catch (error) {
    captureAPIError(error instanceof Error ? error : new Error(String(error)), { endpoint: ENDPOINT, method: "GET" });
    return htmlPage(GENERIC_ERROR, 500);
  }
  return htmlPage(
    "Stop emails asking you to review your Triply parking?",
    200,
    `<form method="post" action="${request.nextUrl.toString().replace(/&/g, "&amp;").replace(/"/g, "&quot;")}">
      <button type="submit">Yes, unsubscribe me</button>
    </form>`
  );
}

export async function POST(request: NextRequest) {
  const link = checkLink(request, "POST");
  if (!link.ok) return link.response;
  try {
    const found = await lookupEmail(link.id, "POST");
    if (!found.ok) return found.response;

    const supabase = await createAdminClient();
    const { error } = await supabase
      .from("review_email_optouts")
      .insert({ email: found.email })
      .abortSignal(AbortSignal.timeout(3_000));
    // 23505 = already opted out — the outcome the person asked for.
    if (error && error.code !== "23505") {
      captureAPIError(new Error(error.message), { endpoint: ENDPOINT, method: "POST", stage: "insert", code: error.code });
      return htmlPage(GENERIC_ERROR, 500);
    }
  } catch (error) {
    captureAPIError(error instanceof Error ? error : new Error(String(error)), { endpoint: ENDPOINT, method: "POST" });
    return htmlPage(GENERIC_ERROR, 500);
  }
  return htmlPage("You're unsubscribed. You won't get any more emails asking you to review your parking.", 200);
}
