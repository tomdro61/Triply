/**
 * POST /api/newsletter
 *
 * Unauthenticated, visitor-facing: mints a live one-time 10% promo code per
 * new address, so it carries the same guards as /api/attribution —
 * same-origin only, a bounded per-IP limiter, a measured body cap, and one
 * Sentry event per rejection class. See src/lib/http/origin.ts and
 * src/lib/attribution/limiter.ts.
 *
 * Pass-2 review (PR #23, 2026-09-22) hardened three things that all trace
 * back to "never tell the visitor something happened that didn't":
 *   - Minting or sending can fail. The response must say so (503), not the
 *     generic "check your email" success copy — and every failure must
 *     reach Sentry, not just console.error.
 *   - A promo code that has already been redeemed (current_uses > 0) is not
 *     renewable. Only an unused code (current_uses === 0) that's merely
 *     expired/inactive is eligible for a fresh mint, and even that is gated
 *     by a 7-day welcome_sent_at cooldown so the mail path can't be pumped.
 *   - resend.emails.send() RETURNS errors, it never throws for an API-level
 *     failure (unverified domain, 429, bad recipient) — every sender in
 *     src/lib/resend/ destructures { data, error }; this route now does too.
 *
 * Pass-4/5 review (PR #23, 2026-09-23): every 200 response carries the SAME
 * body shape and copy whether the address was new or already subscribed (see
 * the SUCCESS_MESSAGE / SEND_TROUBLE_MESSAGE comment below), and the
 * read-only branches now return the SAME 429 as a mint once the per-IP mint
 * quota is spent — otherwise the status answered what the body withheld
 * ("already subscribed" was the only way to get a 200 from an IP with no mint
 * budget left).
 *
 * That narrows the enumeration oracle; it does not close it, and this comment
 * deliberately doesn't claim otherwise. Only a mint CHARGES the quota, so a
 * caller who can observe WHEN the quota trips can still infer membership —
 * roughly 15 extra requests per probed address, under a 60/min/IP request
 * ceiling. Closing that would mean charging the mint quota on read-only
 * lookups, which is worse: anyone could then spend a shared IP's signup
 * budget (airport WiFi, CGNAT) with lookups alone.
 */

import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { createAdminClient } from "@/lib/supabase/server";
import { resend, FROM_EMAIL } from "@/lib/resend/client";
import { z } from "zod";
import crypto from "crypto";
import { captureAPIError } from "@/lib/sentry";
import { isSameOrigin, clientKey } from "@/lib/http/origin";
import {
  checkNewsletterRateLimit,
  peekNewsletterRateLimit,
  NEWSLETTER_RATE_LIMIT_WINDOW_SECONDS,
  checkNewsletterRequestRateLimit,
  NEWSLETTER_REQUEST_RATE_LIMIT_WINDOW_SECONDS,
} from "@/lib/attribution/limiter";
import { getAirportByCode } from "@/config/airports";
import { isPromoCodeUsable } from "@/lib/promo/usable";

const MAX_BODY_BYTES = 2048;

// Cooldown on re-minting/re-sending a welcome code to an already-subscribed
// address, independent of the code's own state. Without this, an address
// whose code merely expired (current_uses still 0) could be resubmitted
// endlessly to keep pumping fresh mail.
const WELCOME_EMAIL_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

const UNAVAILABLE_MESSAGE =
  "We couldn't process your subscription right now. Please try again in a few minutes.";

// Pass-5 review: both clients prefer the route's own `error` string over their
// local per-status copy, which made that local copy unreachable. The route's
// strings are therefore the ones a visitor actually reads and must be
// actionable, not protocol nouns ("Forbidden", "Too many requests").
const TOO_MANY_REQUESTS_MESSAGE =
  "Too many requests — please try again in a minute.";
const FORBIDDEN_MESSAGE =
  "We couldn't process that request. Please refresh and try again.";
const TOO_LARGE_MESSAGE = "That request was too large.";
const UNEXPECTED_MESSAGE = "Something went wrong. Please try again.";

