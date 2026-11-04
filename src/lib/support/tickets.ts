import type { createAdminClient } from "@/lib/supabase/server";
import { postToDiscord, isDiscordWebhookUrl } from "@/lib/digest/discord";
import type { Embed } from "@/lib/digest/render";
import type { ContactSubject } from "@/lib/validation/schemas";
import type { BookingMatch, MatchedBooking, Priority, ReplyKind, TripPhase } from "./triage";

/**
 * The support inbox's server side: find the booking a submission is about,
 * store the ticket, alert the team on Discord when it's urgent.
 *
 * Everything here is behind ENABLE_SUPPORT_INBOX (see /api/contact) and never
 * throws into the request: the email to the team is the fallback for all of it.
 */

type Db = Awaited<ReturnType<typeof createAdminClient>>;

export function supportInboxEnabled(): boolean {
  return process.env.ENABLE_SUPPORT_INBOX === "true";
}

const BOOKING_COLS =
  "id, reslab_reservation_number, status, check_in, check_out, location_timezone, location_name, location_address, airport_code, customers!inner(email)";

interface BookingRow {
  id: string;
  reslab_reservation_number: string;
  status: string | null;
  check_in: string;
  check_out: string;
  location_timezone: string | null;
  location_name: string;
  location_address: string | null;
  airport_code: string | null;
  customers: { email: string | null } | Array<{ email: string | null }> | null;
}

export interface BookingLookup {
  match: BookingMatch;
  /** Set ONLY when match === "matched". */
  booking: MatchedBooking | null;
}

/**
 * The booking behind a reservation number — returned only when its customer
 * email equals `email` (case-insensitive). A different email gets
 * "email_mismatch" and NO booking, so nothing about it reaches the submitter.
 * `reservationNumber` is already normalised (upper-case [A-Z0-9-]), matched with
 * an equality so the UNIQUE index serves it. A stored number in another case
 * misses → "not_found", which reveals nothing.
 */
export async function lookupBooking(db: Db, reservationNumber: string | null, email: string): Promise<BookingLookup> {
  if (!reservationNumber) return { match: "none", booking: null };
  const { data, error } = await db
    .from("bookings")
    .select(BOOKING_COLS)
    .eq("reslab_reservation_number", reservationNumber)
    .limit(1)
    .maybeSingle<BookingRow>();
  if (error) throw new Error(`support booking lookup failed: ${error.message}`);
  if (!data) return { match: "not_found", booking: null };
  const c = Array.isArray(data.customers) ? data.customers[0] : data.customers;
  const owner = (c?.email ?? "").trim().toLowerCase();
  if (!owner || owner !== email.trim().toLowerCase()) return { match: "email_mismatch", booking: null };
  return {
    match: "matched",
    booking: {
      id: data.id,
      reservationNumber: data.reslab_reservation_number,
      status: data.status,
      checkIn: data.check_in,
      checkOut: data.check_out,
      timezone: data.location_timezone,
      locationName: data.location_name,
      locationAddress: data.location_address,
      airportCode: data.airport_code,
    },
  };
}

export interface NewTicket {
  name: string;
  email: string;
  subject: ContactSubject;
  message: string;
  reservationNumber: string | null;
  bookingMatch: BookingMatch;
  bookingId: string | null;
  priority: Priority;
  reasons: string[];
  replyKind: ReplyKind;
}

/** Inserts the ticket; returns its id + customer-facing number. Throws on a DB error. */
export async function insertTicket(db: Db, t: NewTicket): Promise<{ id: string; ticketNumber: number }> {
  const { data, error } = await db
    .from("support_tickets")
    .insert({
      name: t.name,
      email: t.email.trim(),
      subject: t.subject,
      message: t.message,
      reservation_number: t.reservationNumber,
      booking_id: t.bookingId,
      booking_match: t.bookingMatch,
      priority: t.priority,
      reasons: t.reasons,
      auto_reply_kind: t.replyKind,
    })
    .select("id, ticket_number")
    .single<{ id: string; ticket_number: number }>();
  if (error || !data) throw new Error(`support ticket insert failed: ${error?.message ?? "no row returned"}`);
  return { id: data.id, ticketNumber: Number(data.ticket_number) };
}

