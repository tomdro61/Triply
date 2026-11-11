import { formatLiteralDateTime } from "@/lib/booking/literal-time";

/**
 * Saved replies for /admin/support — fixed, copy-paste messages the team
 * fills in and sends from their own mail app. No AI, nothing sent from here.
 *
 * Booking facts come from OUR database and only for a "matched" booking (the
 * booking's own email equals the ticket's), so a reply can't put one
 * customer's reservation in front of another. Anything we don't hold stays a
 * [bracketed blank] for the person sending to fill in or delete.
 */

/** The booking facts a reply may quote. Times are tz-less airport-local strings. */
export interface TemplateBooking {
  reservationNumber: string | null;
  locationName: string | null;
  airportCode: string | null;
  checkIn: string | null;
  checkOut: string | null;
}

export interface TemplateContext {
  ticketNumber: number;
  subject: string;
  /** As the customer typed it; only the first word is used. */
  customerName: string;
  /** Only a "matched" booking — never one under a different email. */
  booking: TemplateBooking | null;
}

export interface ReplyTemplate {
  id: string;
  label: string;
  body: (f: Fields) => string;
}

/** What the bodies read: every value already filled in or a [blank]. */
interface Fields {
  name: string;
  reservation: string;
  lot: string;
  checkIn: string;
  checkOut: string;
}

const SIGN_OFF = "Best regards,\nThe Triply Team\nsupport@triplypro.com";

/** "Maria" from "maria  garcia"; a blank when nothing usable was typed. */
export function greetingName(typed: string): string {
  const first = typed.trim().split(/\s+/)[0] ?? "";
  // Letters, apostrophes and hyphens only (O'Neil, Anne-Marie): anything else
  // was not a name, and a reply should not repeat it.
  if (!first || first.length > 40 || !/^[\p{L}'’-]+$/u.test(first)) return "there";
  return first.charAt(0).toUpperCase() + first.slice(1);
}

function fields(ctx: TemplateContext): Fields {
  const b = ctx.booking;
  // Each fact on its own: a booking missing one field still fills the rest.
  return {
    name: greetingName(ctx.customerName),
    reservation: b?.reservationNumber || "[reservation number]",
    lot: b?.locationName ? (b.airportCode ? `${b.locationName} (${b.airportCode})` : b.locationName) : "[parking lot]",
    checkIn: b?.checkIn ? formatLiteralDateTime(b.checkIn) : "[check-in date and time]",
    checkOut: b?.checkOut ? formatLiteralDateTime(b.checkOut) : "[check-out date and time]",
  };
}

export const REPLY_TEMPLATES: ReplyTemplate[] = [
  {
    id: "late_cancel",
    label: "Late cancellation (within 24 hours): ask for proof",
    body: (f) =>
      `Hi ${f.name},

Thanks for reaching out about reservation ${f.reservation} at ${f.lot} (check-in ${f.checkIn}).

Online cancellation closes 24 hours before check-in, so a cancellation inside that window isn't refunded automatically. We're happy to request an exception for you.

To give the request the best chance, please reply with anything that shows why you couldn't cancel sooner, for example:
- a cancelled or rescheduled flight (the airline's email or a screenshot)
- a medical or family emergency
- anything else that changed your plans at the last minute

We'll send in your request for an exception and let you know the answer by email.

${SIGN_OFF}`,
  },
  {
    id: "late_cancel_approved",
    label: "Late cancellation: refund approved",
    body: (f) =>
      `Hi ${f.name},

Good news: your refund request for reservation ${f.reservation} at ${f.lot} was approved.

We've refunded [amount] to your original payment method. It usually appears within 5-10 business days, depending on your bank.

${SIGN_OFF}`,
  },
  {
    id: "late_cancel_declined",
    label: "Late cancellation: not approved",
    body: (f) =>
      `Hi ${f.name},

Thanks for your patience while we looked into reservation ${f.reservation} at ${f.lot} (check-in ${f.checkIn}).

We asked for an exception, but this time it wasn't approved. Under our cancellation policy, refunds for cancellations within 24 hours of check-in are decided case by case: https://www.triplypro.com/terms#cancellation

We're sorry this isn't the answer you hoped for. If something else comes up, just reply to this email.

${SIGN_OFF}`,
  },
  {
    id: "refund_issued",
    label: "Refund issued",
    body: (f) =>
      `Hi ${f.name},

We've refunded [amount] for reservation ${f.reservation} to your original payment method. It usually appears within 5-10 business days, depending on your bank.

If you don't see it after that, reply to this email and we'll check on it.

${SIGN_OFF}`,
  },
  {
    id: "not_found",
    label: "Can't find the reservation",
    body: (f) =>
      `Hi ${f.name},

Thanks for reaching out. We couldn't find a reservation that matches the details you sent.

Could you reply with:
- the reservation number from your confirmation email
- the email address you used when you booked

As soon as we have those, we'll pull it up and help.

${SIGN_OFF}`,
  },
  {
    id: "change_dates",
    label: "Change dates or details",
    body: (f) =>
      `Hi ${f.name},

Thanks for reaching out about reservation ${f.reservation} at ${f.lot}.

There's no edit option yet, so a change means cancelling and booking again with the new details. A cancellation more than 24 hours before check-in is refunded to your original payment method (if you added a Park Guard protection plan, part of the plan price isn't refundable).

[Keep one of the next two lines and delete the other:]
[You can cancel it yourself at https://www.triplypro.com/reservations: sign in with the email you booked with (if you booked as a guest, add the reservation to your account there first), then book the new dates.]
[Reply to confirm and we'll cancel it for you, then you can book the new dates.]

If check-in is less than 24 hours away, reply with the new dates or details and we'll see what we can do.

${SIGN_OFF}`,
  },
  {
    id: "at_lot",
    label: "Problem at the lot",
    body: (f) =>
      `Hi ${f.name},

Sorry about the trouble at ${f.lot}. We're contacting the lot about reservation ${f.reservation} now.

[What we found out / what happens next]

If you're at the lot right now, reply to this email with anything new and we'll keep working on it.

${SIGN_OFF}`,
  },
  {
    id: "general",
    label: "General follow-up",
    body: (f) =>
      `Hi ${f.name},

Thanks for reaching out.

[Your answer]

If there's anything else, just reply to this email.

${SIGN_OFF}`,
  },
];

export function findTemplate(id: string): ReplyTemplate | undefined {
  return REPLY_TEMPLATES.find((t) => t.id === id);
}

export function renderTemplate(template: ReplyTemplate, ctx: TemplateContext): string {
  return template.body(fields(ctx));
}

export function replySubject(ticketNumber: number, subject: string): string {
  return `Re: Triply #${ticketNumber} - ${subject}`;
}

/**
 * Long mailto: links are cut off or refused by some mail apps. Above this the
 * page offers Copy only.
 */
export const MAILTO_MAX_LENGTH = 1900;

export function mailtoHref(email: string, subject: string, body?: string): string {
  const base = `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(subject)}`;
  return body ? `${base}&body=${encodeURIComponent(body)}` : base;
}