// Pass-4 review: every 200 response — new signup, already-subscribed with a
// live code, redeemed/cooldown, freshly re-minted — must say the SAME thing
// and carry the SAME shape to an unauthenticated caller. The route used to
// return an `alreadySubscribed` flag and branch-specific copy ("You're
// already subscribed — check your email", "You're already subscribed to
// Triply", etc.); that was an enumeration oracle letting anyone probe whether
// an address was already on the list. There are now exactly two possible
// 200 bodies: SUCCESS_MESSAGE (a code is on file and was/will be emailed —
// covers a fresh signup, a resend, and "already sent, nothing to do") and
// SEND_TROUBLE_MESSAGE (this specific attempt's send failed). Which one a
// given request hits still depends on internal state (new vs. existing,
// sent vs. not), but the response itself can no longer be used to infer that
// state.
// Exported so tests assert against these directly rather than duplicating
// (and risking drifting from) the literal copy.
export const SUCCESS_MESSAGE =
  "Check your inbox — if this address is new to us, your 10% code is on its way. If it doesn't arrive, contact support@triplypro.com.";
export const SEND_TROUBLE_MESSAGE =
  "We hit a snag getting your code to your inbox. If it doesn't arrive, contact support@triplypro.com.";

const newsletterSchema = z.object({
  // .trim() FIRST: zod runs .email() before any transform, so a pasted address
  // with a trailing space was rejected outright.
  email: z.string().trim().email("Invalid email address").max(254),
  // Optional attribution. Sent by the end-of-article capture on the blog and
  // (as of this pass) the homepage form; older cached clients may still send
  // none, and that keeps working exactly as before.
  source: z
    .string()
    .max(32)
    .regex(/^[a-z0-9_-]+$/, "Invalid source")
    .optional(),
  airportCode: z
    .string()
    .regex(/^[A-Za-z]{3}$/, "Invalid airport code")
    .transform((v) => v.toUpperCase())
    .refine((v) => getAirportByCode(v)?.enabled === true, "Unknown airport")
    .optional(),
  slug: z
    .string()
    .max(200)
    .regex(/^[a-z0-9-]+$/, "Invalid slug")
    .optional(),
});

function generatePromoCode(): string {
  const suffix = crypto.randomBytes(3).toString("hex").toUpperCase();
  return `WELCOME-${suffix}`;
}

function withinWelcomeCooldown(welcomeSentAt: string | null | undefined): boolean {
  if (!welcomeSentAt) return false;
  const sentAtMs = new Date(welcomeSentAt).getTime();
  if (Number.isNaN(sentAtMs)) return false;
  return Date.now() - sentAtMs < WELCOME_EMAIL_COOLDOWN_MS;
}

// Once-per-instance telemetry for each rejection class, same pattern as
// /api/attribution — sampling, not suppression. The plain counters alongside
// it are always-on: reportOnce/reportOnceError only ever surface ONE Sentry
// event per class per warm instance, so an entire segment failing (a proxy
// stripping Origin, a 30-minute Supabase blip, an IP being throttled
// continuously) would otherwise look like a single blip. The counter rides in
// that first event's context AND in every console line, so the volume stays
// recoverable from the logs even though the Sentry event necessarily reports
// the count as of the FIRST occurrence.
const reported = new Set<string>();
let originRejectionCount = 0;
let requestRateLimitCount = 0;
let mintRateLimitCount = 0;
let subscriberLookupFaultCount = 0;
let promoLookupFaultCount = 0;
export function __resetNewsletterRouteTelemetryForTests(): void {
  reported.clear();
  originRejectionCount = 0;
  requestRateLimitCount = 0;
  mintRateLimitCount = 0;
  subscriberLookupFaultCount = 0;
  promoLookupFaultCount = 0;
}
function reportOnce(kind: string, context: Record<string, unknown>) {
  if (reported.has(kind)) return;
  reported.add(kind);
  try {
    Sentry.withScope((scope) => {
      scope.setFingerprint([`newsletter_post_${kind}`]);
      scope.setContext("newsletter", context);
      Sentry.captureMessage(`POST /api/newsletter rejected: ${kind}`, "warning");
    });
  } catch {
    /* never let telemetry affect the response */
  }
}

// Same dedup as reportOnce above, but for genuine faults (captureAPIError /
// captureException) rather than rejection classes. Pass-3 review: the
// subscriber/promo lookup captures fired unconditionally, so a sustained DB
// blip on this public endpoint produced one Sentry event PER REQUEST — this
// caps it at one per class per warm instance, same sampling rationale as
// reportOnce.
function reportOnceError(
  kind: string,
  error: Error,
  context: Parameters<typeof captureAPIError>[1]
) {
  if (reported.has(kind)) return;
  reported.add(kind);
  captureAPIError(error, context);
}

type AdminClient = Awaited<ReturnType<typeof createAdminClient>>;

