import type Stripe from "stripe";
import { stripe } from "@/lib/stripe/client";
import { capturePaymentError } from "@/lib/sentry";
import { sendDisputeClosedAlert, sendDisputeOpenedAlert } from "@/lib/resend/send-dispute-alert";
import { buildEvidence, DISPUTE_BOOKING_SELECT, playbookFor, type DisputeBooking } from "./evidence";
import type { createAdminClient } from "@/lib/supabase/server";

type Db = Awaited<ReturnType<typeof createAdminClient>>;

/**
 * What the webhook should do with Stripe's delivery. `flipBooking`: this
 * delivery stored the booking's pre-dispute status (or the ledger is
 * unavailable), so the webhook should now flip the booking to `disputed` —
 * exactly once, even when it also asks for a retry.
 */
export type DisputeOutcome = { retryable: boolean; flipBooking?: boolean };

type DbError = { message: string; code?: string };

// The ledger table is missing (migration 045 not applied yet). Retrying can't
// fix that, and a 503 would block the booking's status flip for Stripe's
// whole ~3-day retry window. Report it loudly and let the webhook carry on.
const MISSING_TABLE = new Set(["42P01", "PGRST205"]);

function failWith(
  d: Stripe.Dispute,
  ctx: { stripePaymentIntentId: string; amount: number },
  what: string,
  err: DbError | string
): DisputeOutcome {
  const e = typeof err === "string" ? { message: err } : err;
  const missing = e.code != null && MISSING_TABLE.has(e.code);
  capturePaymentError(
    new Error(`Dispute ${d.id}: ${what}: ${e.message}${missing ? " — is migration 045 applied?" : ""}`),
    ctx
  );
  return missing ? { retryable: false, flipBooking: true } : { retryable: true };
}

const CLOSED = new Set(["won", "lost", "warning_closed", "prevented"]);
// Only these statuses accept evidence.
const NEEDS_RESPONSE = new Set(["needs_response", "warning_needs_response"]);

const idOf = (x: string | { id: string } | null | undefined) => (typeof x === "string" ? x : x?.id ?? null);
const dueByISO = (d: Stripe.Dispute) =>
  d.evidence_details?.due_by ? new Date(d.evidence_details.due_by * 1000).toISOString() : null;
const now = () => new Date().toISOString();

type LedgerRow = {
  booking_id: string | null;
  booking_status_at_dispute: string | null;
  evidence_drafted_at: string | null;
  evidence_draft_error: string | null;
  closed_at: string | null;
};
const LEDGER_SELECT = "booking_id, booking_status_at_dispute, evidence_drafted_at, evidence_draft_error, closed_at";

function ledgerRow(d: Stripe.Dispute) {
  return {
    stripe_dispute_id: d.id,
    payment_intent_id: idOf(d.payment_intent),
    charge_id: idOf(d.charge),
    amount_cents: d.amount,
    currency: d.currency,
    reason: d.reason,
    status: d.status,
    evidence_due_by: dueByISO(d),
    livemode: d.livemode,
  };
}

/**
 * Atomically set `col` from NULL to now. True only for the one caller that
 * flipped it — Stripe delivers events concurrently and out of order, so a
 * "does the row exist" check is not enough to send exactly one email.
 */
async function claim(supabase: Db, disputeId: string, col: string, extra: Record<string, unknown> = {}) {
  const { data, error } = await supabase
    .from("disputes")
    .update({ [col]: now(), ...extra })
    .eq("stripe_dispute_id", disputeId)
    .is(col, null)
    .select("stripe_dispute_id");
  if (error) throw new Error(`claim ${col} failed: ${error.message}`);
  return Array.isArray(data) && data.length > 0;
}

/**
 * charge.dispute.created: ledger row, evidence DRAFT on Stripe, alert email.
 * MUST run before the webhook flips the booking to `disputed`: the evidence
 * describes the booking as it was (cancelled or not), and that status is
 * frozen into the ledger so a redelivery still sees it.
 *
 * Each side effect is claimed by its own column, so a redelivery, a
 * concurrent delivery or an `updated` event that arrived first can neither
 * duplicate nor suppress it. A failed draft is reported, not retried (a
 * person fills it in by hand); a failed email releases its claim and asks
 * Stripe to redeliver.
 */
