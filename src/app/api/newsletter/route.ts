/**
 * POST /api/newsletter
 *
 * Unauthenticated, visitor-facing: mints a live one-time 10% promo code per
 * new address, so it carries the same guards as /api/attribution —
 * same-origin only, a bounded per-IP limiter, a measured body cap, and one
 * Sentry event per rejection class. See src/lib/http/origin.ts and
 * src/lib/attribution/limiter.ts.
 */

import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { createAdminClient } from "@/lib/supabase/server";
import { resend, FROM_EMAIL } from "@/lib/resend/client";
import { z } from "zod";
import crypto from "crypto";
import { captureAPIError } from "@/lib/sentry";
import { isSameOrigin, clientKey } from "@/lib/http/origin";
import { checkNewsletterRateLimit } from "@/lib/attribution/limiter";
import { getAirportByCode } from "@/config/airports";

const MAX_BODY_BYTES = 2048;

const newsletterSchema = z.object({
  // .trim() FIRST: zod runs .email() before any transform, so a pasted address
  // with a trailing space was rejected outright.
  email: z.string().trim().email("Invalid email address").max(254),
  // Optional attribution. Sent by the end-of-article capture on the blog;
  // the homepage form sends none of it and behaves exactly as before.
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

// Once-per-instance telemetry for each rejection class, same pattern as
// /api/attribution — sampling, not suppression.
const reported = new Set<string>();
export function __resetNewsletterRouteTelemetryForTests(): void {
  reported.clear();
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
    return null;
  }
  return { id: data.id, code };
}

async function sendWelcomeEmail(email: string, code: string): Promise<void> {
  try {
    await resend.emails.send({
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
  } catch (emailError) {
    // Don't fail the subscription if email fails.
    console.error("Newsletter welcome email failed:", emailError);
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
      if (error.code === "42703") {
        // Expected transient: migration 024 not applied yet.
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
  }
}

export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) {
    reportOnce("403_origin", {
      secFetchSite: request.headers.get("sec-fetch-site"),
      origin: request.headers.get("origin"),
      host: request.headers.get("host"),
    });
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!checkNewsletterRateLimit(clientKey(request))) {
    reportOnce("429_rate_limited", {});
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
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

    const { data: existing } = await supabase
      .from("newsletter_subscribers")
      .select("id, unsubscribed_at, promo_code_id")
      .eq("email", emailLower)
      .single();

    // First-touch attribution, whatever branch below this takes.
    if (existing && source) {
      await recordSourceAttribution(supabase, existing.id, source, airportCode, slug);
    }

    if (existing && !existing.unsubscribed_at) {
      let hasUsableCode = false;
      if (existing.promo_code_id) {
        const { data: promo } = await supabase
          .from("promo_codes")
          .select("active, current_uses, max_uses, expires_at")
          .eq("id", existing.promo_code_id)
          .single();
        if (
          promo?.active &&
          promo.current_uses < promo.max_uses &&
          new Date(promo.expires_at) > new Date()
        ) {
          hasUsableCode = true;
        }
      }

      if (hasUsableCode) {
        return NextResponse.json({
          success: true,
          alreadySubscribed: true,
          message: "You're already subscribed — check your email for your promo code.",
        });
      }

      // No unexpired, unused code on file — mint and send a fresh one. Safe
      // to do per-request because this path is behind the per-IP limiter
      // above (checkNewsletterRateLimit, ~5/min).
      const minted = await mintPromoCode(supabase);
      if (minted) {
        await supabase
          .from("newsletter_subscribers")
          .update({ promo_code_id: minted.id })
          .eq("id", existing.id);
        await sendWelcomeEmail(emailLower, minted.code);
        return NextResponse.json({
          success: true,
          alreadySubscribed: true,
          message: "You're already on the list — we've sent a fresh 10% code to your inbox.",
        });
      }

      return NextResponse.json({
        success: true,
        alreadySubscribed: true,
        message: "You're already subscribed — check your email for your promo code.",
      });
    }

    // New subscriber, or a previously-unsubscribed address coming back.
    const minted = await mintPromoCode(supabase);
    if (!minted) {
      return NextResponse.json(
        { error: "Failed to process subscription" },
        { status: 500 }
      );
    }

    if (existing) {
      await supabase
        .from("newsletter_subscribers")
        .update({ unsubscribed_at: null, promo_code_id: minted.id })
        .eq("id", existing.id);
    } else {
      const { data: inserted, error: subError } = await supabase
        .from("newsletter_subscribers")
        .insert({ email: emailLower, promo_code_id: minted.id })
        .select("id")
        .single();

      if (subError) {
        console.error("Error creating subscriber:", subError);
        return NextResponse.json(
          { error: "Failed to process subscription" },
          { status: 500 }
        );
      }

      if (source && inserted) {
        await recordSourceAttribution(supabase, inserted.id, source, airportCode, slug);
      }
    }

    await sendWelcomeEmail(emailLower, minted.code);

    return NextResponse.json({
      success: true,
      message: "Check your email for your 10% off code!",
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