async function mintPromoCode(
  supabase: AdminClient
): Promise<{ id: string; code: string } | null> {
  const code = generatePromoCode();
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 30);

  const { data, error } = await supabase
    .from("promo_codes")
    .insert({
      code,
      discount_percent: 10,
      active: true,
      expires_at: expiresAt.toISOString(),
      max_uses: 1,
      current_uses: 0,
    })
    .select("id")
    .single();

  if (error || !data) {
    console.error("Error creating promo code:", error);
    captureAPIError(
      new Error(`Failed to mint newsletter promo code: ${error?.message ?? "insert returned no row"}`),
      {
        endpoint: "/api/newsletter",
        method: "POST",
        stage: "mint",
        code: error?.code,
      }
    );
    return null;
  }
  return { id: data.id, code };
}

/**
 * Best-effort cleanup for a promo code that was minted but never durably
 * attached to a subscriber row (the follow-up insert/update failed). Without
 * this, every write failure on that path leaves a live, unused, 30-day 10%
 * code in the table with nothing pointing at it — not a security hole, but a
 * standing liability (discount inventory) that only grows. Errors here are
 * swallowed except for a Sentry capture: failing to clean up is strictly
 * better than turning an already-503'd request into a 500.
 *
 * `.select("id")` is not decoration. Without it PostgREST returns no rows and
 * a delete that matched NOTHING is indistinguishable from one that worked, so
 * the exact failure this function exists to catch (a live code left behind)
 * would be silent. Note `promo_codes` has no FOR DELETE policy at all — this
 * works only because the service role bypasses RLS, so an anon/authenticated
 * caller could never run it and a future switch away from the admin client
 * would start returning 0 rows here. Flagged for Tom; deliberately NOT fixed
 * with a migration in this PR.
 */
async function bestEffortDeleteMintedCode(
  supabase: AdminClient,
  promoCodeId: string,
  stage: string
): Promise<void> {
  try {
    const { data: deleted, error } = await supabase
      .from("promo_codes")
      .delete()
      .eq("id", promoCodeId)
      .select("id");
    if (error) {
      console.warn(`Failed to clean up orphaned promo code ${promoCodeId} (${stage}):`, error.message);
      captureAPIError(
        new Error(`Failed to delete orphaned promo code ${promoCodeId} after ${stage} failed: ${error.message}`),
        { endpoint: "/api/newsletter", method: "POST", stage: "cleanup_orphaned_code", code: error.code }
      );
    } else if (!Array.isArray(deleted) || deleted.length === 0) {
      // No error and no row: the DELETE matched nothing (missing policy, id
      // already gone, row written by a different session). The live code is
      // still out there, so this is a real miss, not a no-op.
      console.warn(`Orphaned promo code ${promoCodeId} (${stage}) was not deleted: 0 rows matched`);
      captureAPIError(
        new Error(`Orphaned promo code ${promoCodeId} not deleted after ${stage} failed: DELETE matched 0 rows`),
        { endpoint: "/api/newsletter", method: "POST", stage: "cleanup_orphaned_code" }
      );
    }
  } catch (err) {
    console.warn(`Failed to clean up orphaned promo code ${promoCodeId} (${stage}):`, err);
    captureAPIError(
      err instanceof Error ? err : new Error(`Failed to delete orphaned promo code ${promoCodeId}: ${String(err)}`),
      { endpoint: "/api/newsletter", method: "POST", stage: "cleanup_orphaned_code" }
    );
  }
}

/**
 * Stamps welcome_sent_at ONLY after a CONFIRMED send. Pass-3 review: the
 * previous version stamped this at mint time, before the email actually
 * went out — a Resend failure then permanently locked the subscriber into
 * the `usableCode` short-circuit (unused, unexpired code on file) with no
 * resend and no re-mint. Failure to write this stamp is non-fatal: the mail
 * genuinely went out, so the response must not 503.
 *
 * Pass-5 review: "non-fatal" is only true because the resend it enables is
 * METERED. A stamp that keeps failing means the cooldown never arms, so every
 * subsequent submission of that address takes the resend branch — before the
 * mint quota covered that branch, the only brake was the 60/min request tier
 * (60 welcome emails per minute per IP to any known-subscribed address, plus
 * one Sentry event each). The quota charge in the resend branch is what makes
 * this failure survivable; the dedup below is what stops it flooding Sentry.
 */
