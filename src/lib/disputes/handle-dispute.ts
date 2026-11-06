import type Stripe from "stripe";
import { stripe } from "@/lib/stripe/client";
import { capturePaymentError } from "@/lib/sentry";
import { sendDisputeClosedAlert, sendDisputeOpenedAlert } from "@/lib/resend/send-dispute-alert";
import {
  buildEvidence,
  DISPUTE_BOOKING_SELECT,
  playbookFor,
  type ChargeFacts,
  type DisputeBooking,
  type DisputeContact,
} from "./evidence";
import type { createAdminClient } from "@/lib/supabase/server";

type Db = Awaited<ReturnType<typeof createAdminClient>>;

/**
 * What the webhook should do with Stripe's delivery. `flipBooking`: this
 * delivery stored the booking's pre-dispute status (or the ledger is
 * unavailable), so the webhook should now flip the booking to `disputed` —
 * exactly once, even when it also asks for a retry. `statusBefore`: the
 * status the flip must still find (compare-and-set); null = unknown.
 */
export type DisputeOutcome = { retryable: boolean; flipBooking?: boolean; statusBefore?: string | null };

type DbError = { message: string; code?: string };

// The ledger table is missing (migration 045 not applied yet). Retrying can't
// fix that, and a 503 would block the booking's status flip for Stripe's
// whole ~3-day retry window. Report it loudly and let the webhook carry on.
const MISSING_TABLE = new Set(["42P01", "PGRST205"]);

// Every Stripe call here is capped well inside the route's 60 s budget, so a
// slow one fails (and is reported) instead of the function being killed
// mid-step. The SDK default is 80 s with 2 retries. One retry stays: the draft
// is one-shot (draft_attempted_at), so a single 429/ECONNRESET must not lose
// it. Worst case: charge read ~17 s + draft ~17 s + Resend 10 s.
const STRIPE_OPTS = { timeout: 8_000, maxNetworkRetries: 1 };

// A send lease older than this belongs to a delivery that died: the route
// cannot run past 60 s, so no live delivery still holds it.
const ALERT_LEASE_MS = 120_000;

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
  return missing ? { retryable: false, flipBooking: true, statusBefore: null } : { retryable: true };
}

const CLOSED = new Set(["won", "lost", "warning_closed", "prevented"]);
// Only these statuses accept evidence.
const NEEDS_RESPONSE = new Set(["needs_response", "warning_needs_response"]);

const idOf = (x: string | { id: string } | null | undefined) => (typeof x === "string" ? x : x?.id ?? null);
const dueByISO = (d: Stripe.Dispute) =>
  d.evidence_details?.due_by ? new Date(d.evidence_details.due_by * 1000).toISOString() : null;
const now = () => new Date().toISOString();
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

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
 * "does the row exist" check is not enough to run a side effect once.
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
 * The alert email's lease. `alert_claimed_at` is held only while a delivery
 * sends; `alert_sent_at` is written only after Resend accepted the email. So a
 * delivery that dies mid-send leaves an unsent, expiring lease — not a "sent"
 * mark that would suppress every redelivery (review pass 1 Critical).
 *   taken — this delivery sends it
 *   sent  — already sent
 *   held  — another delivery is sending right now, or died < 2 min ago
 */
async function takeAlertLease(supabase: Db, disputeId: string): Promise<"taken" | "sent" | "held"> {
  // Two conditional UPDATEs, never one `.or()`: PostgREST rejects `.or()` on
  // an UPDATE (reference_postgrest_or_on_update).
  const take = async (stale: boolean) => {
    const base = supabase
      .from("disputes")
      .update({ alert_claimed_at: now() })
      .eq("stripe_dispute_id", disputeId)
      .is("alert_sent_at", null);
    const q = stale
      ? base.lt("alert_claimed_at", new Date(Date.now() - ALERT_LEASE_MS).toISOString())
      : base.is("alert_claimed_at", null);
    const { data, error } = await q.select("stripe_dispute_id");
    if (error) throw new Error(`alert lease failed: ${error.message}`);
    return Array.isArray(data) && data.length > 0;
  };
  if ((await take(false)) || (await take(true))) return "taken";

  const { data, error } = await supabase
    .from("disputes")
    .select("alert_sent_at")
    .eq("stripe_dispute_id", disputeId)
    .maybeSingle();
  if (error) throw new Error(`alert lease read failed: ${error.message}`);
  return (data as { alert_sent_at: string | null } | null)?.alert_sent_at ? "sent" : "held";
}

/**
 * The disputed charge as Stripe records it — the only source for "charged" and
 * "refunded" in the evidence. null (reported) when it can't be read; the draft
 * then states no amount and makes no "no refund" claim.
 */
async function readCharge(
  d: Stripe.Dispute,
  ctx: { stripePaymentIntentId: string; amount: number }
): Promise<ChargeFacts | null> {
  const chargeId = idOf(d.charge);
  if (!chargeId) return null;
  try {
    const c = await stripe.charges.retrieve(chargeId, {}, STRIPE_OPTS);
    return { capturedCents: c.amount_captured, refundedCents: c.amount_refunded, currency: c.currency };
  } catch (err) {
    capturePaymentError(new Error(`Dispute ${d.id}: charge read failed, draft states no amount: ${messageOf(err)}`), ctx);
    return null;
  }
}

/**
 * The name and email typed at checkout (`pending_bookings.customer`). The
 * linked customers row can be a signed-in user's own row when they booked for
 * someone else, so it is only a labelled fallback. A failed read is reported
 * and falls back to that label — it must not hold up the alert.
 */
