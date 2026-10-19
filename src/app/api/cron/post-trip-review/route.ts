import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/server";
import { captureAPIError } from "@/lib/sentry";
import { TEST_RESLAB_LOCATION_IDS } from "@/config/admin";
import { stripeKeyMode } from "@/lib/cancellation/source-guard";
import { assertReviewSigningSecret, isReviewConfigError } from "@/lib/reviews/token";
import {
  REVIEWABLE_STATUSES,
  selectReviewSends,
  type ReviewBookingRow,
  type ReviewCandidate,
  type ReviewLedgerRow,
} from "@/lib/reviews/select";
import {
  buildReviewEmail,
  classifySendFailure,
  RESEND_SEND_TIMEOUT_MS,
  ReviewSendError,
  sendReviewEmail,
  type BuiltReviewEmail,
  type ReviewEmailFooter,
} from "@/lib/reviews/email";

/**
 * GET /api/cron/post-trip-review
 *
 * Daily at 23:00 UTC (vercel.json) — early evening in every US zone. Sends the
 * "How was parking at {lot}?" email to each booking whose check-out has passed
 * at the lot (airport-local; see src/lib/reviews/select.ts for the time rule)
 * within the last INITIAL_MAX_DAYS_AFTER days, and ONE reminder three days
 * after check-out when no review exists. Then never again.
 *
 * LEDGER (review_emails, UNIQUE (booking_id, kind), migration 037) — the
 * checkout-recovery pattern: claimed → sent | failed | retry | unconfirmed.
 * A row is INSERTed `claimed` BEFORE the send and `send_started_at` stamped
 * right before the Resend call; the send carries a Resend Idempotency-Key on
 * booking + kind with a byte-stable payload. A rate-limited send (429) parks
 * the row as `retry`; a rejection marks it `failed`; a send whose outcome is
 * unknown (timeout, 5xx, idempotency conflict) is `unconfirmed` and alarmed —
 * never retried, because Resend keeps idempotency keys only 24 h and the next
 * run is a day later. An old `claimed` row that never reached Resend is
 * removed so the booking is judged afresh; one that did is alarmed with its
 * ids. Two consecutive identical rejections stop the run (a payload bug of
 * ours would otherwise burn every row as `failed`). Every failure mode errs
 * toward NOT emailing.
 *
 * MODE: staging and production share one database. The run's mode is its
 * Stripe key (stripeKeyIsLive): a live deployment reads live/NULL bookings, a
 * test deployment only livemode = false ones, so a staging or local run can
 * never email a real customer.
 *
 * RECIPIENT: the booked guest from the staged checkout payload
 * (pending_bookings.customer), not the customers row — a signed-in account
 * can book for someone else, and its row keeps the account holder's address.
 * The customers row is the fallback for bookings without a staged payload.
 * Opted-out addresses (review opt-outs, recovery opt-outs, unsubscribed
 * newsletter/waitlist) are skipped; an unreadable opt-out list sends nothing.
 *
 * Gated by POST_TRIP_REVIEW_EMAILS_ENABLED=true so the code can merge dark.
 * Needs REVIEW_SIGNING_SECRET (links) and TRIPLY_POSTAL_ADDRESS (the footer of
 * commercial mail); refuses with 503 without either.
 * Auth: Vercel injects `Authorization: Bearer <CRON_SECRET>`; refuse without it.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_SENDS_PER_RUN = 40;
const RUN_DEADLINE_MS = 52_000;
const DB_TIMEOUT_MS = 3_000;
/** Worst case for one candidate: claim (+ re-claim) + send-start stamp +
 *  Resend + mark. Started only when it still fits before the deadline. */
