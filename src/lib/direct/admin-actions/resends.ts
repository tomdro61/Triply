import { resend, FROM_EMAIL } from "@/lib/resend/client";
import { escapeHtml } from "@/lib/validation/schemas";
import { captureAPIError } from "@/lib/sentry";
import { convertTo12Hour } from "@/lib/utils/time";
import { formatDate } from "@/lib/utils";
import { bounded, BoundedTimeoutError } from "@/lib/utils/bounded";
import { resolveLotRecipients } from "@/lib/direct/lot-notice";
import { OTHER_MODE_MESSAGE } from "@/lib/cancellation/source-guard";
import {
  cancelReminderRefusal,
  customerResendRefusal,
  dbSignal,
  refuse,
  type ActionRefusal,
  type AdminClient,
  type DirectBookingRow,
} from "./booking";

/**
 * Admin re-sends (6b plan §6): "Re-send lot cancellation" (a reminder of a
 * cancellation the lot was already sent) and "Re-send customer confirmation".
 *
 * Each is claimed and audited as a `direct_lot_resends` row — source
 * `admin:{n}`, n = 1 + the re-sends of that kind this booking already has.
 * The UNIQUE (booking, kind, source) only stops two requests that race on the
 * SAME n (two admins at once): the loser's INSERT is a 23505 → 409. A
 * double-click is stopped by the panel's busy-disabled buttons, not by this.
 * Any later re-send is n+1 — a NEW email under its own Resend key, never
 * swallowed as a duplicate of the first. These never touch a bookings claim
 * or stamp column: the 4b-2 notice machinery is not involved.
 */

const ENDPOINT = "/api/admin/direct-bookings/action";
const SEND_TIMEOUT_MS = 5_000;

export type ResendKind = "lot_cancel_reminder" | "customer_confirmation";
export type ResendOutcome = "sent" | "failed" | "unknown";

export interface ResendResult {
  ok: true;
  outcome: ResendOutcome;
  /** Which re-send of this kind this was (1 = the first admin re-send). */
  n: number;
  recipients: string[];
  test: boolean;
}

const reportStage = (stage: string, message: string) =>
  captureAPIError(new Error(message), { endpoint: ENDPOINT, method: "POST", stage });

/** Claim the audit row. `n` from the rows already there; a race on the same n is the UNIQUE's 23505. */
async function claimResend(
  supabase: AdminClient,
  booking: DirectBookingRow,
  kind: ResendKind,
  livemode: boolean,
  sentBy: string,
  recipients: string[]
): Promise<{ ok: true; id: string; n: number } | ActionRefusal> {
  const { count, error: countError } = await supabase
    .from("direct_lot_resends")
    .select("id", { count: "exact", head: true })
    .eq("booking_id", booking.id)
    .eq("kind", kind)
    .abortSignal(dbSignal());
  if (countError || typeof count !== "number") return refuse(503, "Couldn't read this booking's re-send history — try again.");
  const n = count + 1;
  const { data, error } = await supabase
    .from("direct_lot_resends")
    .insert({
      booking_id: booking.id,
      stripe_payment_intent_id: booking.stripe_payment_intent_id,
      livemode,
      kind,
      source: `admin:${n}`,
      attempts: 1,
      sent_by: sentBy,
      recipients,
      outcome: "sending",
    })
    .select("id")
    .abortSignal(dbSignal())
    .maybeSingle();
  if (error) {
    if (error.code === "23505") return refuse(409, "Another re-send of this just started — refresh before trying again.");
    return refuse(503, "Couldn't record the re-send — nothing was sent. Try again.");
  }
  const id = (data as { id?: unknown } | null)?.id;
  if (typeof id !== "string") return refuse(503, "Couldn't record the re-send — nothing was sent. Try again.");
  return { ok: true, id, n };
}

/** Write the outcome back. Best effort: the email already went (or didn't); a lost audit write is a Sentry event. */
async function recordResend(
  supabase: AdminClient,
  id: string,
  number: string,
  fields: { outcome: ResendOutcome; email_id: string | null; recipients: string[]; last_error: string | null }
): Promise<void> {
  try {
    const { error } = await supabase.from("direct_lot_resends").update(fields).eq("id", id).abortSignal(dbSignal());
    if (error) reportStage("resend_record", `re-send outcome (${fields.outcome}) for ${number} not recorded: ${error.message}`);
  } catch (err) {
    reportStage("resend_record", `re-send outcome (${fields.outcome}) for ${number} not recorded: ${err instanceof Error ? err.message : String(err)}`);
  }
}

