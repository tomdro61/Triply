import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { captureAPIError } from "@/lib/sentry";
import { verifyRecoveryToken } from "@/lib/checkout-recovery/unsubscribe-token";

/**
 * GET/POST /api/checkout-recovery/unsubscribe?id=<PaymentIntent id>&token=<HMAC>
 *
 * Opt-out for the "you didn't finish booking" email, same shape as
 * /api/waitlist/unsubscribe (see that route's header for the full reasoning):
 * - GET only renders a confirm button — link scanners prefetch every GET in
 *   an email and must not opt people out.
 * - POST performs it; also what a mail client sends for
 *   List-Unsubscribe-Post: List-Unsubscribe=One-Click.
 * Address-level: records the ledger row's email in checkout_recovery_optouts,
 * which the cron checks before every send. The link is keyed on the
 * PaymentIntent (UNIQUE on the ledger), not the row id — see
 * recoveryUnsubscribeUrl for why.
 */

export const dynamic = "force-dynamic";

const ENDPOINT = "/api/checkout-recovery/unsubscribe";
const INVALID_LINK = "This unsubscribe link is invalid or has expired.";
const GENERIC_ERROR = "Something went wrong. Please try again.";

function htmlPage(message: string, status: number, bodyExtra = "") {
  return new NextResponse(
    `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Triply</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font-family:Arial,sans-serif;max-width:480px;margin:80px auto;text-align:center;color:#111827;padding:0 20px}
button{font:inherit;background:#f87356;color:#fff;border:0;border-radius:8px;padding:12px 24px;font-weight:bold;cursor:pointer}</style></head>
<body><h1>Triply</h1><p>${message}</p>${bodyExtra}</body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } }
  );
}

type LinkCheck = { ok: true; id: string } | { ok: false; response: NextResponse };

function checkLink(request: NextRequest, method: "GET" | "POST"): LinkCheck {
  const id = request.nextUrl.searchParams.get("id");
  const token = request.nextUrl.searchParams.get("token");
  if (!id || !token) return { ok: false, response: htmlPage(INVALID_LINK, 400) };
  let valid: boolean;
  try {
    valid = verifyRecoveryToken(id, token);
  } catch (error) {
    // Missing signing secret: our fault, not the link's — say "try again".
    captureAPIError(error instanceof Error ? error : new Error(String(error)), {
      endpoint: ENDPOINT,
      method,
      stage: "verify_token",
    });
    return { ok: false, response: htmlPage(GENERIC_ERROR, 500) };
  }
  return valid ? { ok: true, id } : { ok: false, response: htmlPage(INVALID_LINK, 400) };
}

async function lookupEmail(
  id: string,
  method: "GET" | "POST"
): Promise<{ ok: true; email: string } | { ok: false; response: NextResponse }> {
  const supabase = await createAdminClient();
  const { data, error } = await supabase
    .from("checkout_recovery_emails")
    .select("id, email")
    .eq("stripe_payment_intent_id", id)
    .abortSignal(AbortSignal.timeout(3_000))
    .maybeSingle();
  if (error) {
    captureAPIError(new Error(error.message), { endpoint: ENDPOINT, method, stage: "lookup", code: error.code });
    return { ok: false, response: htmlPage(GENERIC_ERROR, 500) };
  }
  if (!data) return { ok: false, response: htmlPage("This link no longer exists.", 404) };
  return { ok: true, email: String((data as { email: string }).email).toLowerCase() };
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
    "Stop emails about unfinished Triply bookings?",
    200,
    `<form method="post" action="${request.nextUrl.toString().replace(/"/g, "&quot;")}">
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
      .from("checkout_recovery_optouts")
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
  return htmlPage("You're unsubscribed. You won't get any more emails about unfinished bookings.", 200);
}
