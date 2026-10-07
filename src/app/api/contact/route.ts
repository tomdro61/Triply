import { NextRequest, NextResponse } from "next/server";
import { resend, FROM_EMAIL } from "@/lib/resend/client";
import { ADMIN_EMAILS } from "@/config/admin";
import { contactFormSchema, escapeHtml, CONTACT_HONEYPOT_FIELD } from "@/lib/validation/schemas";
import { captureAPIError, captureContactHoneypotDrop } from "@/lib/sentry";
import { clientKey } from "@/lib/http/origin";
import { checkContactRateLimit, CONTACT_RATE_LIMIT_WINDOW_SECONDS } from "@/lib/attribution/limiter";

/**
 * POST /api/contact — the /contact and /partners forms.
 *
 * Public, and it sends TWO emails per accepted request from our verified
 * Resend domain (one to the team, one to whatever address was typed), so it
 * carries three guards (PR #56 review):
 *   1. honeypot — a filled CONTACT_HONEYPOT_FIELD gets the same 200 a real
 *      submission gets, nothing is sent, and the drop is RECORDED (Sentry info
 *      event + console) so a lead eaten by a password manager's identity fill
 *      is never silently lost;
 *   2. a per-IP limit, charged only on a request that passed validation, so
 *      a person's typos never burn their own allowance;
 *   3. nothing caller-controlled is repeated in the confirmation email: the
 *      subject is an enum (contactFormSchema) and the greeting names nobody,
 *      so the email cannot carry a scammer's text to a victim's inbox.
 */
/** 429 — deliberately generic. */
function tooMany() {
  return NextResponse.json(
    { error: "Too many messages from this connection. Please try again in a few minutes." },
    {
      status: 429,
      headers: { "Retry-After": String(CONTACT_RATE_LIMIT_WINDOW_SECONDS), "Cache-Control": "no-store" },
    }
  );
}

export async function POST(request: NextRequest) {
  try {
    // A non-JSON body is caller error, not a crash: parse to undefined and
    // let Zod answer 400 instead of 500-ing (and paging Sentry) per bot post.
    const body: unknown = await request.json().catch(() => undefined);
    const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};

    const honeypot = record[CONTACT_HONEYPOT_FIELD];
    if (typeof honeypot === "string" && honeypot.trim() !== "") {
      // The trap counts against the same per-IP allowance a real submission
      // uses, so one source can push at most 5 drops per window through the
      // logs; past that it gets the ordinary 429 (which tells a bot nothing).
      if (!checkContactRateLimit(clientKey(request))) return tooMany();
      const email = typeof record.email === "string" ? record.email : "";
      const subject = typeof record.subject === "string" ? record.subject.slice(0, 60) : "";
      const context = { subject, emailDomain: (email.split("@")[1] ?? "").toLowerCase().slice(0, 100), ipKey: clientKey(request) };
      captureContactHoneypotDrop(context); // throttled per instance; console line kept short
      console.warn("[contact] honeypot drop", context.ipKey, context.emailDomain);
      return NextResponse.json({ success: true });
    }

    // Validate with Zod
    const result = contactFormSchema.safeParse(body);
    if (!result.success) {
      return NextResponse.json(
        { error: result.error.issues[0].message },
        { status: 400 }
      );
    }

    // Per-IP ceiling, charged only now that the request is a real, well-formed
    // submission (a person's 400s never burn their own allowance).
    if (!checkContactRateLimit(clientKey(request))) return tooMany();

    const { name, email, subject, message } = result.data;

    // Escape for HTML email templates
    const safeName = escapeHtml(name);
    const safeSubject = escapeHtml(subject);
    const safeMessage = escapeHtml(message);

    // Send email to support team
    const { error } = await resend.emails.send({
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

    // Confirmation to the sender. Deliberately contains NOTHING the caller
    // typed: the subject is one of CONTACT_SUBJECTS (enum-validated above) and
    // there is no name in the greeting. Resend resolves `{ error }` rather than
    // throwing, so the failure is read and logged; the request still succeeds
    // (the team copy went out) and the response says whether this one did.
    let confirmationSent = true;
    try {
      const { error: confirmationError } = await resend.emails.send({
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
              <p style="color: #374151; font-size: 15px; line-height: 1.6;">Hi there,</p>
              <p style="color: #374151; font-size: 15px; line-height: 1.6;">We've received your message (<strong>${safeSubject}</strong>) and will get back to you as soon as possible, typically within 24-48 hours.</p>
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
      if (confirmationError) {
        confirmationSent = false;
        console.warn("[contact] confirmation email not sent:", confirmationError.message, {
          emailDomain: email.split("@")[1]?.toLowerCase() ?? "",
        });
      }
    } catch (confirmationThrow) {
      confirmationSent = false;
      console.warn("[contact] confirmation email threw:", confirmationThrow);
    }

    return NextResponse.json({ success: true, confirmationSent });
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