async function readContact(
  supabase: Db,
  d: Stripe.Dispute,
  ctx: { stripePaymentIntentId: string; amount: number },
  paymentIntentId: string,
  booking: DisputeBooking
): Promise<DisputeContact | null> {
  const { data, error } = await supabase
    .from("pending_bookings")
    .select("customer")
    .eq("stripe_payment_intent_id", paymentIntentId)
    .maybeSingle();
  if (error) {
    capturePaymentError(new Error(`Dispute ${d.id}: checkout contact lookup failed: ${error.message}`), ctx);
  }
  type Typed = { firstName?: string | null; lastName?: string | null; email?: string | null };
  const typed = (data as { customer: Typed | null } | null)?.customer ?? null;
  if (typed) {
    return {
      name: [typed.firstName, typed.lastName].filter(Boolean).join(" ") || null,
      email: typed.email ?? null,
      source: "checkout",
    };
  }
  const c = booking.customers;
  if (!c) return null;
  return { name: [c.first_name, c.last_name].filter(Boolean).join(" ") || null, email: c.email, source: "account" };
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
 * person fills it in by hand); an unsent alert asks Stripe to redeliver.
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
  // status has moved on since (refunded, cancelled) is left alone. A NULL
  // status stored as NULL counts as "still the same" (`?? null`).
  const unflipped =
    booking != null && booking.status !== "disputed" && (booking.status ?? null) === row.booking_status_at_dispute;
  const flip = storedStatus || unflipped;
  const statusBefore = row.booking_status_at_dispute;
  const frozen = (o: DisputeOutcome): DisputeOutcome => ({ ...o, flipBooking: flip, statusBefore });

  // Evidence describes the booking as it was before the dispute.
  const asDisputed = booking ? { ...booking, status: row.booking_status_at_dispute } : null;
  // Read on every delivery: the alert needs it too (the confirmation went to
  // the checkout address, which is what ops searches for in Resend).
  const contact = booking && paymentIntentId ? await readContact(supabase, d, ctx, paymentIntentId, booking) : null;

  let draftSaved = Boolean(row.evidence_drafted_at);
  let draftError = row.evidence_draft_error;
  let draftUnknown = false;
  if (asDisputed && paymentIntentId && NEEDS_RESPONSE.has(d.status)) {
    let claimed: boolean;
    try {
      claimed = await claim(supabase, d.id, "draft_attempted_at");
    } catch (err) {
      return frozen(fail("claim failed", messageOf(err)));
    }
    if (claimed) {
      const charge = await readCharge(d, ctx);
      try {
        await stripe.disputes.update(
          d.id,
          {
            evidence: buildEvidence(asDisputed, d.reason, { contact, charge }),
            submit: false,
            metadata: { booking_id: asDisputed.id },
          },
          STRIPE_OPTS
        );
        draftSaved = true;
        draftError = null;
      } catch (err) {
        draftError = messageOf(err);
        capturePaymentError(new Error(`Dispute ${d.id}: evidence draft failed: ${draftError}`), ctx);
      }
      const { error } = await supabase
        .from("disputes")
        .update(draftSaved ? { evidence_drafted_at: now() } : { evidence_draft_error: draftError })
        .eq("stripe_dispute_id", d.id);
      if (error) capturePaymentError(new Error(`Dispute ${d.id}: draft status write failed: ${error.message}`), ctx);
    } else if (!draftSaved && !draftError) {
      // Another delivery took the draft and recorded no result: it is still
      // running, or it died mid-call. Whether Stripe kept anything is unknown.
      draftUnknown = true;
      capturePaymentError(
        new Error(`Dispute ${d.id}: an earlier evidence-draft attempt recorded no result — check the dispute in Stripe`),
        ctx
      );
    }
  }

  let lease: "taken" | "sent" | "held";
  try {
    lease = await takeAlertLease(supabase, d.id);
  } catch (err) {
    return frozen(fail("alert lease failed", messageOf(err)));
  }
  if (lease === "sent") return frozen({ retryable: false });
  // Another delivery is sending now, or died less than ALERT_LEASE_MS ago.
  // Ask Stripe to come back: by then it is sent, or the lease has expired.
  if (lease === "held") return frozen({ retryable: true });

  try {
    const lot = booking ? [booking.location_name, booking.location_address].filter(Boolean).join(", ") : null;
    await sendDisputeOpenedAlert({
      disputeId: d.id,
      amountCents: d.amount,
      reason: d.reason,
      dueByISO: dueByISO(d),
      livemode: d.livemode,
      confirmationNumber: booking?.reslab_reservation_number ?? null,
      customerEmail: contact?.email
        ? contact.source === "checkout"
          ? contact.email
          : `${contact.email} (account email; no checkout record)`
        : null,
      lot: lot || null,
      checkIn: booking?.check_in ?? null,
      playbook: playbookFor(d.reason),
      draftSaved,
      draftError,
      draftUnknown,
    });
  } catch (err) {
    // Free the lease so Stripe's redelivery sends it. If this write fails
    // too, the lease simply expires after ALERT_LEASE_MS.
    const { error } = await supabase
      .from("disputes")
      .update({ alert_claimed_at: null })
      .eq("stripe_dispute_id", d.id)
      .is("alert_sent_at", null);
    if (error) {
      capturePaymentError(
        new Error(`Dispute ${d.id}: alert lease release failed (a redelivery sends it after the lease expires): ${error.message}`),
        ctx
      );
    }
    return frozen(fail("alert email failed", messageOf(err)));
  }

  const { error: sentErr } = await supabase
    .from("disputes")
    .update({ alert_sent_at: now() })
    .eq("stripe_dispute_id", d.id);
  if (sentErr) {
    // The email went out. Not retried: a redelivery would only send it twice.
    capturePaymentError(new Error(`Dispute ${d.id}: alert sent but not recorded: ${sentErr.message}`), ctx);
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
    return fail("close claim failed", messageOf(err));
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
