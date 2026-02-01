import { NextRequest, NextResponse } from "next/server";
import { resend } from "@/lib/resend/client";

interface ContactFormData {
  name: string;
  email: string;
  subject: string;
  message: string;
}

export async function POST(request: NextRequest) {
  try {
    const body: ContactFormData = await request.json();
    const { name, email, subject, message } = body;

    // Validate required fields
    if (!name || !email || !subject || !message) {
      return NextResponse.json(
        { error: "All fields are required" },
        { status: 400 }
      );
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return NextResponse.json(
        { error: "Please enter a valid email address" },
        { status: 400 }
      );
    }

    // Send email to support team
    // Note: Using tom@triplypro.com for testing. After verifying domain in Resend,
    // change to support@triplypro.com and use a custom from address.
    const { data, error } = await resend.emails.send({
      from: "Triply Contact Form <onboarding@resend.dev>",
      to: ["tom@triplypro.com"],
      replyTo: email,
      subject: `[Contact Form] ${subject}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background-color: #f87356; padding: 20px; text-align: center;">
            <h1 style="color: white; margin: 0;">New Contact Form Submission</h1>
          </div>
          <div style="padding: 30px; background-color: #f9fafb;">
            <p style="margin-bottom: 20px;"><strong>From:</strong> ${name} (${email})</p>
            <p style="margin-bottom: 20px;"><strong>Subject:</strong> ${subject}</p>
            <div style="background-color: white; padding: 20px; border-radius: 8px; border: 1px solid #e5e7eb;">
              <p style="margin: 0; white-space: pre-wrap;">${message}</p>
            </div>
            <p style="margin-top: 20px; font-size: 14px; color: #6b7280;">
              Reply directly to this email to respond to ${name}.
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

    console.log("Contact form email sent:", data?.id);

    // Send confirmation email to user
    // Note: In test mode, this will only work for tom@triplypro.com
    // After verifying domain in Resend, this will work for all recipients
    try {
      await resend.emails.send({
        from: "Triply <onboarding@resend.dev>",
        to: [email],
        subject: "We received your message - Triply",
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <div style="background-color: #f87356; padding: 20px; text-align: center;">
              <h1 style="color: white; margin: 0;">Thanks for contacting us!</h1>
            </div>
            <div style="padding: 30px; background-color: #f9fafb;">
              <p>Hi ${name},</p>
              <p>We've received your message and will get back to you as soon as possible, typically within 24-48 hours.</p>
              <div style="background-color: white; padding: 20px; border-radius: 8px; border: 1px solid #e5e7eb; margin: 20px 0;">
                <p style="margin: 0 0 10px; font-weight: bold;">Your message:</p>
                <p style="margin: 0; color: #6b7280; white-space: pre-wrap;">${message}</p>
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
      console.log("Confirmation email sent to:", email);
    } catch (confirmError) {
      // Don't fail the request if confirmation email fails (common in test mode)
      console.log("Confirmation email skipped (test mode restriction):", email);
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Contact form error:", error);
    return NextResponse.json(
      { error: "An unexpected error occurred. Please try again." },
      { status: 500 }
    );
  }
}