export async function handleDisputeCreated(supabase: Db, d: Stripe.Dispute): Promise<DisputeOutcome> {
  const paymentIntentId = idOf(d.payment_intent);
  const ctx = { stripePaymentIntentId: paymentIntentId ?? "unknown", amount: d.amount / 100 };
  const fail = (what: string, err: DbError | string) => failWith(d, ctx, what, err);

  let booking: DisputeBooking | null = null;
  if (paymentIntentId) {
    const { data, error } = await supabase
      .from("bookings")
      .select(DISPUTE_BOOKING_SELECT)
      .eq("stripe_payment_intent_id", paymentIntentId)
      .maybeSingle();
    if (error) return fail("booking lookup failed", error);
    booking = (data as DisputeBooking | null) ?? null;
  }

  const readRow = async () => {
    const { data, error } = await supabase
      .from("disputes")
      .select(LEDGER_SELECT)
      .eq("stripe_dispute_id", d.id)
      .maybeSingle();
    return { row: (data as LedgerRow | null) ?? null, error: error as DbError | null };
  };

  let { row, error: foundErr } = await readRow();
  if (foundErr) return fail("ledger lookup failed", foundErr);

  // A redelivery after the flip reads `disputed`: the earlier status is then
  // unknown, and the evidence must not guess it.
  const statusNow = booking?.status && booking.status !== "disputed" ? booking.status : null;

  let storedStatus = false;
  if (!row) {
    const fresh: LedgerRow = {
      booking_id: booking?.id ?? null,
      booking_status_at_dispute: statusNow,
      evidence_drafted_at: null,
      evidence_draft_error: null,
      closed_at: null,
    };
    const { error } = await supabase.from("disputes").insert({ ...ledgerRow(d), ...fresh });
    if (!error) {
      row = fresh;
      storedStatus = true;
    } else if (error.code === "23505") {
      // A concurrent delivery (possibly an `updated` event, with no booking)
      // inserted first. Re-read it; the link step below fills the booking in.
      ({ row, error: foundErr } = await readRow());
      if (foundErr || !row) return fail("ledger re-read failed", foundErr ?? "row vanished");
    } else {
      return fail("ledger insert failed", error);
    }
  }
  if (booking && !row.booking_id) {
    // An `updated` event created the row without the booking. Link it now.
    const link = { booking_id: booking.id, booking_status_at_dispute: statusNow };
    const { error } = await supabase.from("disputes").update(link).eq("stripe_dispute_id", d.id);
    if (error) return fail("ledger link failed", error);
    row = { ...row, ...link };
    storedStatus = true;
  }
  // This delivery stored the pre-dispute status: it owns the booking flip. A
  // redelivery also flips while the booking still has exactly that status —
  // the earlier delivery died before its flip (e.g. a function timeout), and
  // without this the booking would never read `disputed`. A booking whose
  // status has moved on since (refunded, cancelled) is left alone.
  const unflipped =
    booking?.status != null && booking.status !== "disputed" && booking.status === row.booking_status_at_dispute;
  const flip = storedStatus || unflipped;
  const frozen = (o: DisputeOutcome): DisputeOutcome => ({ ...o, flipBooking: flip });

  // Evidence describes the booking as it was before the dispute.
  const asDisputed = booking ? { ...booking, status: row.booking_status_at_dispute } : null;

  let draftSaved = Boolean(row.evidence_drafted_at);
  let draftError = row.evidence_draft_error;
  try {
    if (asDisputed && NEEDS_RESPONSE.has(d.status) && (await claim(supabase, d.id, "draft_attempted_at"))) {
      try {
        await stripe.disputes.update(d.id, {
          evidence: buildEvidence(asDisputed, d.reason),
          submit: false,
          metadata: { booking_id: asDisputed.id },
        });
        draftSaved = true;
        draftError = null;
      } catch (err) {
        draftError = err instanceof Error ? err.message : String(err);
        capturePaymentError(new Error(`Dispute ${d.id}: evidence draft failed: ${draftError}`), ctx);
      }
      const { error } = await supabase
        .from("disputes")
        .update(draftSaved ? { evidence_drafted_at: now() } : { evidence_draft_error: draftError })
        .eq("stripe_dispute_id", d.id);
      if (error) capturePaymentError(new Error(`Dispute ${d.id}: draft status write failed: ${error.message}`), ctx);
    }

    if (!(await claim(supabase, d.id, "alert_sent_at"))) return frozen({ retryable: false });
  } catch (err) {
    return frozen(fail("claim failed", err instanceof Error ? err.message : String(err)));
  }

  try {
    const lot = booking ? [booking.location_name, booking.location_address].filter(Boolean).join(", ") : null;
    await sendDisputeOpenedAlert({
      disputeId: d.id,
      amountCents: d.amount,
      reason: d.reason,
      dueByISO: dueByISO(d),
      livemode: d.livemode,
      confirmationNumber: booking?.reslab_reservation_number ?? null,
      customerEmail: booking?.customers?.email ?? null,
      lot: lot || null,
      checkIn: booking?.check_in ?? null,
      playbook: playbookFor(d.reason),
      draftSaved,
      draftError,
    });
  } catch (err) {
    // Release the claim so Stripe's redelivery sends it.
    const { error } = await supabase.from("disputes").update({ alert_sent_at: null }).eq("stripe_dispute_id", d.id);
    if (error) capturePaymentError(new Error(`Dispute ${d.id}: alert claim release failed: ${error.message}`), ctx);
    return frozen(fail("alert email failed", err instanceof Error ? err.message : String(err)));
  }

  return frozen({ retryable: false });
}

