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

const INVALID_LINK = "This unsubscribe link is invalid or has expired.";
const GENERIC_ERROR = "Something went wrong. Please try again.";

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

/**
 * Either the row id the caller may act on, or the response to send instead —
 * a discriminated result rather than a nullable one, so the handlers can only
 * reach the query WITH a non-null id (TypeScript enforces it; the previous
 * shape left `id` as `string | null` at the `.eq("id", id)` below and rested
 * on a reader noticing that the guard had already excluded null).
 *
 *
 * verifyWaitlistToken THROWS (a WaitlistConfigError) rather than returning
 * false when WAITLIST_SIGNING_SECRET is missing — deliberately, so a config
 * fault is never mistaken for a forged token. Both handlers call this before
 * their own try block, so without this wrapper that throw became Next's raw
 * 500: an unstyled error page for a human, and — on the one-click
 * List-Unsubscribe-Post that Gmail/Yahoo send on the recipient's behalf — a
 * failed unsubscribe, which is exactly the signal that downgrades a sender's
 * domain reputation (pass 4, item 8). Kept DISTINCT from the 400: "this link
 * is invalid" tells a traveller holding a perfectly good link to stop trying,
 * when the truth is "our side is broken, try again".
 */
type LinkCheck =
  | { ok: true; id: string }
  | { ok: false; response: NextResponse };

function checkLink(
  id: string | null,
  token: string | null,
  method: "GET" | "POST"
): LinkCheck {
  if (!id || !token) {
    return { ok: false, response: htmlPage(INVALID_LINK, 400) };
  }

  let valid: boolean;
  try {
    valid = verifyWaitlistToken(id, token);
  } catch (error) {
    captureAPIError(error instanceof Error ? error : new Error(String(error)), {
      endpoint: "/api/waitlist/unsubscribe",
      method,
      stage: "verify_token",
    });
    return { ok: false, response: htmlPage(GENERIC_ERROR, 500) };
  }

  return valid
    ? { ok: true, id }
    : { ok: false, response: htmlPage(INVALID_LINK, 400) };
}

/** GET: show a confirm button. Does NOT unsubscribe — see file header. */
export async function GET(request: NextRequest) {
  const { id, token } = parseParams(request);

  const link = checkLink(id, token, "GET");
  if (!link.ok) return link.response;

  try {
    const supabase = await createAdminClient();
    const { data: row, error } = await supabase
      .from("booking_waitlist")
      .select("id")
      .eq("id", link.id)
      .maybeSingle();

    if (error) {
      captureAPIError(new Error(error.message), {
        endpoint: "/api/waitlist/unsubscribe",
        method: "GET",
        code: error.code,
      });
      return htmlPage(GENERIC_ERROR, 500);
    }

    if (!row) {
      return htmlPage("This waitlist entry no longer exists.", 404);
    }
  } catch (error) {
    captureAPIError(error instanceof Error ? error : new Error(String(error)), {
      endpoint: "/api/waitlist/unsubscribe",
      method: "GET",
    });
    return htmlPage(GENERIC_ERROR, 500);
  }

  return confirmPage(request.nextUrl.toString());
}

/** POST: performs the unsubscribe, address-wide. See file header. */
export async function POST(request: NextRequest) {
  const { id, token } = parseParams(request);

  const link = checkLink(id, token, "POST");
  if (!link.ok) return link.response;

  try {
    const supabase = await createAdminClient();

    const { data: row, error: lookupError } = (await supabase
      .from("booking_waitlist")
      .select("id, email, unsubscribed_at")
      .eq("id", link.id)
      .maybeSingle()) as { data: BookingWaitlistRow | null; error: { message: string; code?: string } | null };

    if (lookupError) {
      captureAPIError(new Error(lookupError.message), {
        endpoint: "/api/waitlist/unsubscribe",
        method: "POST",
        stage: "lookup",
        code: lookupError.code,
      });
      return htmlPage(GENERIC_ERROR, 500);
    }

    // Unknown/deleted id must be an honest 404, not a false "you're
    // unsubscribed" 200 — the traveller (or, via List-Unsubscribe-Post, their
    // mail client) needs to know nothing actually happened.
    if (!row) {
      return htmlPage("This waitlist entry no longer exists.", 404);
    }

    const email = row.email.toLowerCase();

    // Address-level suppression: every row for this email, not just this id.
    //
    // `.eq`, NEVER `.ilike` (pass 4, item 1): PostgREST's ilike takes a LIKE
    // PATTERN, so `first_last@gmail.com` unsubscribing would also suppress
    // `first.last@`, `first-last@`, `firstXlast@` — real strangers, silently,
    // because those rows DO match and the empty-result guard below never
    // fires. Equality against the lowercased address is sound because every
    // row is written lowercased (the zod transform in /api/waitlist) and the
    // DB enforces it (the booking_waitlist_email_lowercase CHECK, migration
    // 026), so there is no case-folding left for ilike to do.
    //
    // `.select("id")` so a zero-row match is visible: an update with no
    // matching WHERE clause returns no error, only an empty result, so
    // without it this always "succeeded".
    const { data: updatedRows, error: updateError } = await supabase
      .from("booking_waitlist")
      .update({ unsubscribed_at: new Date().toISOString() })
      .eq("email", email)
      .select("id");

    if (updateError) {
      captureAPIError(new Error(updateError.message), {
        endpoint: "/api/waitlist/unsubscribe",
        method: "POST",
        stage: "update",
        code: updateError.code,
      });
      return htmlPage(GENERIC_ERROR, 500);
    }

    if (!updatedRows || updatedRows.length === 0) {
      // The lookup above found this id by its own id (not by email), so
      // getting here means the update's email filter matched nothing for a
      // row we just confirmed exists — i.e. a stored address that is not
      // lowercase, which the 026 CHECK is meant to make impossible. A real
      // bug, not an expected empty state. Must not report success: the
      // traveller would believe they're unsubscribed while every row for
      // their address is still live.
      captureAPIError(
        new Error("waitlist unsubscribe: update matched no rows for a looked-up id"),
        { endpoint: "/api/waitlist/unsubscribe", method: "POST", stage: "update_no_match" }
      );
      return htmlPage(GENERIC_ERROR, 500);
    }
  } catch (error) {
    captureAPIError(error instanceof Error ? error : new Error(String(error)), {
      endpoint: "/api/waitlist/unsubscribe",
      method: "POST",
    });
    return htmlPage(GENERIC_ERROR, 500);
  }

  return htmlPage("You're unsubscribed. You won't get any more emails about this waitlist.", 200);
}
