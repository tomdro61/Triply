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
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background-color: #f87356; padding: 20px; text-align: center;">
            <h1 style="color: white; margin: 0;">New Contact Form Submission</h1>
          </div>
          <div style="padding: 30px; background-color: #f9fafb;">
            <p style="margin-bottom: 20px;"><strong>From:</strong> ${safeName} (${escapeHtml(email)})</p>
            <p style="margin-bottom: 20px;"><strong>Subject:</strong> ${safeSubject}</p>
            <div style="background-color: white; padding: 20px; border-radius: 8px; border: 1px solid #e5e7eb;">
              <p style="margin: 0; white-space: pre-wrap;">${safeMessage}</p>
            </div>
            <p style="margin-top: 20px; font-size: 14px; color: #6b7280;">
              Reply directly to this email to respond to ${safeName}.
            </p>
          </div>
          <div style="padding: 20px; text-align: center; background-color: #1a1a2e; color: #9ca3af; font-size: 12px;">
            <p style="margin: 0;">Triply - Your Trip Simplified</p>
            <p style="margin: 5px 0 0;">triplypro.com</p>
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
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <div style="background-color: #f87356; padding: 20px; text-align: center;">
              <h1 style="color: white; margin: 0;">Thanks for contacting us!</h1>
            </div>
            <div style="padding: 30px; background-color: #f9fafb;">
              <p>Hi ${safeName},</p>
              <p>We've received your message and will get back to you as soon as possible, typically within 24-48 hours.</p>
              <div style="background-color: white; padding: 20px; border-radius: 8px; border: 1px solid #e5e7eb; margin: 20px 0;">
                <p style="margin: 0 0 10px; font-weight: bold;">Your message:</p>
                <p style="margin: 0; color: #6b7280; white-space: pre-wrap;">${safeMessage}</p>
              </div>
              <p>In the meantime, you might find answers to common questions in our <a href="https://triplypro.com/help" style="color: #f87356;">FAQs</a>.</p>
              <p style="margin-top: 20px;">
                Best regards,<br>
                The Triply Team
              </p>
            </div>
            <div style="padding: 20px; text-align: center; background-color: #1a1a2e; color: #9ca3af; font-size: 12px;">
              <p style="margin: 0;">Triply - Your Trip Simplified</p>
              <p style="margin: 5px 0 0;">triplypro.com</p>
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
