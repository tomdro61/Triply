import { createAdminClient } from "@/lib/supabase/server";
import { resend, FROM_EMAIL } from "@/lib/resend/client";
import { resolveEnv } from "@/lib/env";
import { escapeHtml } from "@/lib/validation/schemas";
import { captureDirectLotNotice } from "@/lib/sentry";
import { convertTo12Hour } from "@/lib/utils/time";
import { formatDate } from "@/lib/utils";
import { bounded, BoundedTimeoutError } from "@/lib/utils/bounded";

/**
 * Lot-facing emails for DIRECT-lot bookings (4b plan §3.4 / B11, §9 M-D,
 * §10 F-2). The lot has no system of ours to look at: this email IS how it
 * learns a car is coming, so every send is claimed, bounded and stamped.
 *
 * RECIPIENTS — the lot's own inbox (`direct_booking_terms.lot_recipients`)
 * ONLY for a live-mode booking on the production deployment. Everything else
 * (staging, preview, a test-mode row read by production) goes to
 * `DIRECT_LOT_NOTICE_OVERRIDE_TO` with "[TEST]" in the subject; unset → no
 * send, a Sentry warning, and the row stays un-notified.
 *
 * ONCE — an atomic claim on the bookings row (`lot_notice_claimed_at` /
 * `lot_cancel_notice_claimed_at`) before the send; `…_notified_at` is stamped
 * only when Resend accepted it. A DEFINITE failure clears the claim so a later
 * re-drive can try again; a TIMEOUT keeps it (Resend may have delivered) until
 * it goes stale after STALE_NOTICE_CLAIM_MS, and the re-drive then repeats the
 * same request under the same Resend idempotency key (kind + booking +
 * test/live — deliberately NOT the URGENT flag, which a later re-drive can
 * compute differently). A retry whose body changed (it became URGENT) is then
 * refused by Resend as `invalid_idempotent_request`, which means the key
 * already carried an ACCEPTED send: treated as sent, never a second notice.
 *
 * ORDER (F-2) — the lot must hear of a cancellation LAST. The booking notice is
 * claimable only while the row is `confirmed`. The cancel notice is claimable
 * once the booking notice was stamped, or — for a booking notice that may have
 * gone out but was never stamped — once its claim is STALE (its sender is
 * gone; anything it sent is long delivered). Never while it is in flight: that
 * case is caught by the booking sender, which re-reads the status as it stamps
 * and sends the cancel notice itself. A booking cancelled before its notice
 * was claimed produces neither: the lot never heard of it. Re-drives: the
 * engine's Step 3 and the sweep's direct backstop.
 */

export type LotNoticeKind = "booking" | "cancel";
export type LotNoticeOutcome =
  /** Accepted by Resend and stamped. */
  | "sent"
  /** Nothing to do: already sent, claimed by someone else, or not in a state that sends. */
  | "not_claimed"
  /** No recipient configured for a non-production send (override inbox unset). */
  | "skipped"
  /** The send or a read failed; the claim was released for a later re-drive. */
  | "failed";

const SEND_TIMEOUT_MS = 5_000;
const DB_TIMEOUT_MS = 3_000;
/**
 * Longer than any route's maxDuration (60 s): a live claim is never stolen, and a
 * booking send can never still be in flight when its claim goes stale (a
 * request does not outlive its function) — which is what lets the cancel
 * claim's second gate pass a stale booking claim without overtaking it.
 * Pinned by notice-claim-window.test.ts.
 */
export const STALE_NOTICE_CLAIM_MS = 5 * 60_000;

const COLUMNS = {
  booking: { claimed: "lot_notice_claimed_at", notified: "lot_notified_at", emailId: "lot_notice_email_id" },
  cancel: { claimed: "lot_cancel_notice_claimed_at", notified: "lot_cancel_notified_at", emailId: "lot_cancel_notice_email_id" },
} as const;