/**
 * charge.dispute.updated / .closed: keep the ledger's status + deadline
 * current; on close record the outcome and email it once. Events arrive out
 * of order, so a closed dispute's status is never overwritten by a late
 * non-terminal update.
 */
export async function handleDisputeChanged(supabase: Db, d: Stripe.Dispute): Promise<DisputeOutcome> {
  const ctx = { stripePaymentIntentId: idOf(d.payment_intent) ?? "unknown", amount: d.amount / 100 };
  const fail = (what: string, err: DbError | string) => failWith(d, ctx, what, err);
  const closed = CLOSED.has(d.status);

  const { data: found, error: foundErr } = await supabase
    .from("disputes")
    .select(LEDGER_SELECT)
    .eq("stripe_dispute_id", d.id)
    .maybeSingle();
  if (foundErr) return fail("ledger lookup failed", foundErr);
  const row = (found as LedgerRow | null) ?? null;

  if (!row) {
    // Arrived before `created`, or the dispute predates the ledger. `created`
    // links the booking if it comes later.
    const { error } = await supabase.from("disputes").insert(ledgerRow(d));
    if (error && error.code !== "23505") return fail("ledger insert failed", error);
  } else if (!row.closed_at) {
    const { error } = await supabase
      .from("disputes")
      .update({ status: d.status, evidence_due_by: dueByISO(d) })
      .eq("stripe_dispute_id", d.id)
      .is("closed_at", null);
    if (error) return fail("ledger update failed", error);
  }

  if (!closed) return { retryable: false };

  let first: boolean;
  try {
    first = await claim(supabase, d.id, "closed_at", { status: d.status, outcome: d.status });
  } catch (err) {
    return fail("close claim failed", err instanceof Error ? err.message : String(err));
  }
  if (!first) return { retryable: false };

  let confirmationNumber: string | null = null;
  const bookingId = row?.booking_id ?? null;
  if (bookingId) {
    const { data, error } = await supabase
      .from("bookings")
      .select("reslab_reservation_number")
      .eq("id", bookingId)
      .maybeSingle();
    if (error) capturePaymentError(new Error(`Dispute ${d.id}: booking lookup for close email failed: ${error.message}`), ctx);
    confirmationNumber = (data as { reslab_reservation_number: string | null } | null)?.reslab_reservation_number ?? null;
  }
  try {
    await sendDisputeClosedAlert({ disputeId: d.id, amountCents: d.amount, outcome: d.status, livemode: d.livemode, confirmationNumber });
  } catch (err) {
    // The outcome is recorded; only the courtesy email is lost. Not retried.
    capturePaymentError(err instanceof Error ? err : new Error(String(err)), ctx);
  }
  return { retryable: false };
}