type ResendSendReply = Awaited<ReturnType<typeof resend.emails.send>>;

/**
 * Classify a Resend reply the way lot-notice.ts's claimAndSend does: no
 * readable status, a 5xx, `application_error` / `internal_server_error` /
 * `concurrent_idempotent_requests` = UNKNOWN (it may have been delivered);
 * `invalid_idempotent_request` = an earlier request under this key was
 * accepted = sent; anything else = a definite failure.
 */
export function classifyResendReply(reply: ResendSendReply): { outcome: ResendOutcome; emailId: string | null; error: string | null } {
  const { data, error } = reply;
  if (!error) return { outcome: "sent", emailId: data?.id ?? null, error: null };
  if (error.name === "invalid_idempotent_request") return { outcome: "sent", emailId: null, error: null };
  const unknown =
    error.name === "application_error" ||
    error.name === "internal_server_error" ||
    error.name === "concurrent_idempotent_requests" ||
    error.statusCode == null ||
    error.statusCode >= 500;
  return { outcome: unknown ? "unknown" : "failed", emailId: null, error: `${error.name}: ${error.message}` };
}

// --- Re-send lot cancellation ------------------------------------------------------------------------

const fmtWhen = (wallClock: string) => {
  const [date, time] = wallClock.split(" ");
  return `${formatDate(date)} at ${convertTo12Hour(time)}`;
};

/**
 * The 4b-2 cancel notice (lot-notice.ts cancelNoticeEmail): same subject and
 * fields, plus one "re-sent" line. Keep the wording in step with that one and
 * with manifest/render.ts renderFollowUpCancel.
 */