/** What a booking notice says. Built by the engine from the staged row. */
export interface LotBookingNoticeContent {
  number: string;
  lotName: string;
  customerName: string;
  customerPhone: string;
  vehicle: { make: string; model: string; color: string; licensePlate: string; state: string };
  vehicleSizeLabel: string;
  /** Surcharge + its tax, in cents — what the lot collects at drop-off (0 = none). */
  atLotCents: number;
  /** Literal airport-local "YYYY-MM-DD HH:MM:SS". */
  fromDate: string;
  toDate: string;
  parkGuard: boolean;
  /** Check-in has already passed: the car may be at the gate now. */
  urgent: boolean;
}

interface Recipients {
  to: string[];
  test: boolean;
}

function resolveRecipients(livemode: boolean, lotRecipients: string[]): Recipients | null {
  if (livemode && resolveEnv() === "production") return { to: lotRecipients, test: false };
  const override = (process.env.DIRECT_LOT_NOTICE_OVERRIDE_TO ?? "").trim();
  if (!override) return null;
  return { to: override.split(",").map((s) => s.trim()).filter(Boolean), test: true };
}

const fmtWhen = (wallClock: string) => {
  const [date, time] = wallClock.split(" ");
  return `${formatDate(date)} at ${convertTo12Hour(time)}`;
};
const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