async function stampWelcomeSentAt(supabase: AdminClient, subscriberId: string): Promise<void> {
  const { error } = await supabase
    .from("newsletter_subscribers")
    .update({ welcome_sent_at: new Date().toISOString() })
    .eq("id", subscriberId);
  if (!error) return;

  // Same deploy-window tolerance as recordSourceAttribution: welcome_sent_at
  // arrives in migration 024, and PostgREST reports a write to an unknown
  // column as PGRST204 (42703 only reaches us via a fake/direct-Postgres
  // path). Not a fault — and not a hole either, because a request that
  // couldn't READ welcome_sent_at treats the cooldown as ACTIVE rather than
  // as "never sent" (see cooldownStateUnknown in POST).
  if (error.code === "42703" || error.code === "PGRST204") {
    console.warn(
      `welcome_sent_at stamp skipped for ${subscriberId} (migration pending): ${error.message}`
    );
    return;
  }

  console.warn(`Failed to stamp welcome_sent_at for ${subscriberId}:`, error.message);
  reportOnceError(
    "stamp_welcome_sent_at",
    new Error(`Failed to stamp welcome_sent_at for subscriber ${subscriberId}: ${error.message}`),
    { endpoint: "/api/newsletter", method: "POST", stage: "stamp_welcome_sent_at", code: error.code }
  );
}

/**
 * Resend's SDK RETURNS API-level errors (unverified domain, 429, bad
 * recipient) as `{ data: null, error }` — it does not throw for them. Only a
 * transport failure (network down, DNS) throws. Both must be treated as
 * "the email did not go out": neither may be swallowed into a silent
 * success, matching every sender in src/lib/resend/.
 */
