import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { createAdminClient } from "@/lib/supabase/server";
import { stripe } from "@/lib/stripe/client";
import { reslab } from "@/lib/reslab/client";
import { BLOCKED_RESLAB_LOCATION_IDS } from "@/lib/reslab/search";
import { resolveAirportCode } from "@/lib/attribution/airport";
import { captureAPIError } from "@/lib/sentry";
import {
  assertWaitlistSigningSecret,
  isWaitlistConfigError,
} from "@/lib/waitlist/unsubscribe-token";
import { recoveryUnsubscribeUrl } from "@/lib/checkout-recovery/unsubscribe-token";
import {
  RECOVERY_MAX_AGE_MS,
  selectRecoveryCandidates,
  storedTripKey,
  type PaymentIntentLike,
  type RecoveryCandidate,
} from "@/lib/checkout-recovery/select";
import {
  isTransientSendFailure,
  sendRecoveryEmail,
  RESEND_SEND_TIMEOUT_MS,
  type RecoveryLotInfo,
} from "@/lib/checkout-recovery/email";

/**
 * GET /api/cron/checkout-recovery
 *
 * Every 15 minutes (vercel.json): one "you didn't finish booking" email to a
 * customer who reached the payment step 45 min – 24 h ago and never got a card
 * through, when
 *   - the check-in has not passed (see select.ts),
 *   - THE SAME TRIP (lot + dates + times) was not attempted or booked by
 *     anyone, before or after — another PaymentIntent past the payment form
 *     (select.ts), a bookings row in the last 30 days, or a pending_bookings
 *     row (Pay Now was clicked) — checkout mints a new PaymentIntent on every
 *     re-entry, so an abandoned one next to a paid one for the same trip is
 *     the NORMAL shape of a successful booking, not an abandonment,
 *   - the same lowercased address has not paid / booked since,
 *   - the address has not opted out (this email, the newsletter, or the
 *     waitlist), and
 *   - the address has not had a recovery email in the last 7 days.
 *
 * DATA SOURCE: Stripe PaymentIntents, not pending_bookings. pending_bookings
 * is staged only when Pay Now is clicked, so the customer who never clicked it
 * — the case this exists for — has no row; the PaymentIntent created at the
 * payment step (POST /api/checkout/lot) is the only durable record.
 *
 * IDEMPOTENCY: a checkout_recovery_emails row is INSERTed (UNIQUE on the
 * PaymentIntent) BEFORE the send, and the send itself carries a Resend
 * Idempotency-Key on the PaymentIntent. A retried or overlapping run hits
 * 23505 and skips; a lost Resend response retried next tick cannot send twice.
 * Failure modes all err toward NOT emailing: a crash after the claim leaves
 * the row (alarmed below) and no email.
 *
 * TIME: maxDuration 60. Every external call is bounded (Stripe 15 s per page,
 * Supabase 3 s, ResLab its own 10 s, Resend 10 s) and a candidate is only
 * started when its worst case still fits before the deadline — a function
 * killed mid-send would leave a `claimed` row with the email possibly out,
 * and no catch block runs on a timeout.
 *
 * Gated by CHECKOUT_RECOVERY_EMAILS_ENABLED=true so the code can merge dark.
 * Needs TRIPLY_POSTAL_ADDRESS (commercial mail must carry one) and
 * WAITLIST_SIGNING_SECRET (unsubscribe links); refuses with 503 without them.
 * Auth: Vercel injects `Authorization: Bearer <CRON_SECRET>`; refuse without it.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Bounded per run; a 15-minute cadence drains any backlog quickly. */
const MAX_SENDS_PER_RUN = 25;
/** The run must have returned by here — well inside maxDuration. */
const RUN_DEADLINE_MS = 50_000;
/** Deadline for one Supabase call (the project-wide 3 s for best-effort writes). */
const DB_TIMEOUT_MS = 3_000;
/** reslabFetch's own per-call timeout (src/lib/reslab/client.ts). */
const RESLAB_LOOKUP_MS = 10_000;
/** Worst case for one candidate: claim + ResLab lookup + Resend + mark. A
 *  candidate is started only when this still fits before the deadline. */
