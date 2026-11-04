import { escapeHtml, type ContactSubject } from "@/lib/validation/schemas";
import { formatLiteralDateTime } from "@/lib/booking/reconciliation-alert";
import { isCancelledStatus, type BookingMatch, type MatchedBooking, type Priority, type ReplyKind } from "./triage";

/**
 * The instant reply a /contact submitter gets, and the team's copy — fixed
 * templates, no AI.
 *
 * Safety rule carried over from the original confirmation email: the reply
 * repeats NOTHING the caller typed (no name, no message). The subject is an
 * enum; booking facts come from OUR database, and only when the booking's own
 * customer email equals the address the reply goes to (booking_match
 * "matched"), so the reply cannot hand one customer's booking to another or
 * carry a scammer's text to a victim.
 */

const SITE = "https://www.triplypro.com";
export const SUPPORT_EMAIL = "support@triplypro.com";
const MANAGE_URL = `${SITE}/reservations`;
const HELP_URL = `${SITE}/help`;
const ADMIN_SUPPORT_URL = `${SITE}/admin/support`;

const P = 'style="color: #374151; font-size: 15px; line-height: 1.6;"';
const A = 'style="color: #f87356; text-decoration: none; font-weight: 600;"';

function shell(heading: string, body: string): string {
  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
      <div style="background-color: #1A1A2E; padding: 32px 40px; text-align: center;">
        <h1 style="margin: 0; color: #f87356; font-size: 28px; font-weight: 700; letter-spacing: -0.5px;">Triply</h1>
        <p style="margin: 4px 0 0; color: #94a3b8; font-size: 13px;">Your Trip Simplified</p>
      </div>
      <div style="padding: 40px;">
        <h2 style="margin: 0 0 20px; color: #111827; font-size: 20px; font-weight: 700;">${heading}</h2>
        ${body}
      </div>
      <div style="background-color: #f9fafb; padding: 24px 40px; border-top: 1px solid #e5e7eb; text-align: center;">
        <p style="margin: 0; color: #9ca3af; font-size: 12px;">
          Triply - Airport Parking Made Easy<br>
          <a href="${SITE}" style="color: #f87356; text-decoration: none;">triplypro.com</a>
        </p>
      </div>
    </div>`;
}

function p(html: string): string {
  return `<p ${P}>${html}</p>`;
}

/** The booking as a small table. Every value is ours and escaped. */
export function bookingBlock(b: MatchedBooking): string {
  const rows: Array<[string, string]> = [
    ["Reservation", b.reservationNumber],
    ["Lot", b.airportCode ? `${b.locationName} (${b.airportCode})` : b.locationName],
  ];
  if (b.locationAddress) rows.push(["Address", b.locationAddress]);
  rows.push(["Check-in", formatLiteralDateTime(b.checkIn)], ["Check-out", formatLiteralDateTime(b.checkOut)]);
  if (b.status === "refunded") rows.push(["Status", "Cancelled and refunded"]);
  else if (isCancelledStatus(b.status)) rows.push(["Status", "Cancelled"]);
  const tr = rows
    .map(
      ([k, v]) =>
        `<tr><td style="padding: 6px 12px 6px 0; color: #6b7280; font-size: 14px; white-space: nowrap; vertical-align: top;">${k}</td><td style="padding: 6px 0; color: #111827; font-size: 14px; font-weight: 600;">${escapeHtml(v)}</td></tr>`
    )
    .join("");
  return `<table style="width: 100%; background-color: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px 16px; margin: 16px 0; border-collapse: separate;">${tr}</table>`;
}

const SIGN_OFF = `<p style="margin-top: 24px; color: #374151; font-size: 15px; line-height: 1.6;">Best regards,<br>The Triply Team</p>`;
const REPLY_HINT = p(`Just reply to this email to add anything — it goes straight to our team.`);
const ASK_FOR_NUMBER = p(
  `If this is about a reservation, reply with your reservation number (it's in your confirmation email) so we can pull it up right away.`
);

export interface AutoReplyInput {
  kind: ReplyKind;
  subject: ContactSubject;
  ticketNumber: number | null;
  /** Only a "matched" booking — never one whose email differs. */
  booking: MatchedBooking | null;
  /** Self-cancel is on and this booking passes the 24h gate now. */
  canSelfCancel: boolean;
}

export function renderAutoReply(input: AutoReplyInput): { subject: string; html: string } {
  const { kind, booking } = input;
  const ref = input.ticketNumber !== null ? ` (Triply #${input.ticketNumber})` : "";
  const safeSubject = escapeHtml(input.subject);
  const details = booking ? bookingBlock(booking) : "";
  let heading = "Thanks for contacting us!";
  let body: string;

  switch (kind) {
    case "self_cancel":
      heading = "You can cancel this yourself, right now";
      body =
        p(`Good news: this reservation can still be cancelled online, and you'll see exactly what's refunded before you confirm.`) +
        details +
        p(`<strong>1.</strong> Go to <a href="${MANAGE_URL}" ${A}>My Reservations</a><br><strong>2.</strong> Sign in (or create a free account) with this email address, and confirm the email if we ask<br><strong>3.</strong> If you see <strong>Add to my account</strong>, tap it so your booking shows up<br><strong>4.</strong> Tap <strong>Cancel</strong> on the reservation`) +
        p(`Online cancellation closes 24 hours before check-in. If anything goes wrong, reply to this email and we'll take care of it.`);
      break;
    case "already_cancelled":
      heading = "This reservation is already cancelled";
      body =
        p(`Our records show this reservation is already cancelled, so there's nothing more you need to do.`) +
        details +
        p(`Refunds go back to the card you paid with and can take 5–10 business days to show on your statement. If something doesn't look right, reply to this email.`);
      break;
    case "cancel_support":
      heading = "We're on your cancellation";
      body =
        (booking
          ? p(`Online cancellation closes 24 hours before check-in, so our team will handle this one for you personally. We've flagged it and will reply as soon as possible.`) + details
          : p(`Our team will handle this for you. We'll reply as soon as possible.`) +
            p(`If your check-in is more than 24 hours away, the fastest way is to cancel it yourself at <a href="${MANAGE_URL}" ${A}>My Reservations</a> (sign in with the email you booked with).`) +
            ASK_FOR_NUMBER) + REPLY_HINT;
      break;
    case "change":
      heading = "We'll help you change your reservation";
      body =
        p(`Our team makes date, time and vehicle changes for you. We've got your request and will reply with your options as soon as possible.`) +
        details +
        (input.canSelfCancel
          ? p(`In a hurry? You can also cancel this reservation yourself at <a href="${MANAGE_URL}" ${A}>My Reservations</a> and book your new dates — just note the price for new dates may be different.`)
          : "") +
        (booking ? "" : ASK_FOR_NUMBER) +
        REPLY_HINT;
      break;
    case "at_lot":
      heading = "We've alerted our team";
      body =
        p(`Your message has been flagged as urgent and our team has been alerted right now.`) +
        (booking
          ? p(`Here's your reservation — show the reservation number to the lot attendant or shuttle driver:`) + details
          : ASK_FOR_NUMBER) +
        p(`If you can, reply with a phone number we can reach you on.`);
      break;
    case "booking_details":
      body =
        p(`We've received your message (<strong>${safeSubject}</strong>) and will get back to you as soon as possible. Here's your reservation in the meantime:`) +
        details +
        p(`You can view or manage it any time at <a href="${MANAGE_URL}" ${A}>My Reservations</a>.`);
      break;
    case "payment":
      heading = "We're looking into your payment";
      body =
        p(`We've flagged your message for the team member who handles payments and will reply as soon as possible.`) +
        details +
        (booking ? "" : ASK_FOR_NUMBER) +
        REPLY_HINT;
      break;
    case "partner":
    case "generic":
    default:
      body =
        p(`Hi there,`) +
        p(`We've received your message (<strong>${safeSubject}</strong>) and will get back to you as soon as possible, typically within 24-48 hours.`) +
        (kind === "generic" ? ASK_FOR_NUMBER : "") +
        p(`In the meantime, you might find answers to common questions in our <a href="${HELP_URL}" style="color: #f87356; text-decoration: none;">FAQs</a>.`);
  }

  return { subject: `We received your message${ref} - Triply`, html: shell(heading, body + SIGN_OFF) };
}

export interface TeamEmailInput {
  ticketNumber: number | null;
  name: string;
  email: string;
  subject: ContactSubject;
  message: string;
  reservationNumber: string | null;
  bookingMatch: BookingMatch;
  booking: MatchedBooking | null;
  priority: Priority;
  reasons: string[];
  replyKind: ReplyKind;
}

const MATCH_TEXT: Record<BookingMatch, string> = {
  matched: "Booking found and the email matches",
  email_mismatch: "⚠️ Reservation exists but is under a DIFFERENT email — verify the person before sharing anything",
  not_found: "⚠️ No booking with that reservation number",
  lookup_failed: "⚠️ Booking lookup FAILED (database error) — look the number up by hand",
  none: "No reservation number given",
};

const REPLY_TEXT: Record<ReplyKind, string> = {
  self_cancel: "told them how to cancel it themselves",
  already_cancelled: "told them it's already cancelled",
  cancel_support: "told them we'll cancel it for them",
  change: "told them we'll reply with change options",
  at_lot: "told them the team is alerted (sent lot facts if matched)",
  booking_details: "sent their booking details",
  payment: "told them payments is looking into it",
  partner: "standard acknowledgement",
  generic: "standard acknowledgement",
};

export function renderTeamEmail(t: TeamEmailInput): { subject: string; html: string } {
  const tag = t.priority === "urgent" ? "[URGENT] " : t.priority === "high" ? "[HIGH] " : "";
  const num = t.ticketNumber !== null ? `#${t.ticketNumber} ` : "";
  const color = t.priority === "urgent" ? "#dc2626" : t.priority === "high" ? "#d97706" : "#6b7280";
  const line = (k: string, v: string) =>
    `<p style="margin: 0 0 8px; color: #374151; font-size: 15px;"><strong>${k}:</strong> ${v}</p>`;
  const body =
    `<p style="margin: 0 0 16px; color: ${color}; font-size: 14px; font-weight: 700; text-transform: uppercase;">${escapeHtml(t.priority)}${t.reasons.length ? ` — ${escapeHtml(t.reasons.join(", "))}` : ""}</p>` +
    line("From", `${escapeHtml(t.name)} (${escapeHtml(t.email)})`) +
    line("Subject", escapeHtml(t.subject)) +
    line("Reservation", t.reservationNumber ? escapeHtml(t.reservationNumber) : "—") +
    line("Booking", escapeHtml(MATCH_TEXT[t.bookingMatch])) +
    (t.booking ? bookingBlock(t.booking) : "") +
    line("Auto-reply", escapeHtml(REPLY_TEXT[t.replyKind])) +
    `<div style="background-color: #f9fafb; padding: 20px; border-radius: 8px; border: 1px solid #e5e7eb; margin-top: 16px;"><p style="margin: 0; white-space: pre-wrap; color: #374151; font-size: 14px; line-height: 1.6;">${escapeHtml(t.message)}</p></div>` +
    `<p style="margin-top: 20px; font-size: 13px; color: #9ca3af; line-height: 1.5;">Reply directly to this email to respond to ${escapeHtml(t.name)}, then mark it replied in <a href="${ADMIN_SUPPORT_URL}" style="color: #f87356;">the support inbox</a>.</p>`;
  return {
    subject: `[Contact Form] ${tag}${num}${t.subject}`,
    html: shell("New Contact Form Submission", body),
  };
}
