import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { format } from "date-fns";
import { TZDate } from "@date-fns/tz";
import { createAdminClient } from "@/lib/supabase/server";
import { stripe } from "@/lib/stripe/client";
import { reslab, ReslabError, type ReslabLocation } from "@/lib/reslab/client";
import { BLOCKED_RESLAB_LOCATION_IDS, getChannelLocationsNoSweep } from "@/lib/reslab/search";
import { resolveAirportCode } from "@/lib/attribution/airport";
import { getAirportByCode } from "@/config/airports";
import { convertTo24Hour, isValidTimeZone, SAME_DAY_LEAD_MINUTES } from "@/lib/utils/time";
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
  isIdempotencyConflict,
  isSendConfigFailure,
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
 *   - the check-in has not passed and clears the lot's own notice period,
 *   - THE SAME TRIP (lot + dates + times) was not attempted or booked by
 *     anyone, before or after — another PaymentIntent past the payment form
 *     (select.ts), a bookings row in the last 30 days, or a pending_bookings
 *     row (Pay Now was clicked) — checkout mints a new PaymentIntent on every
 *     re-entry, so an abandoned one next to a paid one for the same trip is
 *     the NORMAL shape of a successful booking, not an abandonment,
 *   - it is the NEWEST PaymentIntent for its trip and its address (select.ts),
 *   - the same address has not paid since, and has not paid or booked at the
 *     SAME LOT in the window (a date-change attempt),
 *   - the address has not opted out (this email, the newsletter, or the
 *     waitlist), and
 *   - the address has not had a recovery email in the last 7 days.
 *
 * DATA SOURCE: Stripe PaymentIntents, not pending_bookings. pending_bookings
 * is staged only when Pay Now is clicked, so the customer who never clicked it
 * — the case this exists for — has no row; the PaymentIntent created at the
 * payment step (POST /api/checkout/lot) is the only durable record.
 *
 * LEDGER (checkout_recovery_emails, UNIQUE on the PaymentIntent):
 *   claimed → sent | failed | retry → (re-claimed) claimed → …
 * A row is INSERTed `claimed` BEFORE the send, `send_started_at` is stamped
 * right before the Resend call, and a transient failure parks the row as
 * `retry` — NEVER deleted, because the email may have been delivered and
 * its unsubscribe link (keyed on the PaymentIntent) must keep resolving. The
 * next tick re-claims a `retry` row with a conditional UPDATE. A `claimed`
 * row that is old and never reached Resend (send_started_at NULL — a crash
 * or a claim that committed after its timeout) is removed by the cron; one
 * that did reach Resend is alarmed for a human. The send carries a Resend
 * Idempotency-Key on the PaymentIntent with a byte-stable payload, so a
 * retry after a lost response replays the original answer; a Resend 409
 * means an email under this key may be out and is recorded as sent.
 * Failure modes all err toward NOT emailing.
 *
 * TIME: maxDuration 60. Every external call is bounded (Stripe 15 s per page
 * with retries off and a 10 s list budget, Supabase 3 s each and the
 * exclusion reads in parallel, the snapshot read 5 s, a live ResLab lookup
 * raced at 8 s, Resend raced at 10 s); the loop is entered only with room
 * for one full candidate and a candidate is started only when its worst
 * case still fits before the 52 s deadline — a function killed mid-send
 * would leave a `claimed` row with the email possibly out, and no catch
 * block runs on a timeout.
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
const RUN_DEADLINE_MS = 52_000;
/** Deadline for one Supabase call (the project-wide 3 s for best-effort writes). */
const DB_TIMEOUT_MS = 3_000;
/** A live ResLab `/locations/{id}` (only when the snapshot has no row) is
 *  raced here; reslabFetch's own 10 s sits behind a token fetch that can add
 *  another 10–20 s on a cold instance, so we never wait for it. */
const RESLAB_LOOKUP_MS = 8_000;
/** Worst case for one candidate: lot lookup + claim INSERT + re-claim UPDATE
 *  + send-start stamp + Resend + mark. A candidate is started only when
 *  this still fits before the deadline. */
