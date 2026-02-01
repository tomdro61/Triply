import { Resend } from "resend";

if (!process.env.RESEND_API_KEY) {
  console.warn("Missing RESEND_API_KEY environment variable");
}

export const resend = new Resend(process.env.RESEND_API_KEY);

// Default from address - update after domain verification
// For testing, Resend allows sending from onboarding@resend.dev
export const FROM_EMAIL = process.env.RESEND_FROM_EMAIL || "Triply <onboarding@resend.dev>";
