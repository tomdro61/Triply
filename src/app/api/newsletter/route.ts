import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { resend, FROM_EMAIL } from "@/lib/resend/client";
import { z } from "zod";
import crypto from "crypto";
import { captureAPIError } from "@/lib/sentry";

const newsletterSchema = z.object({
  email: z.string().email("Invalid email address").max(254),
});

function generatePromoCode(): string {
  const suffix = crypto.randomBytes(3).toString("hex").toUpperCase();
  return `WELCOME-${suffix}`;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const result = newsletterSchema.safeParse(body);
    if (!result.success) {
      return NextResponse.json(
        { error: result.error.issues[0].message },
        { status: 400 }
      );
    }

    const { email } = result.data;
    const supabase = await createAdminClient();

    // Check if already subscribed
    const { data: existing } = await supabase
      .from("newsletter_subscribers")
      .select("id, unsubscribed_at")
      .eq("email", email.toLowerCase())
      .single();

    if (existing && !existing.unsubscribed_at) {
      return NextResponse.json({
        success: true,
        message: "You're already subscribed! Check your email for your promo code.",
      });
    }

    // Generate unique promo code
    const code = generatePromoCode();
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);

    // Save promo code
    const { data: promoCode, error: promoError } = await supabase
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

    if (promoError) {
      console.error("Error creating promo code:", promoError);
      return NextResponse.json(
        { error: "Failed to process subscription" },
        { status: 500 }
      );
    }

    // Save or update subscriber
    if (existing) {
      // Re-subscribing
      await supabase
        .from("newsletter_subscribers")
        .update({
          unsubscribed_at: null,
          promo_code_id: promoCode.id,
        })
        .eq("id", existing.id);
    } else {
      const { error: subError } = await supabase
        .from("newsletter_subscribers")
        .insert({
          email: email.toLowerCase(),
          promo_code_id: promoCode.id,
        });

      if (subError) {
        console.error("Error creating subscriber:", subError);
        return NextResponse.json(
          { error: "Failed to process subscription" },
          { status: 500 }
        );
      }
    }

    // Send welcome email with promo code
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
      // Don't fail the subscription if email fails
      console.error("Newsletter welcome email failed:", emailError);
    }

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
