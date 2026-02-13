import { NextRequest, NextResponse } from "next/server";
import { resend, FROM_EMAIL } from "@/lib/resend/client";
import { ADMIN_EMAILS } from "@/config/admin";
import { contactFormSchema, escapeHtml } from "@/lib/validation/schemas";
import { captureAPIError } from "@/lib/sentry";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    // Validate with Zod
    const result = contactFormSchema.safeParse(body);
    if (!result.success) {
      return NextResponse.json(
        { error: result.error.issues[0].message },
        { status: 400 }
      );
    }

    const { name, email, subject, message } = result.data;

    // Escape for HTML email templates
    const safeName = escapeHtml(name);
    const safeSubject = escapeHtml(subject);
    const safeMessage = escapeHtml(message);

    // Send email to support team
    const { data, error } = await resend.emails.send({
      from: FROM_EMAIL,
      to: ADMIN_EMAILS,
      replyTo: email,
      subject: `[Contact Form] ${subject}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
          <div style="background-color: #1A1A2E; padding: 32px 40px; text-align: center;">
            <h1 style="margin: 0; color: #f87356; font-size: 28px; font-weight: 700; letter-spacing: -0.5px;">Triply</h1>
            <p style="margin: 4px 0 0; color: #94a3b8; font-size: 13px;">Your Trip Simplified</p>
          </div>
          <div style="padding: 40px;">
            <h2 style="margin: 0 0 20px; color: #111827; font-size: 20px; font-weight: 700;">New Contact Form Submission</h2>
            <p style="margin-bottom: 16px; color: #374151; font-size: 15px;"><strong>From:</strong> ${safeName} (${escapeHtml(email)})</p>
            <p style="margin-bottom: 16px; color: #374151; font-size: 15px;"><strong>Subject:</strong> ${safeSubject}</p>
            <div style="background-color: #f9fafb; padding: 20px; border-radius: 8px; border: 1px solid #e5e7eb;">
              <p style="margin: 0; white-space: pre-wrap; color: #374151; font-size: 14px; line-height: 1.6;">${safeMessage}</p>
            </div>
            <p style="margin-top: 20px; font-size: 13px; color: #9ca3af; line-height: 1.5;">
              Reply directly to this email to respond to ${safeName}.
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
      console.error("Failed to send contact email:", error);
      return NextResponse.json(
        { error: "Failed to send message. Please try again." },
        { status: 500 }
      );
    }

    // Send confirmation email to user
    try {
      await resend.emails.send({
        from: FROM_EMAIL,
        to: [email],
        subject: "We received your message - Triply",
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
            <div style="background-color: #1A1A2E; padding: 32px 40px; text-align: center;">
              <h1 style="margin: 0; color: #f87356; font-size: 28px; font-weight: 700; letter-spacing: -0.5px;">Triply</h1>
              <p style="margin: 4px 0 0; color: #94a3b8; font-size: 13px;">Your Trip Simplified</p>
            </div>
            <div style="padding: 40px;">
              <h2 style="margin: 0 0 20px; color: #111827; font-size: 20px; font-weight: 700;">Thanks for contacting us!</h2>
              <p style="color: #374151; font-size: 15px; line-height: 1.6;">Hi ${safeName},</p>
              <p style="color: #374151; font-size: 15px; line-height: 1.6;">We've received your message and will get back to you as soon as possible, typically within 24-48 hours.</p>
              <div style="background-color: #f9fafb; padding: 20px; border-radius: 8px; border: 1px solid #e5e7eb; margin: 20px 0;">
                <p style="margin: 0 0 10px; font-weight: bold; color: #374151; font-size: 14px;">Your message:</p>
                <p style="margin: 0; color: #6b7280; white-space: pre-wrap; font-size: 14px; line-height: 1.6;">${safeMessage}</p>
              </div>
              <p style="color: #374151; font-size: 15px; line-height: 1.6;">In the meantime, you might find answers to common questions in our <a href="https://www.triplypro.com/help" style="color: #f87356; text-decoration: none;">FAQs</a>.</p>
              <p style="margin-top: 24px; color: #374151; font-size: 15px; line-height: 1.6;">
                Best regards,<br>
                The Triply Team
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
    } catch {
      // Don't fail the request if confirmation email fails (common in test mode)
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Contact form error:", error);
    captureAPIError(error instanceof Error ? error : new Error(String(error)), {
      endpoint: "/api/contact",
      method: "POST",
    });
    return NextResponse.json(
      { error: "An unexpected error occurred. Please try again." },
      { status: 500 }
    );
  }
}
