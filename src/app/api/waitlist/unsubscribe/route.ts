import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { captureAPIError } from "@/lib/sentry";
import { verifyWaitlistToken } from "@/lib/waitlist/unsubscribe-token";

/**
 * GET /api/waitlist/unsubscribe?id=<row id>&token=<HMAC(id)>
 *
 * One-click, no-login unsubscribe for the waitlist confirmation and
 * opens-on emails (both carry this link + a List-Unsubscribe header). The
 * token is an HMAC of the row id, so this needs no session and no separate
 * lookup table — only the sender (who holds PAYLOAD_SECRET) could have
 * produced a valid token for a given id. See src/lib/waitlist/unsubscribe-token.ts.
 */

export const dynamic = "force-dynamic";

function htmlPage(message: string, status: number) {
  return new NextResponse(
    `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Triply</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font-family:Arial,sans-serif;max-width:480px;margin:80px auto;text-align:center;color:#111827;padding:0 20px}
a{color:#f87356}</style></head>
<body><h1>Triply</h1><p>${message}</p></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } }
  );
}

export async function GET(request: NextRequest) {
  const id = request.nextUrl.searchParams.get("id");
  const token = request.nextUrl.searchParams.get("token");

  if (!id || !token || !verifyWaitlistToken(id, token)) {
    return htmlPage("This unsubscribe link is invalid or has expired.", 400);
  }

  try {
    const supabase = await createAdminClient();
    const { error } = await supabase
      .from("booking_waitlist")
      .update({ unsubscribed_at: new Date().toISOString() })
      .eq("id", id);

    if (error) {
      captureAPIError(new Error(error.message), {
        endpoint: "/api/waitlist/unsubscribe",
        method: "GET",
        code: error.code,
      });
      return htmlPage("Something went wrong. Please try again.", 500);
    }
  } catch (error) {
    captureAPIError(error instanceof Error ? error : new Error(String(error)), {
      endpoint: "/api/waitlist/unsubscribe",
      method: "GET",
    });
    return htmlPage("Something went wrong. Please try again.", 500);
  }

  return htmlPage("You're unsubscribed. You won't get any more emails about this waitlist entry.", 200);
}