const CANDIDATE_RESERVE_MS = DB_TIMEOUT_MS * 2 + RESLAB_LOOKUP_MS + RESEND_SEND_TIMEOUT_MS;
/** At most one recovery email per address in this window. */
export const PER_EMAIL_CAP_MS = 7 * 24 * 60 * 60_000;
/** A booking for the same trip in this window means it is handled. */
const BOOKED_TRIP_LOOKBACK_MS = 30 * 24 * 60 * 60_000;
/** A `claimed` row older than this is a crash between claim and mark — the
 *  email may or may not be out, and nothing will retry it. Ops must look. */
const STALE_CLAIM_MS = 15 * 60_000;
/** Stripe request timeout for the PaymentIntent list (per page). */
const STRIPE_TIMEOUT_MS = 15_000;

/** A fresh deadline for one Supabase call — every call gets its own. */
const dbSignal = () => AbortSignal.timeout(DB_TIMEOUT_MS);

const CTX = { endpoint: "/api/cron/checkout-recovery", method: "GET" as const };

type Supabase = Awaited<ReturnType<typeof createAdminClient>>;

/** Customer addresses never go to Sentry or the ledger's last_error. */
function redact(s: string): string {
  return s.replace(/[^\s@<>()"',;]+@[^\s@<>()"',;]+/g, "[email]");
}

function alarm(fingerprint: string, message: string, level: "info" | "warning" | "error") {
  Sentry.withScope((scope) => {
    scope.setFingerprint([fingerprint]);
    Sentry.captureMessage(message, level);
  });
}

function fail(stage: string, message: string) {
  captureAPIError(new Error(`checkout-recovery: ${redact(message)}`), { ...CTX, stage });
  return NextResponse.json({ ok: false, error: redact(message) }, { status: 500 });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Lot name + airport for the email. One ResLab call per email actually sent
 *  (reslabFetch bounds it). A failure here degrades the COPY ("the parking
 *  you picked"), never the send — and is reported, not swallowed. */
async function lookupLot(locationId: number): Promise<RecoveryLotInfo> {
  try {
    const loc = await reslab.getLocation(locationId);
    return {
      name: loc.name?.trim() || null,
      airportCode: resolveAirportCode({ lat: loc.latitude, lng: loc.longitude }),
    };
  } catch (error) {
    captureAPIError(error instanceof Error ? error : new Error(String(error)), {
      ...CTX,
      stage: "lot_lookup",
      extra: { locationId },
    });
    return { name: null, airportCode: null };
  }
}

/** Emails (lowercased) that must not be emailed: opted out of this email, the
 *  newsletter, or the waitlist. Throws on any read error — an unreadable
 *  opt-out list means we cannot honour it, so nobody gets emailed this run. */
async function suppressedEmails(supabase: Supabase, emails: string[]): Promise<Set<string>> {
  const out = new Set<string>();

  const optouts = await supabase
    .from("checkout_recovery_optouts")
    .select("email")
    .in("email", emails)
    .abortSignal(dbSignal());
  if (optouts.error) throw new Error(`optouts read failed: ${optouts.error.message}`);
  for (const r of (optouts.data ?? []) as Array<{ email: string }>) out.add(r.email.toLowerCase());

  for (const table of ["newsletter_subscribers", "booking_waitlist"] as const) {
    const res = await supabase
      .from(table)
      .select("email, unsubscribed_at")
      .in("email", emails)
      .abortSignal(dbSignal());
    if (res.error) throw new Error(`${table} read failed: ${res.error.message}`);
    for (const r of (res.data ?? []) as Array<{ email: string; unsubscribed_at: string | null }>) {
      if (r.unsubscribed_at) out.add(r.email.toLowerCase());
    }
  }
  return out;
}

function embeddedEmail(r: { customers: unknown }): string | null {
  // PostgREST returns the many-to-one embed as an object; the untyped client
  // infers an array. Accept both rather than cast.
  const cust = (Array.isArray(r.customers) ? r.customers[0] : r.customers) as
    | { email?: unknown }
    | null
    | undefined;
  const raw = cust?.email;
  return typeof raw === "string" && raw.trim() ? raw.trim().toLowerCase() : null;
}

/**
 * Candidates whose trip is already BOOKED: a bookings row for the same
 * location + literal check-in/check-out in the last 30 days (any email, any
 * order — the booking may predate the abandoned re-entry), or a booking by
 * the same address at/after the abandoned checkout (a PaymentIntent created
 * BEFORE the abandoned one but paid after, e.g. two tabs, which the
 * Stripe-side ordering check in select.ts cannot see).
 */
async function bookedTrips(
  supabase: Supabase,
  candidates: RecoveryCandidate[],
  nowMs: number
): Promise<Set<string>> {
  const { data, error } = await supabase
    .from("bookings")
    .select("reslab_location_id, check_in, check_out, created_at, customers!inner(email)")
    .gte("created_at", new Date(nowMs - BOOKED_TRIP_LOOKBACK_MS).toISOString())
    .abortSignal(dbSignal());
  if (error) throw new Error(`bookings read failed: ${error.message}`);

  const trips = new Set<string>();
  const latestByEmail = new Map<string, number>();
  for (const r of (data ?? []) as Array<{
    reslab_location_id: unknown;
    check_in: unknown;
    check_out: unknown;
    created_at: unknown;
    customers: unknown;
  }>) {
    const key = storedTripKey(String(r.reslab_location_id), r.check_in, r.check_out);
    if (key) trips.add(key);
    const email = embeddedEmail(r);
    if (!email) continue;
    const at = Date.parse(String(r.created_at));
    if ((latestByEmail.get(email) ?? 0) < at) latestByEmail.set(email, at);
  }

  const out = new Set<string>();
  for (const c of candidates) {
    if (trips.has(c.storedTrip)) {
      out.add(c.paymentIntentId);
      continue;
    }
    const at = latestByEmail.get(c.email);
    if (at !== undefined && at >= c.createdMs) out.add(c.paymentIntentId);
  }
  return out;
}

/**
 * Candidates whose trip reached Pay Now: a pending_bookings row staged at/after
 * the abandoned checkout for the same trip or by the same address (whatever
 * became of it — a declined retry, a sold-out release, a booking in flight),
 * or the candidate's OWN row in any state past `pending` / `expired` (its
 * PaymentIntent got a card through at some point even though Stripe now
 * reports requires_payment_method — never chase that).
 */
async function pendingTrips(
  supabase: Supabase,
  candidates: RecoveryCandidate[]
): Promise<Set<string>> {
  const earliest = Math.min(...candidates.map((c) => c.createdMs));
  const since = await supabase
    .from("pending_bookings")
    .select("stripe_payment_intent_id, location_id, from_date, to_date, status, created_at, customer")
    .gte("created_at", new Date(earliest).toISOString())
    .abortSignal(dbSignal());
  if (since.error) throw new Error(`pending_bookings read failed: ${since.error.message}`);

  const own = await supabase
    .from("pending_bookings")
    .select("stripe_payment_intent_id, status")
    .in("stripe_payment_intent_id", candidates.map((c) => c.paymentIntentId))
    .abortSignal(dbSignal());
  if (own.error) throw new Error(`pending_bookings (own) read failed: ${own.error.message}`);

  type PendingRow = {
    stripe_payment_intent_id: unknown;
    location_id?: unknown;
    from_date?: unknown;
    to_date?: unknown;
    status: unknown;
    created_at?: unknown;
    customer?: unknown;
  };
  const staged: Array<{ pi: string; trip: string | null; email: string | null; createdMs: number }> = [];
  for (const r of (since.data ?? []) as PendingRow[]) {
    const cust = (r.customer ?? null) as { email?: unknown } | null;
    const rawEmail = cust?.email;
    staged.push({
      pi: String(r.stripe_payment_intent_id),
      trip: storedTripKey(String(r.location_id), r.from_date, r.to_date),
      email: typeof rawEmail === "string" && rawEmail.trim() ? rawEmail.trim().toLowerCase() : null,
      createdMs: Date.parse(String(r.created_at)),
    });
  }
  const ownStatus = new Map<string, string>();
  for (const r of (own.data ?? []) as PendingRow[]) {
    ownStatus.set(String(r.stripe_payment_intent_id), String(r.status));
  }

  const out = new Set<string>();
  for (const c of candidates) {
    const status = ownStatus.get(c.paymentIntentId);
    if (status !== undefined && status !== "pending" && status !== "expired") {
      out.add(c.paymentIntentId);
      continue;
    }
    for (const s of staged) {
      // The candidate's own row is judged by its status above: a declined
      // card leaves it `pending`/`expired`, which is exactly an abandonment.
      if (s.pi === c.paymentIntentId) continue;
      if (s.createdMs < c.createdMs) continue;
      if (s.trip === c.storedTrip || (s.email !== null && s.email === c.email)) {
        out.add(c.paymentIntentId);
        break;
      }
    }
  }
  return out;
}

/** Emails that already got (or are being sent) a recovery email within the
 *  7-day cap, in THIS Stripe mode (staging shares the DB). */
async function recentlyEmailed(
  supabase: Supabase,
  emails: string[],
  livemode: boolean,
  nowMs: number
): Promise<Set<string>> {
  const { data, error } = await supabase
    .from("checkout_recovery_emails")
    .select("email")
    .in("email", emails)
    .eq("livemode", livemode)
    .gte("created_at", new Date(nowMs - PER_EMAIL_CAP_MS).toISOString())
    .abortSignal(dbSignal());
  if (error) throw new Error(`send ledger read failed: ${error.message}`);
  return new Set(((data ?? []) as Array<{ email: string }>).map((r) => r.email));
}

/** `claimed` rows nobody will ever touch again: a crash (or function timeout)
 *  between claim and mark. Reported, never auto-released — the email may be
 *  out, so a retry could double-send. Returns the count for the response. */
async function alarmStaleClaims(supabase: Supabase, nowMs: number): Promise<number> {
  const { data, error } = await supabase
    .from("checkout_recovery_emails")
    .select("id")
    .eq("status", "claimed")
    .lt("created_at", new Date(nowMs - STALE_CLAIM_MS).toISOString())
    .abortSignal(dbSignal());
  if (error) {
    captureAPIError(new Error(`checkout-recovery: stale-claim scan failed: ${error.message}`), {
      ...CTX,
      stage: "stale_claims",
    });
    return -1;
  }
  const n = (data ?? []).length;
  if (n > 0) {
    alarm(
      "checkout_recovery_stale_claims",
      `checkout-recovery: ${n} claimed row(s) older than ${STALE_CLAIM_MS / 60_000} min — crash between claim and mark; check Resend for whether the email went out, then mark the row sent or failed by hand`,
      "warning"
    );
  }
  return n;
}

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (process.env.CHECKOUT_RECOVERY_EMAILS_ENABLED !== "true") {
    return NextResponse.json({ ok: true, disabled: true });
  }

  // Every email carries an unsubscribe link and a postal address; without
  // either none can be sent. Refuse up front (503) rather than claim rows
  // that can never send.
  const postalAddress = process.env.TRIPLY_POSTAL_ADDRESS?.trim() ?? "";
  if (!postalAddress) {
    captureAPIError(new Error("checkout-recovery: TRIPLY_POSTAL_ADDRESS is not set"), {
      ...CTX,
      stage: "config",
    });
    return NextResponse.json(
      { ok: false, error: "postal address is not configured" },
      { status: 503 }
    );
  }
  try {
    assertWaitlistSigningSecret();
  } catch (error) {
    captureAPIError(error instanceof Error ? error : new Error(String(error)), {
      ...CTX,
      stage: "config",
    });
    return NextResponse.json(
      { ok: false, error: "signing secret is not configured" },
      { status: 503 }
    );
  }

  const nowMs = Date.now();
  const startedAt = nowMs;
  const elapsed = () => Date.now() - startedAt;

  // 1) Every PaymentIntent created in the last 24 h (auto-paginates; a few
  //    dozen a day). Non-abandoned ones are needed too — they are the
  //    "this trip was attempted / paid" evidence.
  const pis: PaymentIntentLike[] = [];
  try {
    for await (const pi of stripe.paymentIntents.list(
      {
        created: { gte: Math.floor((nowMs - RECOVERY_MAX_AGE_MS) / 1000) },
        limit: 100,
      },
      { timeout: STRIPE_TIMEOUT_MS }
    )) {
      pis.push(pi);
    }
  } catch (error) {
    return fail("stripe_list", `Stripe PaymentIntent list failed: ${errorMessage(error)}`);
  }

  const { candidates: selected, skipped } = selectRecoveryCandidates(pis, nowMs, {
    blockedLocationIds: BLOCKED_RESLAB_LOCATION_IDS,
  });

  const supabase = await createAdminClient();
  const staleClaims = await alarmStaleClaims(supabase, nowMs);

  if (selected.length === 0) {
    return NextResponse.json({ ok: true, scanned: pis.length, candidates: 0, sent: 0, staleClaims, skipped });
  }

  const emails = [...new Set(selected.map((c) => c.email))];

  // 2) Exclusions that need the database. Any read failure fails the run
  //    CLOSED — sending past an unreadable opt-out list, or to a trip that
  //    is booked, is the one mistake this cron must not make.
  let suppressed: Set<string>;
  let booked: Set<string>;
  let pending: Set<string>;
  let capped: Set<string>;
  try {
    suppressed = await suppressedEmails(supabase, emails);
    booked = await bookedTrips(supabase, selected, nowMs);
    pending = await pendingTrips(supabase, selected);
    // Every PaymentIntent in one list call comes from the same Stripe key.
    capped = await recentlyEmailed(supabase, emails, selected[0].livemode, nowMs);
  } catch (error) {
    return fail("exclusions", errorMessage(error));
  }

  const toSend = selected.filter(
    (c) =>
      !suppressed.has(c.email) &&
      !booked.has(c.paymentIntentId) &&
      !pending.has(c.paymentIntentId) &&
      !capped.has(c.email)
  );

  const result = {
    scanned: pis.length,
    candidates: selected.length,
    suppressed: selected.filter((c) => suppressed.has(c.email)).length,
    bookedTrip: selected.filter((c) => booked.has(c.paymentIntentId)).length,
    pendingTrip: selected.filter((c) => pending.has(c.paymentIntentId)).length,
    cappedWithin7d: selected.filter((c) => capped.has(c.email)).length,
    staleClaims,
    sent: 0,
    alreadyClaimed: 0,
    claimFailed: 0,
    sendFailed: 0,
    markFailed: 0,
    deferredToNextRun: 0,
  };

  let attempted = 0;
  for (const c of toSend) {
    // Start a candidate only when its worst case still fits before the
    // deadline: nothing here may be cut off by the function timeout.
    if (attempted >= MAX_SENDS_PER_RUN || elapsed() + CANDIDATE_RESERVE_MS > RUN_DEADLINE_MS) {
      result.deferredToNextRun++;
      continue;
    }

    // 3) Claim BEFORE sending. UNIQUE(stripe_payment_intent_id) is the lock.
    const claim = await supabase
      .from("checkout_recovery_emails")
      .insert({
        stripe_payment_intent_id: c.paymentIntentId,
        email: c.email,
        livemode: c.livemode,
        status: "claimed",
      })
      .select("id")
      .abortSignal(dbSignal())
      .single();
    if (claim.error) {
      if (claim.error.code === "23505") {
        result.alreadyClaimed++;
      } else {
        result.claimFailed++;
        captureAPIError(new Error(`checkout-recovery claim failed: ${redact(claim.error.message)}`), {
          ...CTX,
          stage: "claim",
          code: claim.error.code,
        });
      }
      continue;
    }
    const rowId = (claim.data as { id: string }).id;
    attempted++;

    try {
      const lot = await lookupLot(c.locationId);
      await sendRecoveryEmail(c, lot, recoveryUnsubscribeUrl(rowId), postalAddress);
    } catch (error) {
      const message = redact(errorMessage(error));
      captureAPIError(new Error(`checkout-recovery send failed: ${message}`), { ...CTX, stage: "send" });
      result.sendFailed++;
      if (isWaitlistConfigError(error)) {
        // Env changed under a running instance — not this row's fault.
        await releaseClaim(supabase, rowId);
        break;
      }
      if (isTransientSendFailure(error)) {
        // Release so the next tick retries while the checkout is still fresh;
        // the Resend idempotency key makes a retry after a lost response safe.
        await releaseClaim(supabase, rowId);
      } else {
        // Permanent (bad / suppressed address): keep the row so it never retries.
        const { error: markErr } = await supabase
          .from("checkout_recovery_emails")
          .update({ status: "failed", last_error: message.slice(0, 500) })
          .eq("id", rowId)
          .abortSignal(dbSignal());
        if (markErr) {
          captureAPIError(new Error(`checkout-recovery: mark failed: ${markErr.message}`), {
            ...CTX,
            stage: "mark_failed",
          });
        }
      }
      continue;
    }

    // The email is out. A failed status write leaves the row `claimed`, which
    // still blocks any resend — bookkeeping only, but reported (and the
    // stale-claim alarm will keep pointing at it).
    const { data: marked, error: markErr } = await supabase
      .from("checkout_recovery_emails")
      .update({ status: "sent", sent_at: new Date().toISOString() })
      .eq("id", rowId)
      .select("id")
      .abortSignal(dbSignal());
    if (markErr || !Array.isArray(marked) || marked.length === 0) {
      result.markFailed++;
      captureAPIError(
        new Error(`checkout-recovery: sent but status not recorded for ${rowId}: ${markErr?.message ?? "matched no rows"}`),
        { ...CTX, stage: "mark_sent" }
      );
    }
    result.sent++;
  }

  if (result.deferredToNextRun > 0) {
    alarm(
      "checkout_recovery_capped",
      `checkout-recovery: ${result.deferredToNextRun} candidate(s) deferred to the next run (cap ${MAX_SENDS_PER_RUN} / ${RUN_DEADLINE_MS}ms deadline)`,
      "warning"
    );
  }

  // Nothing went out although we tried: an outage or a broken write path.
  // Loud, non-2xx, so Vercel's cron alerting sees it.
  const allFailed = attempted + result.claimFailed > 0 && result.sent === 0;
  if (result.sendFailed + result.claimFailed + result.markFailed > 0) {
    alarm(
      "checkout_recovery_failures",
      `checkout-recovery: ${result.sendFailed} send / ${result.claimFailed} claim / ${result.markFailed} mark failure(s); ${result.sent} sent`,
      allFailed ? "error" : "warning"
    );
    await Sentry.flush(2000).catch(() => {});
  }

  return NextResponse.json(
    { ok: !allFailed, ...result, skipped },
    { status: allFailed ? 500 : 200 }
  );
}

/** Delete a claim so the checkout can be retried. A failed delete leaves the
 *  row `claimed` — no retry, no duplicate — and is reported. */
async function releaseClaim(supabase: Supabase, rowId: string) {
  const { error } = await supabase
    .from("checkout_recovery_emails")
    .delete()
    .eq("id", rowId)
    .abortSignal(dbSignal());
  if (error) {
    captureAPIError(new Error(`checkout-recovery: could not release claim ${rowId}: ${error.message}`), {
      ...CTX,
      stage: "release_claim",
    });
  }
}
