import type { createAdminClient } from "@/lib/supabase/server";
import { postToDiscord, isDiscordWebhookUrl } from "@/lib/digest/discord";
import type { Embed } from "@/lib/digest/render";
import type { ContactSubject } from "@/lib/validation/schemas";
import type { BookingMatch, MatchedBooking, Priority, ReplyKind, TripPhase } from "./triage";
import { stripeKeyMode } from "@/lib/cancellation/source-guard";

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

/**
 * Staging and production share one database: a ticket records which one made
 * it (by the deployment's Stripe mode, as bookings do since PR #88), the inbox
 * lists only its own, and a test ticket never pings @here. Unknown mode counts
 * as live, so a misconfigured key can't hide a real customer's ticket.
 */
export function supportLivemode(): boolean {
  return stripeKeyMode() !== "test";
}

// Every database call here is bounded: the team email is the fallback for all
// of it, and it must never sit behind a hung read until the function is killed.
const DB_TIMEOUT_MS = 3_000;
const dbDeadline = () => AbortSignal.timeout(DB_TIMEOUT_MS);

/** The ticket columns the admin inbox reads (list, and the 409 answer). */
export const TICKET_COLUMNS =
  "id, ticket_number, name, email, subject, message, reservation_number, booking_id, booking_match, priority, reasons, auto_reply_kind, auto_reply_sent, alerted_at, status, assigned_to, first_response_at, resolved_at, notes, created_at, updated_at";

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
    .abortSignal(dbDeadline())
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
  livemode: boolean;
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
      livemode: t.livemode,
    })
    .select("id, ticket_number")
    .abortSignal(dbDeadline())
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
    .eq("id", id)
    .abortSignal(dbDeadline());
  return error ? error.message : null;
}

// At most this many @here pings per window: anyone can submit the form
// without signing in, so "Problem at the Lot" or a strong word must not let a
// script page the team without limit. Past the cap the alert still posts,
// just without the ping.
const PING_WINDOW_MS = 10 * 60_000;
const PING_CAP = 3;

/**
 * Whether this urgent ticket may @here: only the first PING_CAP live urgent
 * tickets in the window do, ranked by ticket number. The rows are inserted
 * before any alert runs, so submissions arriving together see each other —
 * counting alerts already SENT (round-2 review) let a burst all ping.
 * No stored ticket, or a failed count: ping — a real emergency beats a quiet
 * channel.
 */
export async function mayPing(db: Db | null, ticketNumber: number | null): Promise<boolean> {
  if (!db || ticketNumber === null) return true;
  const since = new Date(Date.now() - PING_WINDOW_MS).toISOString();
  const { count, error } = await db
    .from("support_tickets")
    .select("id", { count: "exact", head: true })
    .eq("livemode", true)
    .eq("priority", "urgent")
    .gte("created_at", since)
    .lte("ticket_number", ticketNumber)
    .abortSignal(dbDeadline());
  if (error || count == null) return true;
  return count <= PING_CAP;
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
export async function alertUrgentTicket(
  embed: Embed,
  opts: { livemode: boolean; ping: boolean } = { livemode: true, ping: true }
): Promise<{ ok: boolean; error?: string }> {
  const url = (process.env.DISCORD_SUPPORT_WEBHOOK_URL || process.env.DISCORD_BOOKING_ALERTS_WEBHOOK_URL || "").trim();
  if (!url) return { ok: false, error: "no Discord webhook configured" };
  if (!isDiscordWebhookUrl(url)) return { ok: false, error: "support webhook is not a Discord webhook URL" };
  // A staging test never pings, and is marked as a test.
  const ping = opts.livemode && opts.ping;
  const titled: Embed = opts.livemode ? embed : { ...embed, title: `[TEST] ${embed.title}` };
  try {
    const res = await postToDiscord(url, titled, {
      remainingBudgetMs: 0, // runs after the response (after()); the team email is the fallback
      username: "Triply Support",
      content: ping ? "@here urgent support ticket" : opts.livemode ? "Urgent support ticket (ping limit reached)" : "Test support ticket",
      allowedMentions: { parse: ping ? ["everyone"] : [] },
      timeoutMs: 4_000,
      requireMessageId: true,
    });
    // Never echo Discord's body: it can quote the webhook URL.
    return res.kind === "posted" ? { ok: true } : { ok: false, error: `Discord post failed (status ${res.status ?? "none"})` };
  } catch {
    return { ok: false, error: "Discord post threw" };
  }
}

/**
 * A plain (no @here) note when the team email failed but the ticket is
 * stored: otherwise the only trace is the inbox and one Sentry issue that
 * repeats silently (e.g. once Resend's daily cap is reached).
 */
export async function noticeTeamEmailFailed(ticketNumber: number, livemode: boolean): Promise<{ ok: boolean; error?: string }> {
  const url = (process.env.DISCORD_SUPPORT_WEBHOOK_URL || process.env.DISCORD_BOOKING_ALERTS_WEBHOOK_URL || "").trim();
  if (!url) return { ok: false, error: "no Discord webhook configured" };
  if (!isDiscordWebhookUrl(url)) return { ok: false, error: "support webhook is not a Discord webhook URL" };
  try {
    const res = await postToDiscord(
      url,
      {
        title: `${livemode ? "" : "[TEST] "}Support ticket #${ticketNumber}: the team email failed or is unconfirmed`,
        description: "The ticket is stored; the email may not have reached you. [Open the support inbox](https://www.triplypro.com/admin/support)",
        color: 0xd97706,
        fields: [],
        footer: { text: "Triply support" },
      },
      { remainingBudgetMs: 0, username: "Triply Support", allowedMentions: { parse: [] }, timeoutMs: 4_000, requireMessageId: true }
    );
    return res.kind === "posted" ? { ok: true } : { ok: false, error: `Discord post failed (status ${res.status ?? "none"})` };
  } catch {
    return { ok: false, error: "Discord post threw" };
  }
}
