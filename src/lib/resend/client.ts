import { Resend } from "resend";

if (!process.env.RESEND_API_KEY) {
  console.warn("Missing RESEND_API_KEY environment variable");
}

export const resend = new Resend(process.env.RESEND_API_KEY);

// Send from verified domain (triplypro.com)
// Falls back to Resend test sender for local development
export const FROM_EMAIL = process.env.RESEND_FROM_EMAIL || "Triply <bookings@triplypro.com>";