async function sendWelcomeEmail(email: string, code: string): Promise<boolean> {
  try {
    const { data, error } = await resend.emails.send({
      from: FROM_EMAIL,
      to: [email],
      subject: "Welcome to Triply! Here's your 10% off code",
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
          <div style="background-color: #1A1A2E; padding: 32px 40px; text-align: center;">
            <h1 style="margin: 0; color: #f87356; font-size: 28px; font-weight: 700; letter-spacing: -0.5px;">Triply</h1>
            <p style="margin: 4px 0 0; color: #94a3b8; font-size: 13px;">Your Trip Simplified</p>
          </div>
          <div style="padding: 40px;">
            <h2 style="margin: 0 0 20px; color: #111827; font-size: 20px; font-weight: 700;">Welcome to Triply!</h2>
            <p style="font-size: 15px; color: #374151; line-height: 1.6;">Thanks for subscribing! Here's your exclusive 10% discount code:</p>
            <div style="background-color: #f9fafb; padding: 24px; border-radius: 8px; border: 2px dashed #f87356; text-align: center; margin: 24px 0;">
              <p style="font-size: 13px; color: #9ca3af; margin: 0 0 8px;">Your Promo Code</p>
              <p style="font-size: 28px; font-weight: bold; color: #f87356; margin: 0; letter-spacing: 2px;">${code}</p>
              <p style="font-size: 13px; color: #9ca3af; margin: 8px 0 0;">Valid for 30 days &bull; One-time use</p>
            </div>
            <div style="text-align: center; margin: 30px 0;">
              <a href="https://www.triplypro.com" style="background-color: #f87356; color: white; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: bold; font-size: 16px; display: inline-block;">
                Book Now &amp; Save 10%
              </a>
            </div>
            <p style="font-size: 14px; color: #9ca3af; text-align: center;">
              Apply this code at checkout to get 10% off your first airport parking reservation.
            </p>
          </div>
          <div style="background-color: #f9fafb; padding: 24px 40px; border-top: 1px solid #e5e7eb; text-align: center;">
            <p style="margin: 0; color: #9ca3af; font-size: 12px;">
              Triply - Airport Parking Made Easy<br>
              <a href="https://www.triplypro.com" style="color: #f87356; text-decoration: none;">triplypro.com</a>
            </p>
          </div>
        </div>
      `,
    });

    if (error) {
      console.error("Newsletter welcome email failed:", error);
      captureAPIError(new Error(`Newsletter welcome email failed: ${error.message}`), {
        endpoint: "/api/newsletter",
        method: "POST",
        stage: "send_email",
      });
      return false;
    }

    return Boolean(data);
  } catch (err) {
    console.error("Newsletter welcome email failed:", err);
    captureAPIError(
      err instanceof Error ? err : new Error(`Newsletter welcome email failed: ${String(err)}`),
      { endpoint: "/api/newsletter", method: "POST", stage: "send_email" }
    );
    return false;
  }
}

/**
 * Best-effort, first-touch source attribution. Deliberately separate from
 * the subscriber insert/update: these columns arrive in migration 024 and
 * the API must keep working whether or not it has been applied, in either
 * deploy order. Keyed on the subscriber's id (not email) and gated on
 * `.is("source", null)` so a later re-signup never overwrites the original
 * touch.
 */
async function recordSourceAttribution(
  supabase: AdminClient,
  subscriberId: string,
  source: string,
  airportCode: string | undefined,
  slug: string | undefined
): Promise<void> {
  try {
    const { error } = await supabase
      .from("newsletter_subscribers")
      .update({ source, airport_code: airportCode ?? null, page: slug ?? null })
      .eq("id", subscriberId)
      .is("source", null);

    if (error) {
      // PostgREST rejects a write of an unknown column with PGRST204, not the
      // Postgres SQLSTATE 42703 — 42703 only ever gets to us via a fake/direct
      // Postgres error path. Match both so a signup during the deploy window
      // (code shipped, migration 024 not yet applied) doesn't fire Sentry on
      // every request.
      if (error.code === "42703" || error.code === "PGRST204") {
        console.warn("Newsletter source attribution skipped (migration pending):", error.message);
      } else {
        console.warn("Newsletter source attribution skipped:", error.message);
        captureAPIError(new Error(error.message), {
          endpoint: "/api/newsletter",
          method: "POST",
          stage: "attribution",
          code: error.code,
        });
      }
    }
  } catch (error) {
    console.warn("Newsletter source attribution skipped:", error);
    captureAPIError(
      error instanceof Error ? error : new Error(`Newsletter source attribution failed: ${String(error)}`),
      { endpoint: "/api/newsletter", method: "POST", stage: "attribution" }
    );
  }
}

export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) {
    originRejectionCount += 1;
    console.warn(`Newsletter origin check rejected request #${originRejectionCount} this instance`);
    reportOnce("403_origin", {
      secFetchSite: request.headers.get("sec-fetch-site"),
      origin: request.headers.get("origin"),
      host: request.headers.get("host"),
      rejectionsThisInstance: originRejectionCount,
    });
    return NextResponse.json({ error: FORBIDDEN_MESSAGE }, { status: 403 });
  }

  // Request-level ceiling, charged on every request that clears the origin
  // check — before any lookup, mint, or send. See
  // checkNewsletterRequestRateLimit in src/lib/attribution/limiter.ts: the
  // mint-only quota below leaves lookups/"already subscribed" responses
  // completely unmetered otherwise.
  if (!checkNewsletterRequestRateLimit(clientKey(request))) {
    requestRateLimitCount += 1;
    console.warn(
      `Newsletter request rate limit rejected request #${requestRateLimitCount} this instance`
    );
    reportOnce("429_request_rate_limited", {
      windowSeconds: NEWSLETTER_REQUEST_RATE_LIMIT_WINDOW_SECONDS,
      rejectionsThisInstance: requestRateLimitCount,
    });
    return NextResponse.json(
      { error: TOO_MANY_REQUESTS_MESSAGE },
      {
        status: 429,
        headers: { "Retry-After": String(NEWSLETTER_REQUEST_RATE_LIMIT_WINDOW_SECONDS) },
      }
    );
  }

  // Measure the body that actually arrived: Content-Length is absent on a
  // chunked request, so a header check alone is bypassable.
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) {
    reportOnce("413_body", { length: text.length });
    return NextResponse.json({ error: TOO_LARGE_MESSAGE }, { status: 413 });
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    reportOnce("400_json", {});
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  try {
    const result = newsletterSchema.safeParse(body);
    if (!result.success) {
      return NextResponse.json(
        { error: result.error.issues[0].message },
        { status: 400 }
      );
    }

    const { email, source, airportCode, slug } = result.data;
    const emailLower = email.toLowerCase();
    const supabase = await createAdminClient();

    type ExistingSubscriber = {
      id: string;
      unsubscribed_at: string | null;
      promo_code_id: string | null;
      welcome_sent_at?: string | null;
    };

    let existing: ExistingSubscriber | null;
    let lookupError: { code?: string; message: string } | null;
    // True when we could not READ welcome_sent_at at all (migration 024 not
    // yet applied). See the retry below.
    let cooldownStateUnknown = false;
    {
      const result = await supabase
        .from("newsletter_subscribers")
        .select("id, unsubscribed_at, promo_code_id, welcome_sent_at")
        .eq("email", emailLower)
        .single();
      existing = result.data;
      lookupError = result.error;
    }

    // welcome_sent_at ships in migration 024, same as the source/airport_code
    // columns the attribution UPDATE below already tolerates — but a SELECT
    // that names an unknown column fails the WHOLE query (unlike the UPDATE,
    // which only affects itself), so every signup would 503 during the
    // deploy window without this. Retry once without the column.
    //
    // Pass-5 review: the retry used to leave welcome_sent_at null and let the
    // rest of the handler read that as "never sent", which is the WORST
    // reading — the stamp cannot be written in that window either, so the
    // cooldown could never arm and every already-subscribed address became
    // resendable on every request for the length of the deploy window.
    // Unknown is now treated as "cooldown ACTIVE for this request": the
    // visitor still gets the usual 200, but no resend and no re-mint.
    if (lookupError && (lookupError.code === "42703" || lookupError.code === "PGRST204")) {
      const retry = await supabase
        .from("newsletter_subscribers")
        .select("id, unsubscribed_at, promo_code_id")
        .eq("email", emailLower)
        .single();
      existing = retry.data ? { ...retry.data, welcome_sent_at: null } : retry.data;
      lookupError = retry.error;
      cooldownStateUnknown = true;
    }

    // PGRST116 = no row = a genuinely new address. Anything else is a real
    // DB fault — silently treating it as "not found" would route a known
    // address into the insert branch below, hit the email UNIQUE constraint
    // (23505), and surface as an opaque 500 with an orphaned live promo code
    // already minted.
    if (lookupError && lookupError.code !== "PGRST116") {
      // Counter + unconditional console.error alongside the deduped Sentry
      // event, same treatment as the 403 path: reportOnceError emits once per
      // warm instance, so a 30-minute Supabase blip would otherwise be a
      // single event with no volume attached to it.
      subscriberLookupFaultCount += 1;
      console.error(
        `Newsletter subscriber lookup failed (#${subscriberLookupFaultCount} this instance):`,
        lookupError.message
      );
      reportOnceError(
        "503_subscriber_lookup",
        new Error(`Newsletter subscriber lookup failed: ${lookupError.message}`),
        {
          endpoint: "/api/newsletter",
          method: "POST",
          stage: "lookup",
          code: lookupError.code,
          extra: { faultsThisInstance: subscriberLookupFaultCount },
        }
      );
      return NextResponse.json({ error: UNAVAILABLE_MESSAGE }, { status: 503 });
    }

    function mintQuotaExhaustedResponse(): NextResponse {
      // Counted, like the other refusals: this response is now reachable from
      // the read-only branches too (see refuseIfMintQuotaExhausted), so an IP
      // being denied continuously must be visible as volume and not as the
      // single deduped Sentry event.
      mintRateLimitCount += 1;
      console.warn(
        `Newsletter mint quota rejected request #${mintRateLimitCount} this instance`
      );
      reportOnce("429_rate_limited", {
        windowSeconds: NEWSLETTER_RATE_LIMIT_WINDOW_SECONDS,
        rejectionsThisInstance: mintRateLimitCount,
      });
      return NextResponse.json(
        { error: TOO_MANY_REQUESTS_MESSAGE },
        {
          status: 429,
          headers: { "Retry-After": String(NEWSLETTER_RATE_LIMIT_WINDOW_SECONDS) },
        }
      );
    }

    // Charged on every path that MINTS a code or SENDS the welcome email —
    // including the resend of an existing code below. Pass-5 review: that
    // resend was free, so a subscriber whose welcome_sent_at could not be
    // written (deploy window, or any failing UPDATE) could be re-mailed 60
    // times a minute per IP, bounded only by the request tier.
    //
    // Read-only responses still do not charge it: a "you are already
    // subscribed" answer costs nothing and should not burn an IP's budget,
    // which shared IPs (airport WiFi, CGNAT) need for real signups.
    function requireMintQuota(): NextResponse | null {
      if (checkNewsletterRateLimit(clientKey(request))) return null;
      return mintQuotaExhaustedResponse();
    }

    // ...but they must not SUCCEED while a mint from the same IP fails, or the
    // status alone reveals the membership the body deliberately hides. Peek at
    // the quota (no charge, no LRU touch) and refuse identically when it is
    // spent. See the file header for what this does and does not close.
    function refuseIfMintQuotaExhausted(): NextResponse | null {
      if (peekNewsletterRateLimit(clientKey(request))) return null;
      return mintQuotaExhaustedResponse();
    }

    if (existing && !existing.unsubscribed_at) {
      let usableCode: { current_uses: number; code: string } | null = null;
      let redeemedCode = false;

      if (existing.promo_code_id) {
        const { data: promo, error: promoError } = await supabase
          .from("promo_codes")
          .select("active, current_uses, max_uses, expires_at, code")
          .eq("id", existing.promo_code_id)
          .single();

        // Same rule as checkout: only PGRST116 (no row) is "no usable code".
        // A DB blip surfaced as any other error must never be read as
        // "unusable" — that would mint a duplicate live code + email.
        if (promoError && promoError.code !== "PGRST116") {
          // Counter + unconditional console.error, same rationale as the
          // subscriber-lookup fault above.
          promoLookupFaultCount += 1;
          console.error(
            `Newsletter promo lookup failed (#${promoLookupFaultCount} this instance):`,
            promoError.message
          );
          reportOnceError(
            "503_promo_lookup",
            new Error(`Promo lookup failed for subscriber ${existing.id}: ${promoError.message}`),
            {
              endpoint: "/api/newsletter",
              method: "POST",
              stage: "promo_lookup",
              code: promoError.code,
              extra: { faultsThisInstance: promoLookupFaultCount },
            }
          );
          return NextResponse.json({ error: UNAVAILABLE_MESSAGE }, { status: 503 });
        }

        if (promo) {
          if (isPromoCodeUsable(promo)) {
            usableCode = promo;
          } else if (promo.current_uses > 0) {
            // Already redeemed at least once — the one-time 10% code is not
            // renewable. Do NOT mint a replacement no matter how it's
            // otherwise unusable (expired, deactivated).
            redeemedCode = true;
          }
        }
      }

      if (usableCode) {
        // welcome_sent_at is only ever stamped after a CONFIRMED send (see
        // stampWelcomeSentAt). Inside the 7-day cooldown — or when we could
        // not read the column at all (cooldownStateUnknown) — say nothing new
        // happened and send nothing.
        if (withinWelcomeCooldown(existing.welcome_sent_at) || cooldownStateUnknown) {
          const exhausted = refuseIfMintQuotaExhausted();
          if (exhausted) return exhausted;
          // First-touch attribution: past this point the branch can only
          // return 200, so writing it here (rather than unconditionally at
          // the top of the handler) means it never races a still-possible
          // 503.
          if (source) await recordSourceAttribution(supabase, existing.id, source, airportCode, slug);
          return NextResponse.json({ success: true, message: SUCCESS_MESSAGE });
        }

        // No stamp and no cooldown: either the original send failed (Resend
        // returned an error, or threw) or 7 days have passed. Either way the
        // subscriber has a live, unused, unexpired code they may never have
        // actually received — resend it rather than dead-ending them with
        // "check your email" and nothing in the product able to redeliver it.
        //
        // This SENDS, so it is charged against the mint quota. Pass-5 review:
        // it was the one send path that never was, which is exactly the path
        // a permanently-failing welcome_sent_at write funnels every repeat
        // submission into.
        const limited = requireMintQuota();
        if (limited) return limited;

        if (source) await recordSourceAttribution(supabase, existing.id, source, airportCode, slug);

        const sent = await sendWelcomeEmail(emailLower, usableCode.code);
        if (sent) await stampWelcomeSentAt(supabase, existing.id);
        return NextResponse.json({
          success: true,
          message: sent ? SUCCESS_MESSAGE : SEND_TROUBLE_MESSAGE,
        });
      }

      if (
        redeemedCode ||
        withinWelcomeCooldown(existing.welcome_sent_at) ||
        cooldownStateUnknown
      ) {
        // Either the code on file has already been used (a fresh one would
        // make the discount infinitely renewable), or we emailed this
        // address within the last 7 days — or we cannot tell, which is
        // treated the same way rather than as permission to mint. Same body
        // as every other 200 — see the SUCCESS_MESSAGE comment above.
        const exhausted = refuseIfMintQuotaExhausted();
        if (exhausted) return exhausted;
        if (source) await recordSourceAttribution(supabase, existing.id, source, airportCode, slug);
        return NextResponse.json({ success: true, message: SUCCESS_MESSAGE });
      }

      // Never redeemed, but expired/inactive/absent — mint and send a fresh
      // one. Gated by the per-IP mint quota above and the cooldown check
      // just above, so this can't be pumped.
      const limited = requireMintQuota();
      if (limited) return limited;

      const minted = await mintPromoCode(supabase);
      if (!minted) {
        return NextResponse.json({ error: UNAVAILABLE_MESSAGE }, { status: 503 });
      }

      // welcome_sent_at is deliberately NOT set here — only stampWelcomeSentAt
      // (after a confirmed send, below) sets it.
      const { error: updateError } = await supabase
        .from("newsletter_subscribers")
        .update({ promo_code_id: minted.id })
        .eq("id", existing.id);

      if (updateError) {
        await bestEffortDeleteMintedCode(supabase, minted.id, "attach_promo_code");
        captureAPIError(
          new Error(`Failed to attach new promo code to subscriber ${existing.id}: ${updateError.message}`),
          {
            endpoint: "/api/newsletter",
            method: "POST",
            stage: "update_promo_code",
            code: updateError.code,
          }
        );
        return NextResponse.json({ error: UNAVAILABLE_MESSAGE }, { status: 503 });
      }

      // Past this point nothing in this branch can still 503.
      if (source) await recordSourceAttribution(supabase, existing.id, source, airportCode, slug);

      const sent = await sendWelcomeEmail(emailLower, minted.code);
      if (sent) await stampWelcomeSentAt(supabase, existing.id);
      return NextResponse.json({
        success: true,
        message: sent ? SUCCESS_MESSAGE : SEND_TROUBLE_MESSAGE,
      });
    }

    // New subscriber, or a previously-unsubscribed address coming back.
    const limited = requireMintQuota();
    if (limited) return limited;

    const minted = await mintPromoCode(supabase);
    if (!minted) {
      return NextResponse.json({ error: UNAVAILABLE_MESSAGE }, { status: 503 });
    }

    // welcome_sent_at is deliberately NOT set on insert/update — only
    // stampWelcomeSentAt (after a confirmed send, below) sets it.
    let subscriberId: string;

    if (existing) {
      const { error: resubError } = await supabase
        .from("newsletter_subscribers")
        .update({ unsubscribed_at: null, promo_code_id: minted.id })
        .eq("id", existing.id);

      if (resubError) {
        await bestEffortDeleteMintedCode(supabase, minted.id, "resubscribe");
        captureAPIError(
          new Error(`Failed to resubscribe ${existing.id}: ${resubError.message}`),
          {
            endpoint: "/api/newsletter",
            method: "POST",
            stage: "resubscribe",
            code: resubError.code,
          }
        );
        // Don't tell them they're resubscribed when unsubscribed_at is still
        // set on the row.
        return NextResponse.json({ error: UNAVAILABLE_MESSAGE }, { status: 503 });
      }
      subscriberId = existing.id;
    } else {
      const { data: inserted, error: subError } = await supabase
        .from("newsletter_subscribers")
        .insert({ email: emailLower, promo_code_id: minted.id })
        .select("id")
        .single();

      if (subError) {
        await bestEffortDeleteMintedCode(supabase, minted.id, "insert_subscriber");
        console.error("Error creating subscriber:", subError);
        captureAPIError(
          new Error(`Failed to create newsletter subscriber: ${subError.message}`),
          {
            endpoint: "/api/newsletter",
            method: "POST",
            stage: "insert_subscriber",
            code: subError.code,
          }
        );
        // 503 + the same copy as every other write failure on this route: a
        // 23505 race (or any transient insert fault) is retryable, and a
        // one-off 500 with its own string was the only inconsistent failure
        // shape the route had.
        return NextResponse.json({ error: UNAVAILABLE_MESSAGE }, { status: 503 });
      }

      subscriberId = inserted.id;
    }

    // First-touch attribution for BOTH branches above. Pass-5 review: this
    // used to live inside the insert branch only, so a returning subscriber
    // (unsubscribed_at set, coming back) silently recorded no source — the
    // exact comparison migration 024 exists to make. Past this point neither
    // branch can still 503, so a single call here cannot race a failure.
    if (source) {
      await recordSourceAttribution(supabase, subscriberId, source, airportCode, slug);
    }

    const sent = await sendWelcomeEmail(emailLower, minted.code);
    if (sent) await stampWelcomeSentAt(supabase, subscriberId);

    return NextResponse.json({
      success: true,
      message: sent ? SUCCESS_MESSAGE : SEND_TROUBLE_MESSAGE,
    });
  } catch (error) {
    console.error("Newsletter signup error:", error);
    captureAPIError(error instanceof Error ? error : new Error(String(error)), {
      endpoint: "/api/newsletter",
      method: "POST",
    });
    return NextResponse.json({ error: UNEXPECTED_MESSAGE }, { status: 500 });
  }
}