const CANDIDATE_RESERVE_MS = RESLAB_LOOKUP_MS + DB_TIMEOUT_MS * 4 + RESEND_SEND_TIMEOUT_MS;
/** At most one recovery email per address in this window. */
export const PER_EMAIL_CAP_MS = 7 * 24 * 60 * 60_000;
/** A booking or a Pay-Now attempt for the same trip in this window means it
 *  is handled. */
const TRIP_LOOKBACK_MS = 30 * 24 * 60 * 60_000;
/** A `claimed` row older than this will never be finished by its run. */
const STALE_CLAIM_MS = 15 * 60_000;
/** bookings.status values that mean the customer still holds the spot
 *  (migration 003: confirmed | cancelled | completed | payment_failed |
 *  disputed | refunded). */
const LIVE_BOOKING_STATUSES = ["confirmed", "disputed", "completed"];
/** The shared location snapshot's own read deadline
 *  (SNAPSHOT_READ_TIMEOUT_MS in src/lib/reslab/location-snapshot.ts). */
const SNAPSHOT_WARM_MS = 5_000;
/** Stripe request timeout for the PaymentIntent list (per page, no retries)
 *  and the budget for the whole iteration (checked between rows, so the
 *  true worst case is budget + one page). */
const STRIPE_TIMEOUT_MS = 15_000;
const STRIPE_LIST_BUDGET_MS = 10_000;

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

/** Every exit flushes: on a serverless runtime an un-flushed alarm on a run
 *  that sent nothing (the common case for the stale-claim warning) is lost. */
async function respond(body: Record<string, unknown>, status = 200) {
  await Sentry.flush(2000).catch(() => {});
  return NextResponse.json(body, { status });
}

