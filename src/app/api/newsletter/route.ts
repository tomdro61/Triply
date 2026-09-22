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
  NEWSLETTER_RATE_LIMIT_WINDOW_SECONDS,
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
// /api/attribution — sampling, not suppression. `originRejectionCount` is a
// simple always-on counter alongside it: reportOnce only ever surfaces ONE
// Sentry event per class per warm instance, which would make an entire
// segment 403ing (e.g. a proxy stripping Origin) invisible otherwise.
const reported = new Set<string>();
let originRejectionCount = 0;
export function __resetNewsletterRouteTelemetryForTests(): void {
  reported.clear();
  originRejectionCount = 0;
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
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Measure the body that actually arrived: Content-Length is absent on a
  // chunked request, so a header check alone is bypassable.
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) {
    reportOnce("413_body", { length: text.length });
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
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

    const { data: existing, error: lookupError } = await supabase
      .from("newsletter_subscribers")
      .select("id, unsubscribed_at, promo_code_id, welcome_sent_at")
      .eq("email", emailLower)
      .single();

    // PGRST116 = no row = a genuinely new address. Anything else is a real
    // DB fault — silently treating it as "not found" would route a known
    // address into the insert branch below, hit the email UNIQUE constraint
    // (23505), and surface as an opaque 500 with an orphaned live promo code
    // already minted.
    if (lookupError && lookupError.code !== "PGRST116") {
      captureAPIError(
        new Error(`Newsletter subscriber lookup failed: ${lookupError.message}`),
        {
          endpoint: "/api/newsletter",
          method: "POST",
          stage: "lookup",
          code: lookupError.code,
        }
      );
      return NextResponse.json({ error: UNAVAILABLE_MESSAGE }, { status: 503 });
    }

    // The rate limit is charged only on the mint path (below), after
    // validation and the read-only lookups — a read-only "you're already
    // subscribed" response costs nothing and shouldn't burn an IP's budget.
    // Shared IPs (airport WiFi, CGNAT) can serve many distinct readers.
    function requireMintQuota(): NextResponse | null {
      if (checkNewsletterRateLimit(clientKey(request))) return null;
      reportOnce("429_rate_limited", {});
      return NextResponse.json(
        { error: "Too many requests" },
        {
          status: 429,
          headers: { "Retry-After": String(NEWSLETTER_RATE_LIMIT_WINDOW_SECONDS) },
        }
      );
    }

    // First-touch attribution, whatever branch below this takes.
    if (existing && source) {
      await recordSourceAttribution(supabase, existing.id, source, airportCode, slug);
    }

    if (existing && !existing.unsubscribed_at) {
      let usableCode: { current_uses: number } | null = null;
      let redeemedCode = false;

      if (existing.promo_code_id) {
        const { data: promo, error: promoError } = await supabase
          .from("promo_codes")
          .select("active, current_uses, max_uses, expires_at")
          .eq("id", existing.promo_code_id)
          .single();

        // Same rule as checkout: only PGRST116 (no row) is "no usable code".
        // A DB blip surfaced as any other error must never be read as
        // "unusable" — that would mint a duplicate live code + email.
        if (promoError && promoError.code !== "PGRST116") {
          captureAPIError(
            new Error(`Promo lookup failed for subscriber ${existing.id}: ${promoError.message}`),
            {
              endpoint: "/api/newsletter",
              method: "POST",
              stage: "promo_lookup",
              code: promoError.code,
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
        return NextResponse.json({
          success: true,
          alreadySubscribed: true,
          message: "You're already subscribed — check your email for your promo code.",
        });
      }

      if (redeemedCode || withinWelcomeCooldown(existing.welcome_sent_at)) {
        // Either the code on file has already been used (a fresh one would
        // make the discount infinitely renewable), or we emailed this
        // address within the last 7 days and won't mint/send again just
        // because they resubmitted the form.
        return NextResponse.json({
          success: true,
          alreadySubscribed: true,
          message: "You're already subscribed to Triply.",
        });
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

      const { error: updateError } = await supabase
        .from("newsletter_subscribers")
        .update({ promo_code_id: minted.id, welcome_sent_at: new Date().toISOString() })
        .eq("id", existing.id);

      if (updateError) {
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

      const sent = await sendWelcomeEmail(emailLower, minted.code);
      return NextResponse.json({
        success: true,
        alreadySubscribed: true,
        message: sent
          ? "You're already on the list — we've sent a fresh 10% code to your inbox."
          : "You're already subscribed, and we minted a fresh 10% code, but hit a snag emailing it. Please try again shortly.",
      });
    }

    // New subscriber, or a previously-unsubscribed address coming back.
    const limited = requireMintQuota();
    if (limited) return limited;

    const minted = await mintPromoCode(supabase);
    if (!minted) {
      return NextResponse.json({ error: UNAVAILABLE_MESSAGE }, { status: 503 });
    }

    const nowIso = new Date().toISOString();

    if (existing) {
      const { error: resubError } = await supabase
        .from("newsletter_subscribers")
        .update({ unsubscribed_at: null, promo_code_id: minted.id, welcome_sent_at: nowIso })
        .eq("id", existing.id);

      if (resubError) {
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
    } else {
      const { data: inserted, error: subError } = await supabase
        .from("newsletter_subscribers")
        .insert({ email: emailLower, promo_code_id: minted.id, welcome_sent_at: nowIso })
        .select("id")
        .single();

      if (subError) {
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
        return NextResponse.json(
          { error: "Failed to process subscription" },
          { status: 500 }
        );
      }

      if (source && inserted) {
        await recordSourceAttribution(supabase, inserted.id, source, airportCode, slug);
      }
    }

    const sent = await sendWelcomeEmail(emailLower, minted.code);

    return NextResponse.json({
      success: true,
      message: sent
        ? "Check your email for your 10% off code!"
        : "You're subscribed! We hit a snag sending your code by email — please try signing up again in a few minutes to get it resent.",
    });
  } catch (error) {
    console.error("Newsletter signup error:", error);
    captureAPIError(error instanceof Error ? error : new Error(String(error)), {
      endpoint: "/api/newsletter",
      method: "POST",
    });
    return NextResponse.json(
      { error: "An unexpected error occurred" },
      { status: 500 }
    );
  }
}
