import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { captureAPIError } from "@/lib/sentry";
import { verifyWaitlistToken } from "@/lib/waitlist/unsubscribe-token";

/**
 * GET/POST /api/waitlist/unsubscribe?id=<row id>&token=<HMAC(id)>
 *
 * One-click, no-login unsubscribe for the waitlist confirmation and
 * opens-on emails (both carry this link + a List-Unsubscribe /
 * List-Unsubscribe-Post header). The token is an HMAC of the row id, so this
 * needs no session and no separate lookup table — only the sender (who holds
 * WAITLIST_SIGNING_SECRET) could have produced a valid token for a given id.
 * See src/lib/waitlist/unsubscribe-token.ts.
 *
 * GET vs POST split (RFC 8058 one-click unsubscribe):
 * - GET renders a confirm page with a button that POSTs to this same URL. A
 *   human clicking the email link lands here first — Outlook Safe Links /
 *   Proofpoint / other link-scanners prefetch every GET in an email, so a GET
 *   that performed the unsubscribe would silently opt people out before they
 *   ever open the message.
 * - POST performs the actual unsubscribe. This is also what
 *   List-Unsubscribe-Post: List-Unsubscribe=One-Click tells a mail client to
 *   send directly (no page, no click) when the recipient uses the client's
 *   built-in "Unsubscribe" affordance — that's a trusted, user-initiated
 *   action, not a scanner, so it's safe to act on immediately.
 *
 * Unsubscribe is address-level, not row-level: a traveller can hold several
 * waitlist rows (different airports/trips), and List-Unsubscribe is an
 * address-level signal to the mail client — so POST suppresses every row
 * for this email, not just the one the link was minted for.
 */

export const dynamic = "force-dynamic";

interface BookingWaitlistRow {
  id: string;
  email: string;
  unsubscribed_at: string | null;
}

function htmlPage(message: string, status: number, bodyExtra = "") {
  return new NextResponse(
    `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Triply</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font-family:Arial,sans-serif;max-width:480px;margin:80px auto;text-align:center;color:#111827;padding:0 20px}
a{color:#f87356}
button{font:inherit;background:#f87356;color:#fff;border:0;border-radius:8px;padding:12px 24px;font-weight:bold;cursor:pointer}</style></head>
<body><h1>Triply</h1><p>${message}</p>${bodyExtra}</body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } }
  );
}

function confirmPage(actionUrl: string) {
  return htmlPage(
    "Unsubscribe from Triply waitlist emails?",
    200,
    `<form method="post" action="${actionUrl}">
      <button type="submit">Yes, unsubscribe me</button>
    </form>`
  );
}

function parseParams(request: NextRequest): { id: string | null; token: string | null } {
  return {
    id: request.nextUrl.searchParams.get("id"),
    token: request.nextUrl.searchParams.get("token"),
  };
}

/** GET: show a confirm button. Does NOT unsubscribe — see file header. */
export async function GET(request: NextRequest) {
  const { id, token } = parseParams(request);

  if (!id || !token || !verifyWaitlistToken(id, token)) {
    return htmlPage("This unsubscribe link is invalid or has expired.", 400);
  }

  try {
    const supabase = await createAdminClient();
    const { data: row, error } = await supabase
      .from("booking_waitlist")
      .select("id")
      .eq("id", id)
      .maybeSingle();

    if (error) {
      captureAPIError(new Error(error.message), {
        endpoint: "/api/waitlist/unsubscribe",
        method: "GET",
        code: error.code,
      });
      return htmlPage("Something went wrong. Please try again.", 500);
    }

    if (!row) {
      return htmlPage("This waitlist entry no longer exists.", 404);
    }
  } catch (error) {
    captureAPIError(error instanceof Error ? error : new Error(String(error)), {
      endpoint: "/api/waitlist/unsubscribe",
      method: "GET",
    });
    return htmlPage("Something went wrong. Please try again.", 500);
  }

  return confirmPage(request.nextUrl.toString());
}

/** POST: performs the unsubscribe, address-wide. See file header. */
export async function POST(request: NextRequest) {
  const { id, token } = parseParams(request);

  if (!id || !token || !verifyWaitlistToken(id, token)) {
    return htmlPage("This unsubscribe link is invalid or has expired.", 400);
  }

  try {
    const supabase = await createAdminClient();

    const { data: row, error: lookupError } = (await supabase
      .from("booking_waitlist")
      .select("id, email, unsubscribed_at")
      .eq("id", id)
      .maybeSingle()) as { data: BookingWaitlistRow | null; error: { message: string; code?: string } | null };

    if (lookupError) {
      captureAPIError(new Error(lookupError.message), {
        endpoint: "/api/waitlist/unsubscribe",
        method: "POST",
        stage: "lookup",
        code: lookupError.code,
      });
      return htmlPage("Something went wrong. Please try again.", 500);
    }

    // Unknown/deleted id must be an honest 404, not a false "you're
    // unsubscribed" 200 — the traveller (or, via List-Unsubscribe-Post, their
    // mail client) needs to know nothing actually happened.
    if (!row) {
      return htmlPage("This waitlist entry no longer exists.", 404);
    }

    const email = row.email.toLowerCase();

    // Address-level suppression: every row for this email, not just this id.
    // `.ilike` (not `.eq`) because the unique index (026) and every other
    // suppression check in this codebase treat the address as
    // case-insensitive via lower(email) — a plain `.eq("email", email)`
    // against a differently-cased stored value would match zero rows and
    // still report success below. `.select("id")` so a zero-row match is
    // visible: an update with no matching WHERE clause returns no error,
    // only an empty result, so without it this always "succeeded".
    const { data: updatedRows, error: updateError } = await supabase
      .from("booking_waitlist")
      .update({ unsubscribed_at: new Date().toISOString() })
      .ilike("email", email)
      .select("id");

    if (updateError) {
      captureAPIError(new Error(updateError.message), {
        endpoint: "/api/waitlist/unsubscribe",
        method: "POST",
        stage: "update",
        code: updateError.code,
      });
      return htmlPage("Something went wrong. Please try again.", 500);
    }

    if (!updatedRows || updatedRows.length === 0) {
      // The lookup above found this id by its own id (not by email), so
      // getting here means the update's email filter matched nothing for a
      // row we just confirmed exists — a real bug (e.g. a casing mismatch
      // this filter didn't actually cover), not an expected empty state.
      // Must not report success: the traveller would believe they're
      // unsubscribed while every row for their address is still live.
      captureAPIError(
        new Error("waitlist unsubscribe: update matched no rows for a looked-up id"),
        { endpoint: "/api/waitlist/unsubscribe", method: "POST", stage: "update_no_match" }
      );
      return htmlPage("Something went wrong. Please try again.", 500);
    }
  } catch (error) {
    captureAPIError(error instanceof Error ? error : new Error(String(error)), {
      endpoint: "/api/waitlist/unsubscribe",
      method: "POST",
    });
    return htmlPage("Something went wrong. Please try again.", 500);
  }

  return htmlPage("You're unsubscribed. You won't get any more emails about this waitlist.", 200);
}