/** Best-effort bookkeeping after the emails/alert; a failure is returned, never thrown. */
export async function updateTicket(
  db: Db,
  id: string,
  patch: { auto_reply_sent?: boolean; alerted_at?: string }
): Promise<string | null> {
  const { error } = await db
    .from("support_tickets")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id);
  return error ? error.message : null;
}

const PHASE_TEXT: Record<TripPhase, string> = {
  future: "Trip is more than 24h away",
  within_24h: "Check-in within 24h",
  active: "Trip in progress",
  past: "Trip is over",
  unknown: "—",
};

/**
 * The Discord alert for an urgent ticket. Like the booking alert it leaves out
 * the customer's name, email and message — they're one click away in the admin.
 */
export function urgentTicketEmbed(t: {
  /** NULL when the ticket store failed — the alert still goes out. */
  ticketNumber: number | null;
  subject: ContactSubject;
  reasons: string[];
  reservationNumber: string | null;
  bookingMatch: BookingMatch;
  booking: MatchedBooking | null;
  tripPhase: TripPhase;
}): Embed {
  const clean = (s: string, max = 200) => s.replace(/\s+/g, " ").slice(0, max).replace(/([\\`*_~|>[\]()])/g, "\\$1");
  const fields: Embed["fields"] = [
    { name: "Subject", value: clean(t.subject), inline: true },
    { name: "Why urgent", value: clean(t.reasons.join(", ") || "—"), inline: true },
    { name: "Reservation", value: t.reservationNumber ? clean(t.reservationNumber, 40) : "—", inline: true },
  ];
  if (t.booking) {
    fields.push({ name: "Lot", value: clean(`${t.booking.locationName}${t.booking.airportCode ? ` (${t.booking.airportCode})` : ""}`) });
    fields.push({ name: "Trip", value: PHASE_TEXT[t.tripPhase], inline: true });
  } else if (t.bookingMatch !== "none") {
    const text =
      t.bookingMatch === "email_mismatch" ? "Under a different email" : t.bookingMatch === "lookup_failed" ? "Lookup failed" : "Not found";
    fields.push({ name: "Booking", value: text });
  }
  return {
    title:
      t.ticketNumber !== null
        ? `🚨 Urgent support ticket #${t.ticketNumber}`
        : "🚨 Urgent support request (NOT saved as a ticket — see the team email)",
    description: "[Open the support inbox](https://www.triplypro.com/admin/support)",
    color: 0xdc2626,
    fields,
    footer: { text: "Triply support · customer details are in the admin" },
  };
}

/**
 * Posts the urgent alert with an @here ping. Channel: DISCORD_SUPPORT_WEBHOOK_URL,
 * else the booking-alerts channel. Returns true only when Discord saved it.
 */
export async function alertUrgentTicket(embed: Embed): Promise<{ ok: boolean; error?: string }> {
  const url = (process.env.DISCORD_SUPPORT_WEBHOOK_URL || process.env.DISCORD_BOOKING_ALERTS_WEBHOOK_URL || "").trim();
  if (!url) return { ok: false, error: "no Discord webhook configured" };
  if (!isDiscordWebhookUrl(url)) return { ok: false, error: "support webhook is not a Discord webhook URL" };
  try {
    const res = await postToDiscord(url, embed, {
      remainingBudgetMs: 0, // the customer's request waits on this; the team email is the fallback
      username: "Triply Support",
      content: "@here urgent support ticket",
      allowedMentions: { parse: ["everyone"] },
      timeoutMs: 4_000,
      requireMessageId: true,
    });
    // Never echo Discord's body: it can quote the webhook URL.
    return res.kind === "posted" ? { ok: true } : { ok: false, error: `Discord post failed (status ${res.status ?? "none"})` };
  } catch {
    return { ok: false, error: "Discord post threw" };
  }
}