function bookingNoticeEmail(c: LotBookingNoticeContent, test: boolean): { subject: string; html: string; text: string } {
  const v = c.vehicle;
  const vehicleLine = `${v.color} ${v.make} ${v.model} — plate ${v.licensePlate} (${v.state})`;
  const rows: Array<[string, string]> = [
    ["Confirmation", c.number],
    ["Customer", c.customerName],
    ["Phone", c.customerPhone],
    ["Drop-off", fmtWhen(c.fromDate)],
    ["Pick-up", fmtWhen(c.toDate)],
    ["Vehicle", vehicleLine],
    ["Declared size", c.vehicleSizeLabel],
    ["Collect at the lot (est.)", c.atLotCents > 0 ? `${usd(c.atLotCents)} oversized-vehicle surcharge incl. tax` : "Nothing — paid in full online"],
    ["Parking protection", c.parkGuard ? "Yes (Park Guard)" : "No"],
  ];
  const prefix = `${test ? "[TEST] " : ""}${c.urgent ? "URGENT — late booking — " : ""}`;
  const subject = `${prefix}New Triply booking ${c.number} — ${fmtWhen(c.fromDate)}`;
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px;">
      ${test ? `<p style="background:#fef3c7;padding:8px 12px;border-radius:6px;color:#92400e;"><strong>TEST booking</strong> — not a real customer. Sent to the override inbox, not the lot.</p>` : ""}
      ${c.urgent ? `<p style="background:#fee2e2;padding:8px 12px;border-radius:6px;color:#991b1b;"><strong>URGENT:</strong> the drop-off time has already passed — this customer may be arriving now.</p>` : ""}
      <h2 style="margin:0 0 12px;">New booking at ${escapeHtml(c.lotName)}</h2>
      <table style="border-collapse:collapse;width:100%;">
        ${rows
          .map(
            ([k, val]) =>
              `<tr><td style="padding:6px 8px;color:#64748b;border-bottom:1px solid #e5e7eb;white-space:nowrap;">${escapeHtml(k)}</td><td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;font-weight:600;">${escapeHtml(val)}</td></tr>`
          )
          .join("")}
      </table>
      <p style="color:#64748b;font-size:12px;margin-top:16px;">The customer has paid online for the parking. The oversized-vehicle surcharge, if any, is collected by the lot at drop-off and is an estimate — size the vehicle at the gate.</p>
    </div>`;
  const text = rows.map(([k, val]) => `${k}: ${val}`).join("\n");
  return { subject, html, text: `${prefix}New booking at ${c.lotName}\n\n${text}` };
}

function cancelNoticeEmail(
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
      <table style="border-collapse:collapse;width:100%;">
        ${rows
          .map(
            ([k, val]) =>
              `<tr><td style="padding:6px 8px;color:#64748b;border-bottom:1px solid #e5e7eb;">${escapeHtml(k)}</td><td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;font-weight:600;">${escapeHtml(val)}</td></tr>`
          )
          .join("")}
      </table>
    </div>`;
  return { subject, html, text: `${subject}\n\n${rows.map(([k, val]) => `${k}: ${val}`).join("\n")}` };
}

type AdminClient = Awaited<ReturnType<typeof createAdminClient>>;

/**
 * Claim the notice on the bookings row. Single-condition UPDATEs only (never
 * `.or()` on an UPDATE): each gate is tried fresh, then stale. The cancel
 * notice has two gates — booking notice stamped, or claimed long enough ago
 * that it is stale (a sent-but-unstamped booking notice must not silence the
 * cancellation, and an in-flight one must not be overtaken by it).
 */
async function claim(
  supabase: AdminClient,
  kind: LotNoticeKind,
  piId: string
): Promise<{ bookingId: string; fromStale: boolean } | null> {
  const col = COLUMNS[kind];
  const now = new Date().toISOString();
  const staleBefore = new Date(Date.now() - STALE_NOTICE_CLAIM_MS).toISOString();
  const gates: Array<"confirmed" | "lot_notified_at" | "lot_notice_claimed_at"> =
    kind === "booking" ? ["confirmed"] : ["lot_notified_at", "lot_notice_claimed_at"];
  for (const gate of gates) {
    const base = () => {
      const q = supabase
        .from("bookings")
        .update({ [col.claimed]: now })
        .eq("stripe_payment_intent_id", piId)
        .eq("inventory_source", "direct")
        .is(col.notified, null);
      if (gate === "confirmed") return q.eq("status", "confirmed");
      const cancelled = q.in("status", ["cancelled", "refunded"]);
      return gate === "lot_notified_at" ? cancelled.not(gate, "is", null) : cancelled.lt(gate, staleBefore);
    };
    const fresh = await base().is(col.claimed, null).select("id").abortSignal(AbortSignal.timeout(DB_TIMEOUT_MS)).maybeSingle();
    if (fresh.error) throw new Error(`claim(${kind}) failed: ${fresh.error.message}`);
    if (fresh.data) return { bookingId: (fresh.data as { id: string }).id, fromStale: false };
    const stale = await base().lt(col.claimed, staleBefore).select("id").abortSignal(AbortSignal.timeout(DB_TIMEOUT_MS)).maybeSingle();
    if (stale.error) throw new Error(`claim(${kind}, stale) failed: ${stale.error.message}`);
    if (stale.data) return { bookingId: (stale.data as { id: string }).id, fromStale: true };
  }
  return null;
}

interface NoticeEmail {
  subject: string;
  html: string;
  text: string;
  /** Everything else that changes the email; part of the Resend idempotency key. */
  variant: string;
}

async function claimAndSend(
  kind: LotNoticeKind,
  piId: string,
  build: (test: boolean) => Promise<NoticeEmail>
): Promise<LotNoticeOutcome> {
  const report = (message: string, outcome: LotNoticeOutcome) =>
    captureDirectLotNotice(new Error(`Direct lot ${kind} notice for ${piId}: ${message}`), { stripePaymentIntentId: piId, kind, outcome });
  const col = COLUMNS[kind];
  let supabase: AdminClient;
  let bookingId: string | null = null;
  try {
    supabase = await createAdminClient();
    const { data: terms, error: termsError } = await supabase
      .from("direct_booking_terms")
      .select("livemode, lot_recipients")
      .eq("stripe_payment_intent_id", piId)
      .abortSignal(AbortSignal.timeout(DB_TIMEOUT_MS))
      .maybeSingle();
    if (termsError) throw new Error(`terms read failed: ${termsError.message}`);
    if (!terms) {
      report("no direct_booking_terms row — the lot cannot be told", "failed");
      return "failed";
    }
    const t = terms as { livemode: boolean; lot_recipients: string[] };
    const recipients = resolveRecipients(t.livemode, t.lot_recipients);
    if (!recipients || recipients.to.length === 0) {
      report("DIRECT_LOT_NOTICE_OVERRIDE_TO is not set — a non-production notice was not sent", "skipped");
      return "skipped";
    }

    const claimed = await claim(supabase, kind, piId);
    if (!claimed) return "not_claimed";
    // A claim taken over from a STALE one: an earlier attempt's outcome was
    // unknown and it may have DELIVERED. Never hand that claim back on a
    // failure (a 429, a quota reply …) — it is the only record that the lot
    // may know of the booking, and the cancel claim's second gate needs it.
    bookingId = claimed.fromStale ? null : claimed.bookingId;
    const claimedId = claimed.bookingId;

    const { subject, html, text, variant } = await build(recipients.test);
    let sent: Awaited<ReturnType<typeof resend.emails.send>>;
    try {
      sent = await bounded(
        resend.emails.send(
          { from: FROM_EMAIL, to: recipients.to, subject, html, text },
          { idempotencyKey: `direct-lot-notice/${kind}/${claimedId}/${variant}` }
        ),
        SEND_TIMEOUT_MS,
        "Resend"
      );
    } catch (sendErr) {
      if (sendErr instanceof BoundedTimeoutError) {
        // Outcome UNKNOWN — Resend may have delivered it. Keep the claim: it
        // goes stale and the re-drive repeats this exact request (same key).
        bookingId = null;
        report(`${sendErr.message}; claim kept until stale, then re-driven under the same idempotency key`, "failed");
        return "failed";
      }
      throw sendErr;
    }
    const { data, error } = sent;
    // An outcome we cannot read — Resend may have delivered it: the SDK maps a
    // lost response, a gateway 5xx or an unreadable 200 to `application_error`,
    // and a 5xx says nothing about delivery either; `concurrent_idempotent_requests`
    // means the same request is in flight elsewhere. Keep the claim exactly as
    // for a timeout: releasing it would hide a notice the lot may have, and a
    // fast cancellation could then never claim its own (no gate would match).
    const unknownOutcome =
      !!error &&
      error.name !== "invalid_idempotent_request" && // = already sent, handled below
      (error.name === "application_error" ||
        error.name === "internal_server_error" ||
        error.name === "concurrent_idempotent_requests" ||
        error.statusCode == null || // null or absent: no status = unknown
        error.statusCode >= 500);
    if (unknownOutcome) {
      bookingId = null;
      report(`Resend outcome unknown (${error.name}: ${error.message}); claim kept until stale, then re-driven under the same idempotency key`, "failed");
      return "failed";
    }
    // `invalid_idempotent_request`: this key already carried an ACCEPTED send.
    if (error && error.name !== "invalid_idempotent_request") throw new Error(`Resend error: ${error.message}`);

    const { data: stamped, error: stampError } = await supabase
      .from("bookings")
      .update({ [col.notified]: new Date().toISOString() })
      .eq("id", claimedId)
      .select("status")
      .abortSignal(AbortSignal.timeout(DB_TIMEOUT_MS))
      .maybeSingle();
    if (stampError) {
      // Sent but not stamped: the claim stays (a re-drive won't resend for
      // STALE_NOTICE_CLAIM_MS; Resend's idempotency key covers 24 h after
      // that), and the cancel claim's second gate still lets a cancellation through.
      report(`sent (Resend ${data?.id ?? "?"}) but ${col.notified} was not stamped: ${stampError.message}`, "sent");
      return "sent";
    }
    if (kind === "booking") {
      const status = (stamped as { status?: string } | null)?.status;
      if (status === "cancelled" || status === "refunded") {
        // Cancelled while this notice was in flight (F-2): the cancel path's
        // claim found nothing to cancel yet. Tell the lot now.
        await sendLotCancelNotice(piId);
      }
    }
    const { error: recordError } = await supabase
      .from("direct_booking_terms")
      .update(
        kind === "booking"
          ? { [col.emailId]: data?.id ?? null, lot_notice_recipients: recipients.to }
          : { [col.emailId]: data?.id ?? null }
      )
      .eq("stripe_payment_intent_id", piId)
      .abortSignal(AbortSignal.timeout(DB_TIMEOUT_MS));
    if (recordError) report(`sent, but the Resend id was not recorded: ${recordError.message}`, "sent");
    return "sent";
  } catch (err) {
    report(err instanceof Error ? err.message : String(err), "failed");
    if (bookingId) {
      try {
        const sb = await createAdminClient();
        const { error } = await sb.from("bookings").update({ [col.claimed]: null }).eq("id", bookingId).is(col.notified, null);
        if (error) report(`claim not released (stale after ${STALE_NOTICE_CLAIM_MS / 60_000} min): ${error.message}`, "failed");
      } catch (releaseErr) {
        report(`claim not released: ${releaseErr instanceof Error ? releaseErr.message : String(releaseErr)}`, "failed");
      }
    }
    return "failed";
  }
}

/** Tell the lot about a new booking. Never throws. */
export function sendLotBookingNotice(piId: string, content: LotBookingNoticeContent): Promise<LotNoticeOutcome> {
  return claimAndSend("booking", piId, async (test) => ({
    ...bookingNoticeEmail(content, test),
    variant: test ? "test" : "live",
  }));
}

/**
 * Tell the lot a booking it was told about is cancelled. Status-driven: call it
 * after ANY transition of a direct row to cancelled/refunded (self-cancel,
 * admin, a full refund from the webhook). Only the call that wins the claim
 * sends. Never throws. A ResLab row never matches the claim.
 */
export function sendLotCancelNotice(piId: string): Promise<LotNoticeOutcome> {
  return claimAndSend("cancel", piId, async (test) => {
    const supabase = await createAdminClient();
    const { data, error } = await supabase
      .from("bookings")
      .select("reslab_reservation_number, location_name, check_in, check_out, vehicle_info, customer_id")
      .eq("stripe_payment_intent_id", piId)
      .abortSignal(AbortSignal.timeout(DB_TIMEOUT_MS))
      .maybeSingle();
    if (error || !data) throw new Error(`cancel notice read failed: ${error?.message ?? "no row"}`);
    const b = data as {
      reslab_reservation_number: string;
      location_name: string;
      check_in: string;
      check_out: string;
      vehicle_info: { make?: string; model?: string; color?: string; licensePlate?: string; state?: string } | null;
      customer_id: string | null;
    };
    // The guest the booking notice named — the staged payload's customer, not
    // the `customers` row, which belongs to the signed-in account holder when
    // they booked under someone else's email.
    const { data: staged, error: stagedError } = await supabase
      .from("pending_bookings")
      .select("customer")
      .eq("stripe_payment_intent_id", piId)
      .abortSignal(AbortSignal.timeout(DB_TIMEOUT_MS))
      .maybeSingle();
    if (stagedError) throw new Error(`cancel notice guest read failed: ${stagedError.message}`);
    const guest = (staged as { customer?: { firstName?: string; lastName?: string } | null } | null)?.customer;
    let customerName = `${guest?.firstName ?? ""} ${guest?.lastName ?? ""}`.trim();
    if (!customerName && b.customer_id) {
      const { data: cust, error: custError } = await supabase
        .from("customers")
        .select("first_name, last_name")
        .eq("id", b.customer_id)
        .abortSignal(AbortSignal.timeout(DB_TIMEOUT_MS))
        .maybeSingle();
      if (custError) throw new Error(`cancel notice customer read failed: ${custError.message}`);
      const c = cust as { first_name?: string; last_name?: string } | null;
      customerName = `${c?.first_name ?? ""} ${c?.last_name ?? ""}`.trim();
    }
    if (!customerName) customerName = "(see admin)";
    const v = b.vehicle_info ?? {};
    const email = cancelNoticeEmail(
      {
        number: b.reslab_reservation_number,
        lotName: b.location_name,
        customerName,
        // check_in/out come back from TIMESTAMP as "YYYY-MM-DDTHH:MM:SS" — literal, not a UTC instant.
        fromDate: String(b.check_in).replace("T", " ").slice(0, 19),
        toDate: String(b.check_out).replace("T", " ").slice(0, 19),
        vehicleLine: [v.color, v.make, v.model].filter(Boolean).join(" ") + (v.licensePlate ? ` — plate ${v.licensePlate}` : ""),
      },
      test
    );
    return { ...email, variant: test ? "test" : "live" };
  });
}