export function lotCancelReminderEmail(
  c: { number: string; lotName: string; customerName: string; fromDate: string; toDate: string; vehicleLine: string },
  test: boolean
): { subject: string; html: string; text: string } {
  const rows: Array<[string, string]> = [
    ["Confirmation", c.number],
    ["Customer", c.customerName],
    ["Was due", `${fmtWhen(c.fromDate)} → ${fmtWhen(c.toDate)}`],
    ["Vehicle", c.vehicleLine],
  ];
  const subject = `${test ? "[TEST] " : ""}CANCELLED — Triply booking ${c.number}`;
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px;">
      ${test ? `<p style="background:#fef3c7;padding:8px 12px;border-radius:6px;color:#92400e;"><strong>TEST booking</strong> — not a real customer.</p>` : ""}
      <h2 style="margin:0 0 12px;">Booking cancelled at ${escapeHtml(c.lotName)}</h2>
      <p>Please do not expect this customer. The reservation below is no longer valid.</p>
      <p style="color:#64748b;font-size:12px;">Re-sent as a reminder — we emailed you this cancellation before.</p>
      <table style="border-collapse:collapse;width:100%;">
        ${rows
          .map(
            ([k, val]) =>
              `<tr><td style="padding:6px 8px;color:#64748b;border-bottom:1px solid #e5e7eb;">${escapeHtml(k)}</td><td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;font-weight:600;">${escapeHtml(val)}</td></tr>`
          )
          .join("")}
      </table>
    </div>`;
  const text = `${subject}\n\nRe-sent as a reminder — we emailed you this cancellation before.\n\n${rows.map(([k, val]) => `${k}: ${val}`).join("\n")}`;
  return { subject, html, text };
}

/** The guest the booking notice named: the staged payload's customer, else the customers row. */
async function guestName(supabase: AdminClient, booking: DirectBookingRow): Promise<string> {
  const { data: staged, error: stagedError } = await supabase
    .from("pending_bookings")
    .select("customer")
    .eq("stripe_payment_intent_id", booking.stripe_payment_intent_id)
    .abortSignal(dbSignal())
    .maybeSingle();
  if (stagedError) throw new Error(`guest read failed: ${stagedError.message}`);
  const guest = (staged as { customer?: { firstName?: string; lastName?: string } | null } | null)?.customer;
  let name = `${guest?.firstName ?? ""} ${guest?.lastName ?? ""}`.trim();
  if (!name && booking.customer_id) {
    const { data: cust, error: custError } = await supabase
      .from("customers")
      .select("first_name, last_name")
      .eq("id", booking.customer_id)
      .abortSignal(dbSignal())
      .maybeSingle();
    if (custError) throw new Error(`customer read failed: ${custError.message}`);
    const c = cust as { first_name?: string; last_name?: string } | null;
    name = `${c?.first_name ?? ""} ${c?.last_name ?? ""}`.trim();
  }
  return name || "(see admin)";
}

export async function resendLotCancellation(
  supabase: AdminClient,
  booking: DirectBookingRow,
  sentBy: string
): Promise<ResendResult | ActionRefusal> {
  const pre = cancelReminderRefusal(booking);
  if (pre) return pre;

  const { data: termsData, error: termsError } = await supabase
    .from("direct_booking_terms")
    .select("livemode, lot_recipients")
    .eq("stripe_payment_intent_id", booking.stripe_payment_intent_id)
    .abortSignal(dbSignal())
    .maybeSingle();
  if (termsError) return refuse(503, "Couldn't read this booking's lot inbox — try again.");
  if (!termsData) return refuse(500, "This booking has no lot terms on file — handle it by hand.");
  const terms = termsData as { livemode: boolean; lot_recipients: string[] | null };
  if (typeof terms.livemode !== "boolean" || !Array.isArray(terms.lot_recipients)) {
    return refuse(500, "This booking's lot terms are unreadable — handle it by hand.");
  }
  // The SAME inbox the cancellation went to (the booking's snapshot), never today's CMS value.
  const recipients = resolveLotRecipients(terms.livemode, terms.lot_recipients);
  if (!recipients || recipients.to.length === 0) {
    return refuse(503, "No test inbox is configured here (DIRECT_LOT_NOTICE_OVERRIDE_TO) — a non-production re-send can't go out.");
  }

  // Everything the email says, read BEFORE the claim: a read failure burns no audit row.
  let customerName: string;
  try {
    customerName = await guestName(supabase, booking);
  } catch {
    return refuse(503, "Couldn't read the booking's guest details — try again.");
  }
  const v = booking.vehicle_info ?? {};
  const email = lotCancelReminderEmail(
    {
      number: booking.reslab_reservation_number,
      lotName: booking.location_name ?? "",
      customerName,
      // TIMESTAMP columns come back "YYYY-MM-DDTHH:MM:SS" — literal lot-local wall clock, never a UTC instant.
      fromDate: booking.check_in.replace("T", " ").slice(0, 19),
      toDate: booking.check_out.replace("T", " ").slice(0, 19),
      vehicleLine: [v.color, v.make, v.model].filter(Boolean).join(" ") + (v.licensePlate ? ` — plate ${v.licensePlate}` : ""),
    },
    recipients.test
  );

  const claimed = await claimResend(supabase, booking, "lot_cancel_reminder", terms.livemode, sentBy, recipients.to);
  if (!claimed.ok) return claimed;

  let classified: ReturnType<typeof classifyResendReply>;
  try {
    const reply = await bounded(
      resend.emails.send(
        { from: FROM_EMAIL, to: recipients.to, subject: email.subject, html: email.html, text: email.text },
        { idempotencyKey: `direct-lot-reminder/${booking.id}/lot_cancel_reminder/${claimed.n}` }
      ),
      SEND_TIMEOUT_MS,
      "Resend"
    );
    classified = classifyResendReply(reply);
  } catch (err) {
    classified = {
      outcome: err instanceof BoundedTimeoutError ? "unknown" : "failed",
      emailId: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  if (classified.outcome !== "sent") {
    reportStage(
      "resend_lot_cancellation",
      `lot cancellation re-send for ${booking.reslab_reservation_number} ${classified.outcome}: ${classified.error ?? "?"}`
    );
  }
  await recordResend(supabase, claimed.id, booking.reslab_reservation_number, {
    outcome: classified.outcome,
    email_id: classified.emailId,
    recipients: recipients.to,
    last_error: classified.error,
  });
  return { ok: true, outcome: classified.outcome, n: claimed.n, recipients: recipients.to, test: recipients.test };
}

// --- Re-send customer confirmation -------------------------------------------------------------------

/** Why the booking engine could not rebuild the confirmation (create-booking's DirectResendView reasons). */
export type ConfirmationViewRefusal =
  | "no_row"
  | "other_mode"
  | "no_number"
  | "not_direct"
  | "refunded"
  | "unreadable"
  | "not_confirmed"
  | "mid_cancel"
  | "unsent";

/**
 * The booking engine's two halves of a confirmation re-send, INJECTED by the
 * route (create-booking's `buildDirectResendView` + fulfill's
 * `sendDirectCustomerConfirmation`): src/lib/direct must never import the
 * engine, which reaches ResLab (no-reslab-imports.test.ts). The route's
 * adapter is type-checked against the engine's own result type, so a new
 * refusal reason there fails the build until it is mapped here.
 *   build — reads only; throws on a Stripe or database READ failure.
 *   send  — never throws; false = not confirmed sent (refused, or no answer in
 *           time — it may still have been delivered).
 */
export interface ConfirmationResender<View> {
  build(piId: string): Promise<{ ok: true; view: View; guestEmail: string } | { ok: false; reason: ConfirmationViewRefusal }>;
  send(view: View, idempotencyKey: string): Promise<boolean>;
}

const VIEW_REFUSALS: Record<ConfirmationViewRefusal, ActionRefusal> = {
  no_row: refuse(500, "This booking's checkout record is missing — re-send the confirmation by hand."),
  other_mode: refuse(409, OTHER_MODE_MESSAGE),
  no_number: refuse(500, "This booking's checkout record has no confirmation number — handle it by hand."),
  not_direct: refuse(409, "Stripe doesn't record this payment as a Triply-lot booking — handle it by hand."),
  refunded: refuse(409, "This payment was refunded in full — no confirmation is re-sent."),
  unreadable: refuse(500, "This booking's details couldn't be rebuilt for the email — handle it by hand (see Sentry)."),
  not_confirmed: refuse(409, "This booking is no longer confirmed — no confirmation is re-sent."),
  mid_cancel: refuse(409, "A cancellation of this booking is in progress."),
  // The checkout/re-drive path still owns that email (pending_bookings.email_sent
  // = false): a re-send now would race its automatic retry and could arrive twice.
  unsent: refuse(
    409,
    "The original confirmation hasn't gone yet — it is retried automatically; use Retry lot notice to push it now."
  ),
};

export async function resendCustomerConfirmation<View>(
  supabase: AdminClient,
  booking: DirectBookingRow,
  sentBy: string,
  resender: ConfirmationResender<View>
): Promise<ResendResult | ActionRefusal> {
  const pre = customerResendRefusal(booking);
  if (pre) return pre;

  let built: Awaited<ReturnType<ConfirmationResender<View>["build"]>>;
  try {
    built = await resender.build(booking.stripe_payment_intent_id);
  } catch (err) {
    reportStage(
      "resend_customer_confirmation",
      `confirmation re-send for ${booking.reslab_reservation_number}: view build failed: ${err instanceof Error ? err.message : String(err)}`
    );
    return refuse(502, "Couldn't read the booking from Stripe or the database — try again.");
  }
  if (!built.ok) return VIEW_REFUSALS[built.reason];

  // The staged guest email — the address the original confirmation went to.
  const to = [built.guestEmail];
  const claimed = await claimResend(supabase, booking, "customer_confirmation", booking.livemode, sentBy, to);
  if (!claimed.ok) return claimed;

  // The send never throws and reports its own failure to Sentry. `false`
  // covers both a refusal and no answer in time, and the two can't be told
  // apart here — so it is recorded "unknown" (it may have been delivered),
  // never "failed", and the UI says it may have been sent.
  const sent = await resender.send(built.view, `direct-confirmation/resend/${booking.id}/${claimed.n}`);
  const outcome: ResendOutcome = sent ? "sent" : "unknown";
  await recordResend(supabase, claimed.id, booking.reslab_reservation_number, {
    outcome,
    email_id: null,
    recipients: to,
    last_error: sent ? null : "not confirmed sent (Resend refused it or did not answer in time — it may have been delivered; see Sentry)",
  });
  return { ok: true, outcome, n: claimed.n, recipients: to, test: !booking.livemode };
}