function fail(stage: string, message: string) {
  captureAPIError(new Error(`checkout-recovery: ${redact(message)}`), { ...CTX, stage });
  return respond({ ok: false, error: redact(message) }, 500);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface ResolvedLot extends RecoveryLotInfo {
  /** ResLab reported the location gone (404): never link to it. */
  gone: boolean;
  /** The lot's own zone and notice period when known — the check-in gate. */
  timeZone: string | null;
  hoursBeforeReservation: number | null;
}

function lotInfo(loc: Pick<ReslabLocation, "name" | "latitude" | "longitude" | "timezone" | "hours_before_reservation">): ResolvedLot {
  const airportCode = resolveAirportCode({ lat: loc.latitude, lng: loc.longitude });
  const lotZone = loc.timezone?.code;
  const airportZone = airportCode ? getAirportByCode(airportCode)?.timezone : undefined;
  return {
    name: loc.name?.trim() || null,
    airportCode,
    gone: false,
    timeZone: isValidTimeZone(lotZone) ? lotZone : isValidTimeZone(airportZone) ? airportZone : null,
    hoursBeforeReservation: Number.isFinite(loc.hours_before_reservation) ? loc.hours_before_reservation : null,
  };
}

const UNKNOWN_LOT: ResolvedLot = { name: null, airportCode: null, gone: false, timeZone: null, hoursBeforeReservation: null };

/**
 * Lot name, airport, zone and notice period for one candidate. From the
 * shared location snapshot when it holds the lot (0 ResLab calls, and the
 * same name on every retry so the Resend idempotency payload stays stable);
 * otherwise ONE live lookup raced at RESLAB_LOOKUP_MS. A failure degrades
 * the COPY ("the parking you picked") and falls back to the conservative
 * check-in gate already applied in select.ts — reported, never swallowed.
 * A ResLab 404 is `gone`: the email would link to a lot that no longer
 * exists, so the candidate is skipped.
 */
async function lookupLot(
  locationId: number,
  snapshot: ReadonlyMap<number, ReslabLocation>
): Promise<ResolvedLot> {
  const fromSnapshot = snapshot.get(locationId);
  if (fromSnapshot) return lotInfo(fromSnapshot);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`ResLab location lookup did not answer within ${RESLAB_LOOKUP_MS} ms`)), RESLAB_LOOKUP_MS);
  });
  try {
    const loc = await Promise.race([reslab.getLocation(locationId), timeout]);
    return lotInfo(loc);
  } catch (error) {
    if (error instanceof ReslabError && error.statusCode === 404) {
      return { ...UNKNOWN_LOT, gone: true };
    }
    captureAPIError(error instanceof Error ? error : new Error(String(error)), {
      ...CTX,
      stage: "lot_lookup",
      extra: { locationId },
    });
    return UNKNOWN_LOT;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Can this check-in still be booked at this lot? ResLab refuses a check-in
 * that is not at least `hours_before_reservation` ahead in the LOT's own
 * time (and never one in the past there). Only "now" is projected into the
 * zone; the check-in is compared as the literal "YYYY-MM-DD HH:mm" it is.
 * Unknown zone → the conservative floor select.ts already applied stands.
 */
export function checkinStillBookable(
  checkin: string,
  checkinTime: string,
  lot: Pick<ResolvedLot, "timeZone" | "hoursBeforeReservation">,
  nowMs: number
): boolean {
  if (!lot.timeZone) return true;
  const leadMs = Math.max(SAME_DAY_LEAD_MINUTES * 60_000, (lot.hoursBeforeReservation ?? 0) * 3_600_000);
  const cutoff = format(new TZDate(nowMs + leadMs, lot.timeZone), "yyyy-MM-dd HH:mm");
  return `${checkin} ${convertTo24Hour(checkinTime)}` > cutoff;
}

/** Emails (lowercased) that must not be emailed: opted out of this email, the
 *  newsletter, or the waitlist. Throws on any read error — an unreadable
 *  opt-out list means we cannot honour it, so nobody gets emailed this run. */
async function suppressedEmails(supabase: Supabase, emails: string[]): Promise<Set<string>> {
  const [optouts, newsletter, waitlist] = await Promise.all([
    supabase.from("checkout_recovery_optouts").select("email").in("email", emails).abortSignal(dbSignal()),
    supabase.from("newsletter_subscribers").select("email, unsubscribed_at").in("email", emails).abortSignal(dbSignal()),
    supabase.from("booking_waitlist").select("email, unsubscribed_at").in("email", emails).abortSignal(dbSignal()),
  ]);
  if (optouts.error) throw new Error(`optouts read failed: ${optouts.error.message}`);
  if (newsletter.error) throw new Error(`newsletter_subscribers read failed: ${newsletter.error.message}`);
  if (waitlist.error) throw new Error(`booking_waitlist read failed: ${waitlist.error.message}`);

  const out = new Set<string>();
  for (const r of (optouts.data ?? []) as Array<{ email: string }>) out.add(r.email.toLowerCase());
  for (const res of [newsletter, waitlist]) {
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

type BookingRow = {
  reslab_location_id: unknown;
  check_in: unknown;
  check_out: unknown;
  created_at: unknown;
  customers: unknown;
};

/**
 * Candidates whose trip is already BOOKED: a bookings row for the same
 * location + literal check-in/check-out in the last 30 days (any email, any
 * order — the booking may predate the abandoned re-entry); a LIVE booking by
 * the same address at the SAME LOT (a date-change attempt — the customer
 * holds a booking there; a trip already over, cancelled or refunded is a
 * returning customer, our best lead, and does not suppress); or a booking
 * by the same address at/after the abandoned checkout (a PaymentIntent
 * created BEFORE the abandoned one but paid after, e.g. two tabs, which the
 * Stripe-side ordering check in select.ts cannot see). Both reads are
 * targeted (by lot, by window) so PostgREST's row cap can never silently
 * drop a booked trip.
 */
async function bookedTrips(
  supabase: Supabase,
  candidates: RecoveryCandidate[],
  nowMs: number
): Promise<Set<string>> {
  const cols = "reslab_location_id, check_in, check_out, created_at, customers!inner(email)";
  const locationIds = [...new Set(candidates.map((c) => c.locationId))];
  const earliest = Math.min(...candidates.map((c) => c.createdMs));
  // check_out is a literal TIMESTAMP ("2026-10-22T18:00:00") compared as a
  // string against yesterday's UTC date — a day of slack covers every zone
  // we serve. An abandoned check-in is always in the future, so a booking
  // of the same trip always passes this filter.
  const stillLiveAfter = new Date(nowMs - 24 * 60 * 60_000).toISOString().slice(0, 10);
  const [byLot, since] = await Promise.all([
    supabase
      .from("bookings")
      .select(cols)
      .in("reslab_location_id", locationIds)
      .in("status", LIVE_BOOKING_STATUSES)
      .gte("check_out", stillLiveAfter)
      .gte("created_at", new Date(nowMs - TRIP_LOOKBACK_MS).toISOString())
      .abortSignal(dbSignal()),
    supabase
      .from("bookings")
      .select(cols)
      .gte("created_at", new Date(earliest).toISOString())
      .abortSignal(dbSignal()),
  ]);
  if (byLot.error) throw new Error(`bookings (lot) read failed: ${byLot.error.message}`);
  if (since.error) throw new Error(`bookings (since) read failed: ${since.error.message}`);

  const trips = new Set<string>();
  const emailAtLot = new Set<string>();
  for (const r of (byLot.data ?? []) as BookingRow[]) {
    const key = storedTripKey(String(r.reslab_location_id), r.check_in, r.check_out);
    if (key) trips.add(key);
    const email = embeddedEmail(r);
    if (email) emailAtLot.add(`${email}|${Number(r.reslab_location_id)}`);
  }
  const latestByEmail = new Map<string, number>();
  for (const r of (since.data ?? []) as BookingRow[]) {
    const email = embeddedEmail(r);
    if (!email) continue;
    const at = Date.parse(String(r.created_at));
    if ((latestByEmail.get(email) ?? 0) < at) latestByEmail.set(email, at);
  }

  const out = new Set<string>();
  for (const c of candidates) {
    if (trips.has(c.storedTrip) || emailAtLot.has(`${c.email}|${c.locationId}`)) {
      out.add(c.paymentIntentId);
      continue;
    }
    const at = latestByEmail.get(c.email);
    if (at !== undefined && at >= c.createdMs) out.add(c.paymentIntentId);
  }
  return out;
}

type PendingRow = {
  stripe_payment_intent_id: unknown;
  location_id?: unknown;
  from_date?: unknown;
  to_date?: unknown;
  status: unknown;
  created_at?: unknown;
  customer?: unknown;
};

/**
 * Candidates whose trip reached Pay Now: a pending_bookings row for the same
 * trip in the last 30 days (any status, any order — a `needs_reconciliation`
 * or `capture_ambiguous` row from two days ago is money we may be holding
 * for exactly this trip, and "you have not been charged" would be false),
 * a row staged at/after the abandoned checkout by the same address, or the
 * candidate's OWN row in any state past `pending` / `expired` (its
 * PaymentIntent got a card through at some point even though Stripe now
 * reports requires_payment_method — never chase that).
 */
async function pendingTrips(
  supabase: Supabase,
  candidates: RecoveryCandidate[],
  nowMs: number
): Promise<Set<string>> {
  const cols = "stripe_payment_intent_id, location_id, from_date, to_date, status, created_at, customer";
  const locationIds = [...new Set(candidates.map((c) => c.locationId))];
  const earliest = Math.min(...candidates.map((c) => c.createdMs));
  const [byTrip, since, own] = await Promise.all([
    supabase
      .from("pending_bookings")
      .select(cols)
      .in("location_id", locationIds)
      .gte("created_at", new Date(nowMs - TRIP_LOOKBACK_MS).toISOString())
      .abortSignal(dbSignal()),
    supabase
      .from("pending_bookings")
      .select(cols)
      .gte("created_at", new Date(earliest).toISOString())
      .abortSignal(dbSignal()),
    supabase
      .from("pending_bookings")
      .select("stripe_payment_intent_id, status")
      .in("stripe_payment_intent_id", candidates.map((c) => c.paymentIntentId))
      .abortSignal(dbSignal()),
  ]);
  if (byTrip.error) throw new Error(`pending_bookings (trip) read failed: ${byTrip.error.message}`);
  if (since.error) throw new Error(`pending_bookings (since) read failed: ${since.error.message}`);
  if (own.error) throw new Error(`pending_bookings (own) read failed: ${own.error.message}`);

  const tripRows = ((byTrip.data ?? []) as PendingRow[]).map((r) => ({
    pi: String(r.stripe_payment_intent_id),
    trip: storedTripKey(String(r.location_id), r.from_date, r.to_date),
  }));
  const sinceRows = ((since.data ?? []) as PendingRow[]).map((r) => {
    const cust = (r.customer ?? null) as { email?: unknown } | null;
    const rawEmail = cust?.email;
    return {
      pi: String(r.stripe_payment_intent_id),
      email: typeof rawEmail === "string" && rawEmail.trim() ? rawEmail.trim().toLowerCase() : null,
      createdMs: Date.parse(String(r.created_at)),
    };
  });
  const ownStatus = new Map<string, string>();
  for (const r of (own.data ?? []) as PendingRow[]) {
    ownStatus.set(String(r.stripe_payment_intent_id), String(r.status));
  }

  const out = new Set<string>();
  for (const c of candidates) {
    // The candidate's own row is judged by its status: a declined card leaves
    // it `pending`/`expired`, which is exactly an abandonment.
    const status = ownStatus.get(c.paymentIntentId);
    if (status !== undefined && status !== "pending" && status !== "expired") {
      out.add(c.paymentIntentId);
      continue;
    }
    if (tripRows.some((r) => r.pi !== c.paymentIntentId && r.trip === c.storedTrip)) {
      out.add(c.paymentIntentId);
      continue;
    }
    if (sinceRows.some((r) => r.pi !== c.paymentIntentId && r.createdMs >= c.createdMs && r.email === c.email)) {
      out.add(c.paymentIntentId);
    }
  }
  return out;
}

/**
 * Candidates whose address already got (or may have got) a recovery email
 * within the 7-day cap, in THIS Stripe mode (staging shares the DB). A row
 * counts when it is `claimed`/`sent`/`failed`, or `retry` with
 * send_started_at set (Resend was reached — a timed-out send is usually a
 * delivered one). A candidate's OWN row never caps it: that is the retry
 * the row exists for. A `retry` row that never reached Resend does not count.
 */
async function recentlyEmailed(
  supabase: Supabase,
  candidates: RecoveryCandidate[],
  livemode: boolean,
  nowMs: number
): Promise<Set<string>> {
  const { data, error } = await supabase
    .from("checkout_recovery_emails")
    .select("stripe_payment_intent_id, email, status, send_started_at")
    .in("email", [...new Set(candidates.map((c) => c.email))])
    .eq("livemode", livemode)
    .gte("created_at", new Date(nowMs - PER_EMAIL_CAP_MS).toISOString())
    .abortSignal(dbSignal());
  if (error) throw new Error(`send ledger read failed: ${error.message}`);
  const rows = (data ?? []) as Array<{
    stripe_payment_intent_id: string;
    email: string;
    status: string;
    send_started_at: string | null;
  }>;
  const counted = rows.filter((r) => r.status !== "retry" || r.send_started_at);
  const out = new Set<string>();
  for (const c of candidates) {
    if (counted.some((r) => r.email === c.email && r.stripe_payment_intent_id !== c.paymentIntentId)) {
      out.add(c.paymentIntentId);
    }
  }
  return out;
}

/**
 * `claimed` rows nobody will ever finish. Those that never reached Resend
 * (send_started_at NULL — a crash before the send, or a claim INSERT that
 * committed after its timeout) are removed so the checkout can be judged
 * afresh; those that did reach Resend may have an email out and are alarmed
 * for a human, never auto-retried. Returns {released, alarmed}; -1 when the
 * scan itself failed.
 */
async function sweepStaleClaims(supabase: Supabase, nowMs: number): Promise<{ released: number; alarmed: number }> {
  const before = new Date(nowMs - STALE_CLAIM_MS).toISOString();
  const { data, error } = await supabase
    .from("checkout_recovery_emails")
    .select("id, send_started_at")
    .eq("status", "claimed")
    .lt("claimed_at", before)
    .abortSignal(dbSignal());
  if (error) {
    captureAPIError(new Error(`checkout-recovery: stale-claim scan failed: ${error.message}`), {
      ...CTX,
      stage: "stale_claims",
    });
    return { released: -1, alarmed: -1 };
  }
  const rows = (data ?? []) as Array<{ id: string; send_started_at: string | null }>;
  const unsent = rows.filter((r) => !r.send_started_at).map((r) => r.id);
  let released = 0;
  if (unsent.length > 0) {
    const del = await supabase
      .from("checkout_recovery_emails")
      .delete()
      .in("id", unsent)
      .eq("status", "claimed")
      .is("send_started_at", null)
      .select("id")
      .abortSignal(dbSignal());
    if (del.error) {
      captureAPIError(new Error(`checkout-recovery: stale unsent claims not released: ${del.error.message}`), {
        ...CTX,
        stage: "stale_claims",
      });
    } else {
      released = Array.isArray(del.data) ? del.data.length : 0;
    }
  }
  const alarmed = rows.length - unsent.length;
  if (alarmed > 0) {
    alarm(
      "checkout_recovery_stale_claims",
      `checkout-recovery: ${alarmed} claimed row(s) reached Resend over ${STALE_CLAIM_MS / 60_000} min ago and were never marked — the email may be out. Check Resend by the PaymentIntent id, then set the row to sent or failed by hand (runbook).`,
      "warning"
    );
  }
  return { released, alarmed };
}

/** Status write for a claimed row. A failure is reported and counted; the
 *  row stays `claimed`, which still blocks any resend. */
async function markRow(
  supabase: Supabase,
  rowId: string,
  patch: { status: "sent" | "failed" | "retry"; sent_at?: string; last_error?: string | null },
  result: { markFailed: number }
) {
  const { data, error } = await supabase
    .from("checkout_recovery_emails")
    .update(patch)
    .eq("id", rowId)
    .select("id")
    .abortSignal(dbSignal());
  if (error || !Array.isArray(data) || data.length === 0) {
    result.markFailed++;
    captureAPIError(
      new Error(`checkout-recovery: status '${patch.status}' not recorded for ${rowId}: ${error?.message ?? "matched no rows"}`),
      { ...CTX, stage: `mark_${patch.status}` }
    );
  }
}

/**
 * Take the lock for one PaymentIntent: INSERT a `claimed` row, or on 23505
 * re-claim an existing `retry` row with a conditional UPDATE. Returns the
 * row id, "taken" when another run holds it (or it is sent/failed), or
 * "error" (reported). Nothing is ever deleted here: a timed-out INSERT that
 * commits anyway sits `claimed` with send_started_at NULL and is swept by
 * sweepStaleClaims once it is old.
 */
async function claimRow(
  supabase: Supabase,
  c: RecoveryCandidate,
  nowIso: string
): Promise<{ id: string } | "taken" | "error"> {
  const ins = await supabase
    .from("checkout_recovery_emails")
    .insert({
      stripe_payment_intent_id: c.paymentIntentId,
      email: c.email,
      livemode: c.livemode,
      status: "claimed",
      claimed_at: nowIso,
    })
    .select("id")
    .abortSignal(dbSignal())
    .single();
  if (!ins.error) return { id: (ins.data as { id: string }).id };
  if (ins.error.code !== "23505") {
    captureAPIError(new Error(`checkout-recovery claim failed: ${redact(ins.error.message)}`), {
      ...CTX,
      stage: "claim",
      code: ins.error.code,
    });
    return "error";
  }
  // send_started_at and last_error are KEPT: they are the evidence that an
  // earlier attempt reached Resend (the email may be in the inbox). A
  // re-claimed row that then crashes must be alarmed, never swept as
  // "never reached Resend" — which would delete the row behind a delivered
  // email's unsubscribe link.
  const re = await supabase
    .from("checkout_recovery_emails")
    .update({ status: "claimed", claimed_at: nowIso })
    .eq("stripe_payment_intent_id", c.paymentIntentId)
    .eq("status", "retry")
    .select("id")
    .abortSignal(dbSignal());
  if (re.error) {
    captureAPIError(new Error(`checkout-recovery re-claim failed: ${redact(re.error.message)}`), {
      ...CTX,
      stage: "reclaim",
      code: re.error.code,
    });
    return "error";
  }
  const rows = (re.data ?? []) as Array<{ id: string }>;
  return rows.length === 1 ? { id: rows[0].id } : "taken";
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
    return respond({ ok: false, error: "postal address is not configured" }, 503);
  }
  try {
    assertWaitlistSigningSecret();
  } catch (error) {
    captureAPIError(error instanceof Error ? error : new Error(String(error)), {
      ...CTX,
      stage: "config",
    });
    return respond({ ok: false, error: "signing secret is not configured" }, 503);
  }

  try {
    return await run(postalAddress);
  } catch (error) {
    // Nothing outside the stages below is expected to throw; if it does,
    // say so in Sentry rather than die with a bare Vercel 500.
    return fail("unhandled", errorMessage(error));
  }
}

async function run(postalAddress: string) {
  const nowMs = Date.now();
  const startedAt = nowMs;
  const elapsed = () => Date.now() - startedAt;

  // 1) Every PaymentIntent created in the last 24 h (auto-paginates; a few
  //    dozen a day). Non-abandoned ones are needed too — they are the
  //    "this trip was attempted / paid" evidence. Retries are OFF: stripe-node
  //    would otherwise retry a timed-out page twice and blow the budget.
  const pis: PaymentIntentLike[] = [];
  try {
    for await (const pi of stripe.paymentIntents.list(
      {
        created: { gte: Math.floor((nowMs - RECOVERY_MAX_AGE_MS) / 1000) },
        limit: 100,
      },
      { timeout: STRIPE_TIMEOUT_MS, maxNetworkRetries: 0 }
    )) {
      pis.push(pi);
      if (elapsed() > STRIPE_LIST_BUDGET_MS) {
        throw new Error(`list exceeded the ${STRIPE_LIST_BUDGET_MS} ms budget after ${pis.length} rows`);
      }
    }
  } catch (error) {
    return fail("stripe_list", `Stripe PaymentIntent list failed: ${errorMessage(error)}`);
  }

  const { candidates: selected, skipped } = selectRecoveryCandidates(pis, nowMs, {
    blockedLocationIds: BLOCKED_RESLAB_LOCATION_IDS,
  });

  const supabase = await createAdminClient();
  const stale = await sweepStaleClaims(supabase, nowMs);

  if (selected.length === 0) {
    return respond({ ok: true, scanned: pis.length, candidates: 0, sent: 0, staleClaims: stale, skipped });
  }

  const emails = [...new Set(selected.map((c) => c.email))];

  // 2) Exclusions that need the database — independent reads, in parallel.
  //    Any read failure fails the run CLOSED: sending past an unreadable
  //    opt-out list, or to a trip that is booked, is the one mistake this
  //    cron must not make.
  let suppressed: Set<string>;
  let booked: Set<string>;
  let pending: Set<string>;
  let capped: Set<string>;
  try {
    [suppressed, booked, pending, capped] = await Promise.all([
      suppressedEmails(supabase, emails),
      bookedTrips(supabase, selected, nowMs),
      pendingTrips(supabase, selected, nowMs),
      // Every PaymentIntent in one list call comes from the same Stripe key.
      recentlyEmailed(supabase, selected, selected[0].livemode, nowMs),
    ]);
  } catch (error) {
    return fail("exclusions", errorMessage(error));
  }

  const toSend = selected.filter(
    (c) =>
      !suppressed.has(c.email) &&
      !booked.has(c.paymentIntentId) &&
      !pending.has(c.paymentIntentId) &&
      !capped.has(c.paymentIntentId)
  );

  const result = {
    scanned: pis.length,
    candidates: selected.length,
    suppressed: selected.filter((c) => suppressed.has(c.email)).length,
    bookedTrip: selected.filter((c) => booked.has(c.paymentIntentId)).length,
    pendingTrip: selected.filter((c) => pending.has(c.paymentIntentId)).length,
    cappedWithin7d: selected.filter((c) => capped.has(c.paymentIntentId)).length,
    staleClaims: stale,
    lotGone: 0,
    checkinTooSoon: 0,
    sent: 0,
    sentUnconfirmed: 0,
    alreadyClaimed: 0,
    claimFailed: 0,
    sendFailed: 0,
    markFailed: 0,
    deferredToNextRun: 0,
  };

  // Enter the loop only with room for one full candidate; otherwise defer
  // the lot to the next tick (15 min away) rather than start something the
  // function timeout could cut off.
  if (toSend.length > 0 && elapsed() + SNAPSHOT_WARM_MS + CANDIDATE_RESERVE_MS > RUN_DEADLINE_MS) {
    result.deferredToNextRun = toSend.length;
    alarm(
      "checkout_recovery_capped",
      `checkout-recovery: ${toSend.length} candidate(s) deferred — ${elapsed()} ms spent before the first send`,
      "warning"
    );
    return respond({ ok: true, ...result, skipped });
  }

  // The shared location list (snapshot / warm cache): 0 ResLab calls, and
  // the same lot name on every retry. Null on a cold instance with the
  // snapshot off — then each candidate gets one bounded live lookup.
  const snapshot = new Map<number, ReslabLocation>();
  if (toSend.length > 0) {
    for (const loc of (await getChannelLocationsNoSweep()) ?? []) snapshot.set(loc.id, loc);
  }

  let attempted = 0;
  for (const c of toSend) {
    // Start a candidate only when its worst case still fits before the
    // deadline: nothing here may be cut off by the function timeout.
    if (attempted >= MAX_SENDS_PER_RUN || elapsed() + CANDIDATE_RESERVE_MS > RUN_DEADLINE_MS) {
      result.deferredToNextRun++;
      continue;
    }

    // 3) Resolve the lot BEFORE claiming: a lot that is gone, or a check-in
    //    inside the lot's notice period, must never be emailed — the link
    //    would land on an error.
    const lot = await lookupLot(c.locationId, snapshot);
    if (lot.gone) {
      result.lotGone++;
      continue;
    }
    if (!checkinStillBookable(c.checkin, c.checkinTime, lot, Date.now())) {
      result.checkinTooSoon++;
      continue;
    }

    // 4) Claim BEFORE sending. UNIQUE(stripe_payment_intent_id) is the lock.
    const claim = await claimRow(supabase, c, new Date().toISOString());
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

    // 5) Stamp "Resend is about to be called". If even this write fails the
    //    row is parked for a retry instead of sending blind — otherwise a
    //    crash after the send would leave a row the sweep believes never
    //    reached Resend, and the next tick would send again.
    const started = await supabase
      .from("checkout_recovery_emails")
      .update({ send_started_at: new Date().toISOString() })
      .eq("id", rowId)
      .select("id")
      .abortSignal(dbSignal());
    if (started.error || !Array.isArray(started.data) || started.data.length === 0) {
      result.sendFailed++;
      captureAPIError(
        new Error(`checkout-recovery: send_started_at not recorded for ${rowId}: ${started.error?.message ?? "matched no rows"}`),
        { ...CTX, stage: "send_start" }
      );
      await markRow(supabase, rowId, { status: "retry", last_error: "send_started_at write failed" }, result);
      continue;
    }

    try {
      await sendRecoveryEmail(c, lot, recoveryUnsubscribeUrl(c.paymentIntentId), postalAddress);
    } catch (error) {
      const message = redact(errorMessage(error));
      if (isIdempotencyConflict(error)) {
        // Resend already holds this key: the email went out on an earlier
        // attempt whose answer we lost, or is in flight right now. Either
        // way it must never be retried and the ledger must say so.
        result.sentUnconfirmed++;
        alarm(
          "checkout_recovery_idempotency_conflict",
          `checkout-recovery: Resend 409 for ${c.paymentIntentId} — recorded as sent (delivery unconfirmed)`,
          "warning"
        );
        await markRow(supabase, rowId, { status: "sent", sent_at: new Date().toISOString(), last_error: message.slice(0, 500) }, result);
        result.sent++;
        continue;
      }
      captureAPIError(new Error(`checkout-recovery send failed: ${message}`), { ...CTX, stage: "send" });
      result.sendFailed++;
      if (isWaitlistConfigError(error) || isSendConfigFailure(error)) {
        // Env changed under a running instance, or Resend rejected OUR key /
        // domain — not this row's fault, and every later send would fail
        // the same way. Park it and stop.
        await markRow(supabase, rowId, { status: "retry", last_error: message.slice(0, 500) }, result);
        break;
      }
      if (isTransientSendFailure(error)) {
        // Park for the next tick (the row is kept: the email may have been
        // delivered after our deadline, and its unsubscribe link must keep
        // resolving); the Resend idempotency key makes the retry safe.
        await markRow(supabase, rowId, { status: "retry", last_error: message.slice(0, 500) }, result);
      } else {
        // Permanent (bad / suppressed address): keep the row so it never retries.
        await markRow(supabase, rowId, { status: "failed", last_error: message.slice(0, 500) }, result);
      }
      continue;
    }

    // The email is out. A failed status write leaves the row `claimed`, which
    // still blocks any resend — bookkeeping only, but reported (and the
    // stale-claim alarm will keep pointing at it).
    await markRow(supabase, rowId, { status: "sent", sent_at: new Date().toISOString(), last_error: null }, result);
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
  }

  return respond({ ok: !allFailed, ...result, skipped }, allFailed ? 500 : 200);
}