const CANDIDATE_RESERVE_MS = DB_TIMEOUT_MS * 4 + RESEND_SEND_TIMEOUT_MS;
/** Check-outs this far back are read; the selector applies the real windows. */
const LOOKBACK_DAYS = 8;
/** A `claimed` row older than this will never be finished by its run. */
const STALE_CLAIM_MS = 15 * 60_000;
/** PostgREST's default row cap; hitting it means rows may be missing. */
const ROW_CAP = 1000;
/** Ids per `.in()` filter, so the request URL stays short. */
const IN_CHUNK = 150;
/** Addresses per opt-out lookup; small enough that a full page means trouble. */
const SUPPRESSION_CHUNK = 50;

const dbSignal = () => AbortSignal.timeout(DB_TIMEOUT_MS);
const CTX = { endpoint: "/api/cron/post-trip-review", method: "GET" as const };

type Supabase = Awaited<ReturnType<typeof createAdminClient>>;

function redact(s: string): string {
  return s.replace(/[^\s@<>()"',;]+@[^\s@<>()"',;]+/g, "[email]");
}

function alarm(
  fingerprint: string,
  message: string,
  level: "info" | "warning" | "error",
  extras?: Record<string, unknown>
) {
  Sentry.withScope((scope) => {
    scope.setFingerprint([fingerprint]);
    // Row and booking ids only — never an address.
    if (extras) scope.setExtras(extras);
    Sentry.captureMessage(message, level);
  });
}

async function respond(body: Record<string, unknown>, status = 200) {
  await Sentry.flush(2000).catch(() => {});
  return NextResponse.json(body, { status });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fail(stage: string, message: string) {
  captureAPIError(new Error(`post-trip-review: ${redact(message)}`), { ...CTX, stage });
  return respond({ ok: false, error: redact(message) }, 500);
}

// --- Row parsing (Zod, never casts) ------------------------------------------

const customerSchema = z.object({
  email: z.string().nullable(),
  first_name: z.string().nullable(),
});

const bookingRowSchema = z.object({
  id: z.string().uuid(),
  status: z.string(),
  cancel_state: z.string().nullable(),
  check_out: z.string(),
  location_name: z.string(),
  airport_code: z.string().nullable(),
  reslab_location_id: z.number().int().nullable(),
  direct_lot_id: z.string().nullable(),
  location_timezone: z.string().nullable(),
  livemode: z.boolean().nullable(),
  stripe_payment_intent_id: z.string().nullable(),
  // PostgREST returns a many-to-one embed as an object; accept an array too.
  customers: z.union([customerSchema, z.array(customerSchema)]).nullable(),
});

const ledgerRowSchema = z.object({
  booking_id: z.string(),
  kind: z.enum(["initial", "reminder"]),
  status: z.enum(["claimed", "retry", "sent", "failed", "unconfirmed"]),
  sent_at: z.string().nullable(),
});

/** pending_bookings.customer — the guest the booking was made for. */
const guestSchema = z.object({
  stripe_payment_intent_id: z.string(),
  customer: z.object({ email: z.string(), firstName: z.string().nullable().optional() }).passthrough(),
});

const BOOKING_COLS =
  "id, status, cancel_state, check_out, location_name, airport_code, reslab_location_id, direct_lot_id, location_timezone, livemode, stripe_payment_intent_id, customers!inner(email, first_name)";

type Guest = { email: string; firstName: string | null };

function toBookingRow(r: z.infer<typeof bookingRowSchema>, guest: Guest | undefined): ReviewBookingRow {
  const cust = Array.isArray(r.customers) ? (r.customers[0] ?? null) : r.customers;
  return {
    id: r.id,
    status: r.status,
    cancelState: r.cancel_state,
    checkOut: r.check_out,
    locationName: r.location_name,
    airportCode: r.airport_code,
    reslabLocationId: r.reslab_location_id,
    directLotId: r.direct_lot_id,
    locationTimezone: r.location_timezone,
    livemode: r.livemode,
    // The booked guest first; the customers row only when no payload was staged.
    email: guest?.email ?? cust?.email ?? null,
    firstName: guest ? guest.firstName : (cust?.first_name ?? null),
  };
}

/** The booked guest per PaymentIntent, from the staged checkout payload.
 *  Throws on a read error: without it we could email the wrong person. */
async function readGuests(supabase: Supabase, paymentIntentIds: string[]): Promise<Map<string, Guest>> {
  const out = new Map<string, Guest>();
  for (const ids of chunks(paymentIntentIds, IN_CHUNK)) {
    const { data, error } = await supabase
      .from("pending_bookings")
      .select("stripe_payment_intent_id, customer")
      .in("stripe_payment_intent_id", ids)
      .abortSignal(dbSignal());
    if (error) throw new Error(`pending_bookings read failed: ${error.message}`);
    for (const raw of data ?? []) {
      const p = guestSchema.safeParse(raw);
      // A malformed snapshot falls back to the customers row, like a missing one.
      if (!p.success) continue;
      out.set(p.data.stripe_payment_intent_id, {
        email: p.data.customer.email,
        firstName: p.data.customer.firstName?.trim() || null,
      });
    }
  }
  return out;
}

/** Lowercased addresses that must not get this email: review opt-outs, the
 *  recovery email's opt-outs, and unsubscribed newsletter / waitlist rows.
 *  Throws on any read error (fail closed: nothing is sent). */
async function readSuppressed(supabase: Supabase, emails: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  // Only opted-out rows are read, and a page that comes back full means rows
  // may be missing (PostgREST caps a response; booking_waitlist holds one row
  // per trip, so an address can have many): fail closed rather than email
  // someone whose opt-out was cut off.
  for (const batch of chunks(emails, SUPPRESSION_CHUNK)) {
    const [review, recovery, newsletter, waitlist] = await Promise.all([
      supabase.from("review_email_optouts").select("email").in("email", batch).limit(ROW_CAP).abortSignal(dbSignal()),
      supabase.from("checkout_recovery_optouts").select("email").in("email", batch).limit(ROW_CAP).abortSignal(dbSignal()),
      supabase
        .from("newsletter_subscribers")
        .select("email, unsubscribed_at")
        .in("email", batch)
        .not("unsubscribed_at", "is", null)
        .limit(ROW_CAP)
        .abortSignal(dbSignal()),
      supabase
        .from("booking_waitlist")
        .select("email, unsubscribed_at")
        .in("email", batch)
        .not("unsubscribed_at", "is", null)
        .limit(ROW_CAP)
        .abortSignal(dbSignal()),
    ]);
    for (const [name, res] of [
      ["review_email_optouts", review],
      ["checkout_recovery_optouts", recovery],
      ["newsletter_subscribers", newsletter],
      ["booking_waitlist", waitlist],
    ] as const) {
      if (res.error) throw new Error(`${name} read failed: ${res.error.message}`);
      if ((res.data ?? []).length >= ROW_CAP) throw new Error(`${name} read hit the ${ROW_CAP}-row cap; opt-outs may be incomplete`);
    }
    const optout = z.array(z.object({ email: z.string() }));
    const unsub = z.array(z.object({ email: z.string(), unsubscribed_at: z.string().nullable() }));
    for (const r of [...optout.parse(review.data ?? []), ...optout.parse(recovery.data ?? [])]) {
      out.add(r.email.toLowerCase());
    }
    for (const r of [...unsub.parse(newsletter.data ?? []), ...unsub.parse(waitlist.data ?? [])]) {
      if (r.unsubscribed_at) out.add(r.email.toLowerCase());
    }
  }
  return out;
}

function chunks<T>(xs: readonly T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/** Ledger rows + reviewed booking ids for these bookings. Throws on any read
 *  error: an unreadable ledger means we cannot know what was already sent. */
async function readState(
  supabase: Supabase,
  bookingIds: string[]
): Promise<{ ledger: ReviewLedgerRow[]; reviewed: Set<string> }> {
  const ledger: ReviewLedgerRow[] = [];
  const reviewed = new Set<string>();
  for (const ids of chunks(bookingIds, IN_CHUNK)) {
    const [l, r] = await Promise.all([
      supabase
        .from("review_emails")
        .select("booking_id, kind, status, sent_at")
        .in("booking_id", ids)
        .abortSignal(dbSignal()),
      supabase.from("booking_reviews").select("booking_id").in("booking_id", ids).abortSignal(dbSignal()),
    ]);
    if (l.error) throw new Error(`review_emails read failed: ${l.error.message}`);
    if (r.error) throw new Error(`booking_reviews read failed: ${r.error.message}`);
    for (const raw of l.data ?? []) {
      const p = ledgerRowSchema.safeParse(raw);
      if (!p.success) throw new Error(`review_emails row failed validation: ${p.error.message}`);
      ledger.push({ bookingId: p.data.booking_id, kind: p.data.kind, status: p.data.status, sentAt: p.data.sent_at });
    }
    for (const raw of r.data ?? []) {
      const p = z.object({ booking_id: z.string() }).safeParse(raw);
      if (!p.success) throw new Error(`booking_reviews row failed validation: ${p.error.message}`);
      reviewed.add(p.data.booking_id);
    }
  }
  return { ledger, reviewed };
}

/** Old `claimed` rows: never-reached-Resend ones are removed (the booking is
 *  judged afresh next run); reached-Resend ones are alarmed for a human. */
async function sweepStaleClaims(supabase: Supabase, nowMs: number): Promise<{ released: number; alarmed: number }> {
  const { data, error } = await supabase
    .from("review_emails")
    .select("id, booking_id, kind, send_started_at")
    .eq("status", "claimed")
    .lt("claimed_at", new Date(nowMs - STALE_CLAIM_MS).toISOString())
    .abortSignal(dbSignal());
  if (error) {
    captureAPIError(new Error(`post-trip-review: stale-claim scan failed: ${error.message}`), {
      ...CTX,
      stage: "stale_claims",
    });
    return { released: -1, alarmed: -1 };
  }
  const rows = z
    .array(z.object({ id: z.string(), booking_id: z.string(), kind: z.string(), send_started_at: z.string().nullable() }))
    .safeParse(data ?? []);
  if (!rows.success) {
    captureAPIError(new Error(`post-trip-review: stale-claim rows failed validation: ${rows.error.message}`), {
      ...CTX,
      stage: "stale_claims",
    });
    return { released: -1, alarmed: -1 };
  }
  const unsent = rows.data.filter((r) => !r.send_started_at).map((r) => r.id);
  let released = 0;
  if (unsent.length > 0) {
    const del = await supabase
      .from("review_emails")
      .delete()
      .in("id", unsent)
      .eq("status", "claimed")
      .is("send_started_at", null)
      .select("id")
      .abortSignal(dbSignal());
    if (del.error) {
      captureAPIError(new Error(`post-trip-review: stale unsent claims not released: ${del.error.message}`), {
        ...CTX,
        stage: "stale_claims",
      });
    } else {
      released = Array.isArray(del.data) ? del.data.length : 0;
    }
  }
  const stuck = rows.data.filter((r) => r.send_started_at);
  const alarmed = stuck.length;
  if (alarmed > 0) {
    alarm(
      "post_trip_review_stale_claims",
      `post-trip-review: ${alarmed} claimed row(s) reached the send step and were never marked — the outcome is unknown (Sentry may hold the run's own error for the row with its intended status). Check Resend by booking id, then set each row to sent, retry, failed or unconfirmed by hand (until then that booking gets no reminder).`,
      "error",
      { rows: stuck.map((r) => ({ id: r.id, bookingId: r.booking_id, kind: r.kind })) }
    );
  }
  return { released, alarmed };
}

/** INSERT a `claimed` row, or on 23505 re-claim a `retry` row. */
async function claimRow(
  supabase: Supabase,
  c: ReviewCandidate,
  nowIso: string,
  live: boolean
): Promise<{ id: string } | "taken" | "error"> {
  const ins = await supabase
    .from("review_emails")
    .insert({
      booking_id: c.bookingId,
      kind: c.kind,
      email: c.email,
      livemode: live,
      status: "claimed",
      claimed_at: nowIso,
      send_started_at: null,
      sent_at: null,
      last_error: null,
    })
    .select("id")
    .abortSignal(dbSignal());
  if (!ins.error) {
    const p = z.array(z.object({ id: z.string() })).length(1).safeParse(ins.data);
    if (p.success) return { id: p.data[0].id };
    captureAPIError(new Error("post-trip-review: claim INSERT returned no id"), { ...CTX, stage: "claim" });
    return "error";
  }
  if (ins.error.code !== "23505") {
    captureAPIError(new Error(`post-trip-review claim failed: ${redact(ins.error.message)}`), {
      ...CTX,
      stage: "claim",
      code: ins.error.code,
    });
    return "error";
  }
  // send_started_at / last_error are KEPT: evidence an earlier attempt reached
  // Resend, so a crash after re-claim is alarmed, never swept.
  const re = await supabase
    .from("review_emails")
    .update({ status: "claimed", claimed_at: nowIso })
    .eq("booking_id", c.bookingId)
    .eq("kind", c.kind)
    .eq("status", "retry")
    .select("id")
    .abortSignal(dbSignal());
  if (re.error) {
    captureAPIError(new Error(`post-trip-review re-claim failed: ${redact(re.error.message)}`), {
      ...CTX,
      stage: "reclaim",
      code: re.error.code,
    });
    return "error";
  }
  const p = z.array(z.object({ id: z.string() })).safeParse(re.data ?? []);
  return p.success && p.data.length === 1 ? { id: p.data[0].id } : "taken";
}

async function markRow(
  supabase: Supabase,
  rowId: string,
  patch: { status: "sent" | "failed" | "retry" | "unconfirmed"; sent_at?: string; last_error?: string | null },
  result: { markFailed: number }
) {
  const { data, error } = await supabase
    .from("review_emails")
    .update(patch)
    .eq("id", rowId)
    .select("id")
    .abortSignal(dbSignal());
  if (error || !Array.isArray(data) || data.length === 0) {
    result.markFailed++;
    captureAPIError(
      new Error(
        `post-trip-review: status '${patch.status}' not recorded for ${rowId} (send error: ${patch.last_error ?? "none"}): ${error?.message ?? "matched no rows"}`
      ),
      { ...CTX, stage: `mark_${patch.status}` }
    );
  }
}

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (process.env.POST_TRIP_REVIEW_EMAILS_ENABLED !== "true") {
    return NextResponse.json({ ok: true, disabled: true });
  }
  try {
    assertReviewSigningSecret();
  } catch (error) {
    captureAPIError(error instanceof Error ? error : new Error(String(error)), { ...CTX, stage: "config" });
    return respond({ ok: false, error: "review signing secret is not configured" }, 503);
  }
  // The email has a book-again button, so it is commercial mail: a postal
  // address in every footer (CAN-SPAM). Never send without one.
  const postalAddress = process.env.TRIPLY_POSTAL_ADDRESS?.trim() ?? "";
  if (!postalAddress) {
    captureAPIError(new Error("post-trip-review: TRIPLY_POSTAL_ADDRESS is not set"), { ...CTX, stage: "config" });
    return respond({ ok: false, error: "postal address is not configured" }, 503);
  }
  // The deployment's mode decides which bookings it may email at all (one
  // shared database for staging and production). A missing or garbled key
  // would otherwise read as "test" and silently send nothing in production.
  const mode = stripeKeyMode();
  if (!mode) {
    captureAPIError(new Error("post-trip-review: STRIPE_SECRET_KEY is missing or not a live/test key"), { ...CTX, stage: "config" });
    return respond({ ok: false, error: "deployment mode is unknown" }, 503);
  }
  try {
    return await run({ postalAddress }, mode === "live");
  } catch (error) {
    return fail("unhandled", errorMessage(error));
  }
}

async function run(footer: ReviewEmailFooter, live: boolean) {
  const nowMs = Date.now();
  const elapsed = () => Date.now() - nowMs;
  const supabase = await createAdminClient();
  const stale = await sweepStaleClaims(supabase, nowMs);

  // check_out is a literal TIMESTAMP; bounding it by two UTC calendar dates
  // (a day of slack each side) never converts the stored value — the
  // selector makes the real, airport-local decision.
  const from = new Date(nowMs - LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10);
  const to = new Date(nowMs + 2 * 86_400_000).toISOString().slice(0, 10);
  let query = supabase
    .from("bookings")
    .select(BOOKING_COLS)
    .in("status", [...REVIEWABLE_STATUSES])
    .gte("check_out", from)
    .lt("check_out", to);
  // .or() is fine on a SELECT (PostgREST rejects it only on UPDATE/DELETE).
  query = live ? query.or("livemode.is.null,livemode.eq.true") : query.eq("livemode", false);
  const { data, error } = await query
    .order("check_out", { ascending: true })
    .limit(ROW_CAP)
    .abortSignal(dbSignal());
  if (error) return fail("bookings_read", `bookings read failed: ${error.message}`);
  const rawRows = data ?? [];
  if (rawRows.length >= ROW_CAP) {
    alarm("post_trip_review_row_cap", `post-trip-review: bookings read hit the ${ROW_CAP}-row cap; some trips may be skipped`, "warning");
  }

  const parsed: z.infer<typeof bookingRowSchema>[] = [];
  let invalidRows = 0;
  for (const raw of rawRows) {
    const p = bookingRowSchema.safeParse(raw);
    if (p.success) parsed.push(p.data);
    else invalidRows++;
  }
  if (invalidRows > 0) {
    captureAPIError(new Error(`post-trip-review: ${invalidRows} bookings row(s) failed validation and were skipped`), {
      ...CTX,
      stage: "bookings_parse",
    });
  }
  if (parsed.length === 0) {
    return respond({ ok: true, live, scanned: rawRows.length, invalidRows, sent: 0, staleClaims: stale });
  }

  let guests: Map<string, Guest>;
  try {
    const pis = [...new Set(parsed.map((r) => r.stripe_payment_intent_id).filter((v): v is string => !!v))];
    guests = await readGuests(supabase, pis);
  } catch (e) {
    return fail("guests_read", errorMessage(e));
  }
  // A booking paid through checkout has a staged payload naming its guest. If
  // that snapshot is missing or malformed, the customers row may be the
  // signed-in account holder, not the guest — skip it (loudly) rather than
  // email the wrong person. The customers row is used only for bookings with
  // no PaymentIntent at all (manual recoveries).
  const noGuest: string[] = [];
  const bookings: ReviewBookingRow[] = [];
  for (const r of parsed) {
    const pi = r.stripe_payment_intent_id;
    const guest = pi ? guests.get(pi) : undefined;
    if (pi && !guest) {
      noGuest.push(r.id);
      continue;
    }
    bookings.push(toBookingRow(r, guest));
  }
  // Most checkout bookings missing a snapshot means the payload shape drifted
  // (guestSchema), not a one-off: every review email would stop. Fail the run.
  const withPi = parsed.filter((r) => r.stripe_payment_intent_id).length;
  const guestDrift = noGuest.length >= 2 && noGuest.length * 2 > withPi;
  if (noGuest.length > 0) {
    alarm(
      "post_trip_review_no_guest_snapshot",
      `post-trip-review: ${noGuest.length} of ${withPi} checkout booking(s) have no readable guest snapshot in pending_bookings and were skipped${guestDrift ? " — most of them: the snapshot shape has likely changed" : ""}`,
      guestDrift ? "error" : "warning",
      { bookingIds: noGuest.slice(0, 50) }
    );
  }

  let state: { ledger: ReviewLedgerRow[]; reviewed: Set<string> };
  let suppressed: Set<string>;
  try {
    state = await readState(supabase, bookings.map((b) => b.id));
    const emails = [
      ...new Set(bookings.map((b) => b.email?.trim().toLowerCase()).filter((v): v is string => !!v)),
    ];
    suppressed = await readSuppressed(supabase, emails);
  } catch (e) {
    return fail("state_read", errorMessage(e));
  }

  const selection = selectReviewSends(bookings, state.ledger, state.reviewed, nowMs, {
    live,
    testLocationIds: TEST_RESLAB_LOCATION_IDS,
    suppressed,
  });
  const { initial, reminder, skipped } = selection;
  const toSend = [...initial, ...reminder];
  if (skipped.retryExpired > 0) {
    alarm(
      "post_trip_review_retry_expired",
      `post-trip-review: ${skipped.retryExpired} email(s) parked for retry aged out of the window and will never be sent`,
      "warning",
      { expired: selection.expiredRetries.slice(0, 50) }
    );
  }

  const result = {
    live,
    scanned: rawRows.length,
    invalidRows,
    noGuestSnapshot: noGuest.length,
    initialCandidates: initial.length,
    reminderCandidates: reminder.length,
    staleClaims: stale,
    sent: 0,
    unconfirmed: 0,
    alreadyClaimed: 0,
    claimFailed: 0,
    sendFailed: 0,
    markFailed: 0,
    deferredToNextRun: 0,
  };

  let attempted = 0;
  // Two consecutive identical rejections (same status AND Resend error name)
  // mean OUR payload or setup, not the addresses: stop before every remaining
  // row is burned as `failed`.
  let lastRejection: { key: string; rowId: string; bookingId: string } | null = null;
  // Two consecutive sends with an unknown outcome mean Resend (or our network)
  // is down: stop rather than mark the whole batch `unconfirmed` for good.
  let uncertainInARow = 0;
  // Why the run stopped before its candidates ran out (a cap is not a stop).
  let stoppedEarly: "build" | "resend_unreachable" | "config" | "systematic_rejection" | null = null;
  for (const [i, c] of toSend.entries()) {
    if (attempted >= MAX_SENDS_PER_RUN || elapsed() + CANDIDATE_RESERVE_MS > RUN_DEADLINE_MS) {
      result.deferredToNextRun = toSend.length - i;
      break;
    }

    // Build BEFORE claiming: a fault here (bad NEXT_PUBLIC_APP_URL, a secret)
    // is ours, sends nothing, and would fail for every row — stop the run.
    let built: BuiltReviewEmail;
    try {
      built = buildReviewEmail(c, footer);
    } catch (error) {
      captureAPIError(new Error(`post-trip-review: email build failed: ${redact(errorMessage(error))}`), {
        ...CTX,
        stage: "build",
      });
      result.sendFailed++;
      result.deferredToNextRun += toSend.length - i;
      stoppedEarly = "build";
      break;
    }

    const claim = await claimRow(supabase, c, new Date().toISOString(), live);
    if (claim === "taken") {
      result.alreadyClaimed++;
      continue;
    }
    if (claim === "error") {
      result.claimFailed++;
      continue;
    }
    const rowId = claim.id;
    attempted++;

    const started = await supabase
      .from("review_emails")
      .update({ send_started_at: new Date().toISOString() })
      .eq("id", rowId)
      .select("id")
      .abortSignal(dbSignal());
    if (started.error || !Array.isArray(started.data) || started.data.length === 0) {
      // Nothing was sent: the row goes back to `retry` for the next run.
      result.claimFailed++;
      captureAPIError(
        new Error(`post-trip-review: send_started_at not recorded for ${rowId}: ${started.error?.message ?? "matched no rows"}`),
        { ...CTX, stage: "send_start" }
      );
      await markRow(supabase, rowId, { status: "retry", last_error: "send_started_at write failed" }, result);
      continue;
    }

    try {
      await sendReviewEmail(c, built);
    } catch (error) {
      const message = redact(errorMessage(error)).slice(0, 500);
      const kind = classifySendFailure(error);
      if (kind === "uncertain") {
        result.unconfirmed++;
        uncertainInARow++;
        alarm(
          "post_trip_review_unconfirmed",
          `post-trip-review: ${c.kind} send for booking ${c.bookingId} has an unknown outcome (the email may be out); marked unconfirmed — check Resend, it will not be retried`,
          "warning",
          { rowId, bookingId: c.bookingId, kind: c.kind, error: message }
        );
        await markRow(supabase, rowId, { status: "unconfirmed", last_error: message }, result);
        lastRejection = null;
        if (uncertainInARow >= 2) {
          result.deferredToNextRun += toSend.length - i - 1;
          alarm(
            "post_trip_review_resend_unreachable",
            `post-trip-review: two sends in a row had an unknown outcome; run stopped (Resend or the network is likely down)`,
            "error",
            { lastError: message }
          );
          stoppedEarly = "resend_unreachable";
          break;
        }
        continue;
      }
      uncertainInARow = 0;
      captureAPIError(new Error(`post-trip-review send failed: ${message}`), { ...CTX, stage: "send" });
      result.sendFailed++;
      if (kind === "config") {
        // Not this row's fault, and every later send would fail the same way.
        await markRow(supabase, rowId, { status: "retry", last_error: message }, result);
        result.deferredToNextRun += toSend.length - i - 1;
        stoppedEarly = "config";
        break;
      }
      if (kind === "retry") {
        await markRow(supabase, rowId, { status: "retry", last_error: message }, result);
        lastRejection = null;
        continue;
      }
      const key =
        error instanceof ReviewSendError ? `${error.statusCode ?? "?"}/${error.resendName ?? "?"}` : "?/?";
      if (lastRejection && lastRejection.key === key) {
        // Same rejection twice in a row: put both rows back for a later run.
        await markRow(supabase, rowId, { status: "retry", last_error: message }, result);
        await markRow(supabase, lastRejection.rowId, { status: "retry", last_error: message }, result);
        result.deferredToNextRun += toSend.length - i - 1;
        alarm(
          "post_trip_review_systematic_rejection",
          `post-trip-review: Resend rejected two emails in a row with ${key}; run stopped and both rows set to retry — likely a problem with our payload or sender setup (if both addresses are genuinely bad, set the rows to failed by hand)`,
          "error",
          {
            error: message,
            rows: [
              { rowId: lastRejection.rowId, bookingId: lastRejection.bookingId },
              { rowId, bookingId: c.bookingId },
            ],
          }
        );
        stoppedEarly = "systematic_rejection";
        break;
      }
      await markRow(supabase, rowId, { status: "failed", last_error: message }, result);
      lastRejection = { key, rowId, bookingId: c.bookingId };
      continue;
    }

    lastRejection = null;
    uncertainInARow = 0;
    await markRow(supabase, rowId, { status: "sent", sent_at: new Date().toISOString(), last_error: null }, result);
    result.sent++;
  }

  if (result.deferredToNextRun > 0) {
    alarm(
      "post_trip_review_capped",
      `post-trip-review: ${result.deferredToNextRun} email(s) deferred to the next run (cap ${MAX_SENDS_PER_RUN} / ${RUN_DEADLINE_MS} ms deadline, or the run stopped early)`,
      "warning"
    );
  }
  // A run that sent nothing because it stopped early, or because the guest
  // snapshots drifted, is a failed run — 500 + ok:false, not a quiet day.
  const allFailed =
    (attempted + result.claimFailed > 0 && result.sent === 0 && result.unconfirmed === 0) ||
    (stoppedEarly !== null && result.sent === 0) ||
    guestDrift;
  if (result.sendFailed + result.claimFailed + result.markFailed > 0) {
    alarm(
      "post_trip_review_failures",
      `post-trip-review: ${result.sendFailed} send / ${result.claimFailed} claim / ${result.markFailed} mark failure(s); ${result.sent} sent`,
      allFailed ? "error" : "warning"
    );
  }
  return respond({ ok: !allFailed, stoppedEarly, guestDrift, ...result, skipped }, allFailed ? 500 : 200);
}
