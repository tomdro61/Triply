/**
 * createBooking — the single idempotent engine that turns a paid-for cart into
 * a booking, driven by three entry points:
 *
 *   1. the browser        (POST /api/reservations)
 *   2. the return page    (/checkout/complete, after a 3-D Secure or BNPL redirect)
 *   3. the Stripe webhook (the guarantee — fires even if the browser never comes back)
 *
 * THE ORDER OF OPERATIONS IS THE WHOLE POINT.
 *
 *   before:  charge -> hope the browser survives -> create booking
 *   now:     stage the intent -> authorize -> create the ResLab reservation -> CAPTURE
 *
 * Money moves at step 7, and only after ResLab has confirmed a reservation
 * exists. Every earlier exit releases the authorization; the customer is never
 * charged for a booking that does not exist.
 *
 * THE ONE ACCEPTED AMBIGUOUS PATH: ResLab's createReservation is a plain POST
 * with no idempotency key, so a 5xx or a timeout leaves us genuinely unable to
 * tell whether a reservation was created. We must not retry (that double-books)
 * and we must not blindly release (we may owe them for a real reservation). Such
 * rows land in `needs_reconciliation` with the authorization left intact and a
 * loud alert, for manual ops recovery inside the ~7-day hold window. This is a
 * vendor limitation, not a design choice — filing for a client-reference key is
 * the fix.
 */

import type Stripe from "stripe";
import { reslab, ReslabError } from "@/lib/reslab/client";
import type { ReslabReservation } from "@/lib/reslab/client";
import { createAdminClient } from "@/lib/supabase/server";
import {
  stripe,
  capturePaymentIntent,
  cancelPaymentIntent,
  createRefund,
  paymentIntentRefundState,
} from "@/lib/stripe/client";
import { capturePaymentError, captureBookingError } from "@/lib/sentry";
import { reservationSchema } from "@/lib/validation/schemas";
import { PROTECTION_PLAN } from "@/lib/parkguard/client";
import {
  createReslabReservation,
  persistBooking,
  sendBookingEmails,
  buildReservationResponse,
  type BookingPayload,
} from "./fulfill";

// =============================================================================
// Tunables — three DISTINCT durations. They are not interchangeable.
// =============================================================================

/** A `processing` claim older than this is presumed abandoned (the caller's
 *  browser or serverless invocation died) and may be stolen by another caller.
 *  Must exceed the whole server budget for one fulfilment attempt, or a slow
 *  but healthy request gets its work stolen out from under it. */
const STALE_CLAIM_MS = 90_000;

/** How long one cart identity is locked to a single PaymentIntent. Long enough
 *  to cover a 3-D Secure retry loop, short enough that a customer legitimately
 *  re-booking the same lot and dates later in the day isn't blocked. */
const CART_CLAIM_WINDOW_MS = 30 * 60_000;

/** A claim older than this is released regardless of what its owning
 *  PaymentIntent's row says. Absolute backstop against a cart being locked
 *  forever by a row that nothing will ever move to a terminal status. */
const CART_CLAIM_HARD_EXPIRY_MS = 7 * 24 * 60 * 60_000;

// =============================================================================
// Result types
// =============================================================================

export type BookingSource = "client" | "complete" | "webhook" | "sweep" | "dev";

export type CreateBookingResult =
  /** A reservation was created on this call. Emails were sent. */
  | {
      kind: "created";
      reservationNumber: string;
      reservation: ReturnType<typeof buildReservationResponse>;
    }
  /** A booking already exists for this PaymentIntent. No side effects, no email. */
  | { kind: "already_exists"; reservationNumber: string }
  /** Another caller holds a fresh claim. Retry later. */
  | { kind: "in_progress" }
  /** PI is still settling; all side effects deferred to the webhook. */
  | { kind: "deferred" }
  /** Money was already returned to the customer. Never bookable again. */
  | { kind: "already_refunded" }
  /** Inventory disappeared between checkout and fulfilment. Payment released. */
  | { kind: "sold_out" }
  /** Another PaymentIntent already owns this cart. Payment released. */
  | { kind: "suspected_duplicate" }
  /**
   * MONEY MAY BE HELD OR TAKEN and booking state is unknown.
   *
   * `retryable` distinguishes the two very different causes:
   *  - true  — we could not READ our own state (a database fault). Nothing is
   *            known to be wrong with the booking; a later attempt may well
   *            succeed, so the webhook MUST ask Stripe to redeliver.
   *  - false — a genuine terminal ambiguity (a ResLab call that may or may not
   *            have created a reservation, an unknown capture result). Retrying
   *            cannot help and risks double-booking, so Stripe must stop.
   *
   * Getting this backwards disarms the whole guarantee: a two-second Supabase
   * blip during the webhook's only delivery would end the retry chain and leave
   * a charged customer with no booking.
   */
  | { kind: "needs_reconciliation"; reason: string; retryable: boolean }
  /** Definitive failure. Payment released; customer not charged. */
  | { kind: "failed"; reason: string; userMessage: string };

/**
 * Should Stripe redeliver the webhook that produced this outcome?
 *
 * The SINGLE source of truth for the webhook's 503-vs-2xx contract, so the wire
 * behaviour can never drift from the `retryable` field. The `never` guard makes
 * adding a new CreateBookingResult variant a compile error here — previously the
 * webhook re-derived this rule inline with no such guard, so a new variant would
 * silently fall through to "don't redeliver" and could strand a charged customer.
 * (The sweep is a cron, not a Stripe-delivered webhook, so it doesn't use this —
 * it keeps its own outcome tally.)
 */
export function shouldStripeRedeliver(outcome: CreateBookingResult): boolean {
  switch (outcome.kind) {
    // Someone else holds the claim, or the PI is still settling — a later
    // delivery finishes the job.
    case "in_progress":
    case "deferred":
      return true;
    // Only a DB-fault ambiguity is worth retrying; a genuine terminal ambiguity
    // (ResLab may-or-may-not-exist, unknown capture) must NOT be redelivered —
    // retrying those double-books.
    case "needs_reconciliation":
      return outcome.retryable;
    case "created":
    case "already_exists":
    case "already_refunded":
    case "sold_out":
    case "suspected_duplicate":
    case "failed":
      return false;
    default: {
      const _exhaustive: never = outcome;
      return false;
    }
  }
}

/** The PaymentIntent is not in a state that permits fulfilment. */
export class PaymentNotConfirmedError extends Error {
  constructor(public readonly piStatus: string) {
    super(`PaymentIntent status is ${piStatus}, expected an authorized state`);
    this.name = "PaymentNotConfirmedError";
  }
}

export interface CreateBookingInput {
  source: BookingSource;
  stripePaymentIntentId: string | null;
  /** Present for the client path. Omitted by the webhook and return page, which
   *  load the payload from the durable pending row instead. */
  payload?: BookingPayload;
}

// =============================================================================
// ResLab error classification — the single most consequential branch here
// =============================================================================

type ReslabFailure =
  /** ResLab definitively rejected. Nothing was created. Safe to release money. */
  | { definitive: true; userMessage: string; soldOut: boolean }
  /** Timeout or 5xx. A reservation MAY exist. Never retry, never blind-release. */
  | { definitive: false; userMessage: string; soldOut: false };

function classifyReslabError(error: unknown): ReslabFailure {
  // An AbortError from our own 10s timeout is the ambiguous case that created
  // the yb3246 orphan: we stopped listening, but ResLab may well have committed
  // the reservation. It is NOT a ReslabError, so it must be caught explicitly —
  // before the rehaul it fell through to a generic 500.
  if (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  ) {
    return {
      definitive: false,
      soldOut: false,
      userMessage:
        "We're confirming your reservation with the parking facility. Our team will email you shortly — please don't rebook.",
    };
  }

  if (error instanceof ReslabError) {
    // 4xx (except 429) means ResLab understood us and said no. Nothing exists.
    if (
      error.statusCode >= 400 &&
      error.statusCode < 500 &&
      error.statusCode !== 429
    ) {
      let userMessage =
        "This parking option is no longer available. Please choose a different option.";
      let soldOut = error.statusCode === 409;
      try {
        const parsed = JSON.parse(
          error.message.replace("API request failed: ", "")
        );
        if (parsed.message && typeof parsed.message === "string") {
          userMessage = parsed.message;
          if (/sold\s*out/i.test(parsed.message)) soldOut = true;
        }
      } catch {
        // Keep the status-derived default.
      }
      return { definitive: true, userMessage, soldOut };
    }

    // 5xx / 429 — ResLab may have committed before failing to answer.
    return {
      definitive: false,
      soldOut: false,
      userMessage:
        "We're confirming your reservation with the parking facility. Our team will email you shortly — please don't rebook.",
    };
  }

  // Unknown failure shape. Treat as ambiguous: assuming "nothing was created"
  // and releasing the payment is the branch that loses money if we're wrong.
  return {
    definitive: false,
    soldOut: false,
    userMessage:
      "We're confirming your reservation with the parking facility. Our team will email you shortly — please don't rebook.",
  };
}

// =============================================================================
// Payment release — status-aware. `cancel` throws on processing/succeeded.
// =============================================================================

type ReleaseOutcome =
  | { released: "cancelled" }
  | { released: "refunded" }
  | { released: "nothing" }
  /** Cannot act yet — PI still settling. Leave non-terminal; webhook re-drives. */
  | { released: "deferred" };

async function releasePayment(
  pi: Stripe.PaymentIntent
): Promise<ReleaseOutcome> {
  switch (pi.status) {
    case "requires_capture":
      // The good case: authorized, never captured. Cancelling costs the customer
      // nothing and leaves no refund on their statement.
      await cancelPaymentIntent(pi.id);
      return { released: "cancelled" };

    case "succeeded": {
      // Money already moved — a wallet method that auto-captures, or a PI created
      // before the manual-capture cutover. Refund is the only teardown available.
      const refundState = paymentIntentRefundState(pi);
      if (refundState === "refunded") {
        return { released: "refunded" };
      }
      if (refundState === "unknown") {
        // Undeterminable refund state (unreachable today: a succeeded PI
        // retrieved with expand:["latest_charge"] yields refunded|none). Defer
        // rather than issue a refund on a read we can't trust — a spurious refund
        // is not recoverable.
        return { released: "deferred" };
      }
      // Key on the PaymentIntent ALONE (gate G2). Keying on the reason would let
      // two callers detecting different reasons issue two refunds; the second
      // throws "already refunded" and wedges that caller's terminal transition.
      await createRefund(pi.id, undefined, `refund:${pi.id}`);
      return { released: "refunded" };
    }

    case "processing":
      // Neither cancellable nor refundable while settling. Do NOT mark terminal —
      // payment_intent.succeeded will re-drive this row once Stripe settles.
      return { released: "deferred" };

    case "canceled":
      return { released: "cancelled" };

    default:
      // requires_payment_method / requires_action — never authorized, nothing held.
      return { released: "nothing" };
  }
}

// =============================================================================
// Durable state helpers
// =============================================================================

/**
 * The pending_bookings lifecycle, defined in ONE place.
 *
 * These values are mirrored by the CHECK constraint in migration 015. Writing a
 * status outside the list raises a Postgres check_violation (23514) in the middle
 * of fulfilment — after money may already have moved — so this union exists to
 * make a typo a compile error instead of a runtime money event. Add a value here
 * and you must add it to the migration's CHECK, and vice versa.
 */
export const PENDING_STATUS = [
  "pending",
  "processing",
  "completed",
  "expired",
  "failed",
  "suspected_duplicate",
  "needs_reconciliation",
  "capture_ambiguous",
  "refunded_sold_out",
  "refunded_failed",
  "refunded_after_capture",
  "released_sold_out",
  "released_failed",
] as const;

export type PendingStatus = (typeof PENDING_STATUS)[number];

/** The only two statuses from which fulfilment may still proceed. */
const NON_TERMINAL = ["pending", "processing"] as const;
export type TerminalStatus = Exclude<PendingStatus, (typeof NON_TERMINAL)[number]>;

/**
 * Derived, not hand-listed. A new status added to PENDING_STATUS is treated as
 * terminal by default — the safe direction, since an unrecognised status must
 * never be re-fulfilled.
 */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(
  PENDING_STATUS.filter(
    (s): s is TerminalStatus => !(NON_TERMINAL as readonly string[]).includes(s)
  )
);

/**
 * A durable-state write or read failed.
 *
 * Distinct from every other error because a DB fault must never be mistaken for
 * a business outcome: "the mutex is held by someone else" and "the database is
 * down" produce identical-looking empty results, and treating the second as the
 * first is how a customer ends up charged with no booking and no alert.
 */
export class DurableStateError extends Error {
  constructor(operation: string, cause: string) {
    super(`pending_bookings ${operation} failed: ${cause}`);
    this.name = "DurableStateError";
  }
}

interface PendingRow {
  stripe_payment_intent_id: string;
  status: PendingStatus;
  reslab_reservation_number: string | null;
  claimed_at: string | null;
  email_sent: boolean;
  livemode: boolean;
  // Fulfilment payload columns
  location_id: number;
  costs_token: string | null;
  from_date: string;
  to_date: string;
  parking_type_id: number;
  customer: BookingPayload["customer"];
  vehicle: BookingPayload["vehicle"];
  extra_fields: Record<string, string> | null;
  location_name: string | null;
  location_address: string | null;
  airport_code: string | null;
  subtotal: string | number | null;
  tax_total: string | number | null;
  fees_total: string | number | null;
  grand_total: string | number | null;
  triply_service_fee: string | number | null;
  user_id: string | null;
  has_protection_plan: boolean;
}

/**
 * Coerce a Postgres numeric (PostgREST returns DECIMAL as a string) to a number.
 *
 * A NULL column legitimately yields undefined. A column that holds a value we
 * cannot parse does NOT — that would flow into `x ?? y ?? 0` downstream and book
 * a $0 grand_total silently, which is the same silent-zero class that produced
 * the RTL753241 due_at_location incident. Unparseable is loud.
 */
function num(
  v: string | number | null | undefined,
  field: string,
  pi: string
): number | undefined {
  if (v === null || v === undefined) return undefined;
  const n = typeof v === "number" ? v : parseFloat(v);
  if (!Number.isFinite(n)) {
    captureBookingError(
      new Error(
        `pending_bookings.${field} held an unparseable value (${JSON.stringify(
          v
        )}) for ${pi} — treating as absent; downstream money math may fall back to 0`
      ),
      { step: "checkout" }
    );
    return undefined;
  }
  return n;
}

/** A pending row's JSONB/TEXT columns can't be reconstructed into a booking
 *  payload the schema accepts — corrupt customer/vehicle JSONB, a drifted date
 *  format. On the dead-browser paths (webhook/sweep/complete) there is no client
 *  to have caught it, and this row is the SOLE fulfilment source, so it must be
 *  validated, not trusted verbatim. */
class InvalidPendingRowError extends Error {
  constructor(pi: string, detail: string) {
    super(`pending_bookings row for ${pi} is not a valid booking payload: ${detail}`);
    this.name = "InvalidPendingRowError";
  }
}

function payloadFromPendingRow(row: PendingRow): BookingPayload {
  const pi = row.stripe_payment_intent_id;
  const candidate = {
    locationId: row.location_id,
    costsToken: row.costs_token ?? "",
    fromDate: row.from_date,
    toDate: row.to_date,
    parkingTypeId: row.parking_type_id,
    customer: row.customer,
    vehicle: row.vehicle,
    extraFields: row.extra_fields ?? undefined,
    locationName: row.location_name ?? undefined,
    locationAddress: row.location_address ?? undefined,
    airportCode: row.airport_code ?? undefined,
    subtotal: num(row.subtotal, "subtotal", pi),
    taxTotal: num(row.tax_total, "tax_total", pi),
    feesTotal: num(row.fees_total, "fees_total", pi),
    grandTotal: num(row.grand_total, "grand_total", pi),
    triplyServiceFee: num(row.triply_service_fee, "triply_service_fee", pi),
    userId: row.user_id,
    stripePaymentIntentId: pi,
    hasProtectionPlan: row.has_protection_plan,
  };

  // Validate at this boundary (CLAUDE.md: Zod at boundaries). The DB read-back on
  // a browserless path is exactly such a boundary — a malformed row would flow
  // straight into createReslabReservation.
  const parsed = reservationSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new InvalidPendingRowError(pi, parsed.error.issues[0]?.message ?? "unknown");
  }
  return parsed.data;
}

/**
 * Cart IDENTITY.
 *
 * Deliberately excludes amount — toggling Park Guard or a ResLab price refresh
 * changes the amount while the cart is plainly the same cart.
 *
 * INCLUDES livemode. Triply-prod is one Postgres instance shared by staging
 * (Stripe TEST) and production (Stripe LIVE), and the uniqueness index is
 * table-wide. Without this, a staging test booking sharing an email + lot + dates
 * with a real production booking inside the 30-minute window collides — and since
 * a test PI id never equals a live PI id, the "is this our own re-drive?" check
 * fails and a REAL customer's payment gets released as a duplicate.
 */
export function cartKey(payload: BookingPayload, livemode: boolean): string {
  return [
    livemode ? "live" : "test",
    payload.customer.email.trim().toLowerCase(),
    payload.locationId,
    payload.fromDate,
    payload.toDate,
    payload.parkingTypeId,
  ].join("|");
}

/**
 * NOTE ON EVERY HELPER BELOW: they THROW on a database error rather than
 * returning an empty result.
 *
 * A DB fault and a business outcome are indistinguishable in Supabase's return
 * shape — `{ data: null }` means both "no row matched" and "the query failed".
 * Conflating them is how a degraded database silently became "another caller
 * holds the mutex", leaving a charged customer with no booking and no alert
 * while the UI told them not to rebook. Callers catch DurableStateError and
 * route it to needs_reconciliation.
 */
async function readPendingRow(pi: string): Promise<PendingRow | null> {
  const supabase = await createAdminClient();
  const { data, error } = await supabase
    .from("pending_bookings")
    .select("*")
    .eq("stripe_payment_intent_id", pi)
    .maybeSingle();
  if (error) throw new DurableStateError("read", error.message);
  return (data as PendingRow | null) ?? null;
}

/**
 * Atomic mutex claim. A single UPDATE ... RETURNING — never SELECT-then-UPDATE,
 * which would let two callers both observe `pending` and both proceed.
 *
 * Claimable when the row is fresh (`pending`) or when a previous claim has gone
 * stale (the caller died mid-fulfilment). Stealing a stale claim is what lets
 * Stripe's webhook retry finish a job the browser abandoned.
 *
 * That covers the common case but NOT all of it, so it does not remove the need
 * for a sweep — an earlier version of this comment claimed it did, wrongly.
 * Stripe's retry budget is finite (~3 days), the client `deferred` path has no
 * webhook at all if the tab closes, and nothing else ever retires an abandoned
 * `pending` row. /api/cron/sweep-pending-bookings covers those.
 */
async function claimPendingRow(pi: string): Promise<PendingRow | null> {
  const supabase = await createAdminClient();
  const staleBefore = new Date(Date.now() - STALE_CLAIM_MS).toISOString();

  // TWO atomic single-condition UPDATEs, deliberately NOT one `.or()` UPDATE.
  //
  // Real PostgREST rejects `.or()` on an UPDATE with "column ... does not exist"
  // (it parses fine on a SELECT). The original single-statement claim therefore
  // matched ZERO rows on every call — the mutex never fired, createBooking
  // always returned `in_progress`, and every booking stalled until the client
  // gave up. This was invisible to the unit tests because the in-memory fake
  // implemented `.or()`-on-update, so it was more permissive than the database.
  //
  // The claim is still atomic and race-safe. Each UPDATE re-evaluates its WHERE
  // under a row lock, and the two target DISJOINT statuses:
  //   1. a FRESH pending row, or
  //   2. a stale `processing` row whose owner died.
  // Two callers racing (1) — Postgres serializes; only one matches `pending`.
  // Two callers racing (2) — the first sets claimed_at=now, so the second's
  // `claimed_at < staleBefore` no longer holds and it matches nothing.

  const claimNow = { status: "processing", claimed_at: new Date().toISOString() };

  // 1. Claim a fresh row.
  const fresh = await supabase
    .from("pending_bookings")
    .update(claimNow)
    .eq("stripe_payment_intent_id", pi)
    .eq("status", "pending")
    .select("*")
    .maybeSingle();
  if (fresh.error) throw new DurableStateError("claim(pending)", fresh.error.message);
  if (fresh.data) return fresh.data as PendingRow;

  // 2. Steal a stale claim.
  const stolen = await supabase
    .from("pending_bookings")
    .update(claimNow)
    .eq("stripe_payment_intent_id", pi)
    .eq("status", "processing")
    .lt("claimed_at", staleBefore)
    .select("*")
    .maybeSingle();
  if (stolen.error) throw new DurableStateError("claim(stale)", stolen.error.message);

  return (stolen.data as PendingRow | null) ?? null;
}

/**
 * Terminal transition, guarded on still holding the claim.
 *
 * Returns false when another caller already moved the row — in which case this
 * caller must NOT also act on money. Every money-releasing branch pairs with one
 * of these so a release can fire at most once.
 */
async function markTerminal(
  pi: string,
  status: TerminalStatus,
  lastError?: string,
  /** Statuses this transition may move FROM. Defaults to `processing` only —
   *  i.e. only the caller currently holding the mutex may finish the job, which
   *  is what makes every money-releasing branch fire at most once.
   *
   *  Widened to include `pending` for transitions that run BEFORE the mutex is
   *  claimed (the refund gate and the already-booked short-circuit). Without
   *  that, those rows would be left non-terminal forever and would surface as
   *  false "stuck booking" alerts even though nothing is wrong. */
  fromStatuses: PendingStatus[] = ["processing"]
): Promise<boolean> {
  const supabase = await createAdminClient();
  const { data, error } = await supabase
    .from("pending_bookings")
    .update({
      status,
      ...(lastError ? { last_error: lastError.slice(0, 2000) } : {}),
    })
    .eq("stripe_payment_intent_id", pi)
    .in("status", fromStatuses)
    .select("stripe_payment_intent_id")
    .maybeSingle();

  // A swallowed error here (notably a 23514 check_violation from an invalid
  // status) left the row in `processing`, whereupon the sweep or a webhook
  // redelivery re-drove a fulfilment that had already completed.
  if (error) throw new DurableStateError(`markTerminal(${status})`, error.message);

  return !!data;
}

/**
 * Hand the mutex back and ask to be re-driven. The counterpart to markTerminal.
 *
 * Use for TRANSIENT failures — a database blip, a ResLab 502 on a GET, a booking
 * insert that failed for reasons unrelated to the booking itself. Writing a
 * terminal status in those cases is what turns a recoverable situation into a
 * permanent one: the row short-circuits at step 5 on every later attempt, so the
 * redelivery we asked Stripe for is guaranteed to be useless, and a booking that
 * would have completed on its own becomes a manual-ops ticket.
 *
 * The rule: terminal means "this can never succeed". Anything else releases.
 */
async function releaseForRetry(
  piId: string,
  reason: string
): Promise<CreateBookingResult> {
  try {
    const supabase = await createAdminClient();
    const { error } = await supabase
      .from("pending_bookings")
      .update({
        status: "pending",
        claimed_at: null,
        last_error: reason.slice(0, 2000),
      })
      .eq("stripe_payment_intent_id", piId)
      .eq("status", "processing");
    if (error) throw new Error(error.message);
  } catch (releaseError) {
    // Couldn't hand it back — most likely the same fault we're recovering from.
    // Not fatal: the claim goes stale after STALE_CLAIM_MS and the next caller
    // steals it, which reaches the same place a beat later.
    captureBookingError(
      new Error(
        `Could not release the claim on ${piId} for retry (${
          releaseError instanceof Error ? releaseError.message : String(releaseError)
        }); falling back to the stale-claim timeout`
      ),
      { step: "checkout" }
    );
  }
  return { kind: "needs_reconciliation", reason, retryable: true };
}

async function recordReslabNumber(pi: string, reservationNumber: string) {
  const supabase = await createAdminClient();
  const { error } = await supabase
    .from("pending_bookings")
    .update({ reslab_reservation_number: reservationNumber })
    .eq("stripe_payment_intent_id", pi);

  // This single write is what makes a crash in the next few milliseconds
  // recoverable instead of an orphan. If it fails silently the row keeps a NULL
  // reservation number, a later caller steals the stale claim, sees no
  // reservation, and creates a SECOND one at the lot — ResLab has no idempotency
  // key, so that duplicate is real and billable.
  if (error) throw new DurableStateError("recordReslabNumber", error.message);
}

/** Claim the cart. Returns false when another PaymentIntent already owns it. */
async function claimCart(
  key: string,
  pi: string,
  livemode: boolean
): Promise<boolean> {
  const supabase = await createAdminClient();

  // Expire stale claims first. now() cannot live in an index predicate, so the
  // time-scoping of the unique constraint happens here.
  //
  // But wall-clock alone must NOT govern this. The 30-minute window was sized for
  // a 3-D Secure retry loop; an async bank-backed payment can sit in `processing`
  // for DAYS. Expiring a claim whose PaymentIntent is still legitimately in
  // flight lets a second PI take the cart, complete, and release it — and when
  // the first finally settles it books the same cart a second time. So: only
  // expire claims whose owning PaymentIntent is actually finished with.
  const expiredBefore = new Date(Date.now() - CART_CLAIM_WINDOW_MS).toISOString();
  const { data: staleClaims, error: staleError } = await supabase
    .from("cart_claims")
    .select("id, stripe_payment_intent_id, claimed_at")
    .eq("cart_key", key)
    .is("released_at", null)
    .lt("claimed_at", expiredBefore);

  if (staleError) {
    // A silent failure here leaves the stale claim live, the insert below 23505s,
    // the ownership lookup returns the OTHER PI, and we cancel or refund a
    // legitimate payment as a duplicate — telling the customer to check their
    // email for an original confirmation that does not exist.
    throw new DurableStateError("cart_claims stale scan", staleError.message);
  }

  for (const claim of staleClaims ?? []) {
    if (claim.stripe_payment_intent_id === pi) continue;

    const { data: owner, error: ownerError } = await supabase
      .from("pending_bookings")
      .select("status")
      .eq("stripe_payment_intent_id", claim.stripe_payment_intent_id)
      .maybeSingle();

    if (ownerError) {
      throw new DurableStateError("cart_claims owner lookup", ownerError.message);
    }

    // No pending row, or a terminal one, means that PaymentIntent will never
    // fulfil this cart. Anything still `pending`/`processing` keeps its claim
    // however long it takes to settle — EXCEPT past the hard expiry, so a row
    // that nothing ever moves to a terminal status cannot lock a cart forever
    // and refund every subsequent booking of it as a duplicate.
    const hardExpired =
      Date.parse(claim.claimed_at) < Date.now() - CART_CLAIM_HARD_EXPIRY_MS;
    const ownerFinished = !owner || TERMINAL_STATUSES.has(owner.status);
    if (!ownerFinished && !hardExpired) continue;

    const { error: releaseError } = await supabase
      .from("cart_claims")
      .update({ released_at: new Date().toISOString() })
      .eq("id", claim.id)
      .is("released_at", null);
    if (releaseError) {
      throw new DurableStateError("cart_claims expiry", releaseError.message);
    }
  }

  const { error } = await supabase
    .from("cart_claims")
    .insert({ cart_key: key, stripe_payment_intent_id: pi, livemode });

  if (!error) return true;

  // 23505 = the partial unique index fired: a live claim exists. If it's OURS
  // (a re-drive of the same PI), that's not a duplicate cart.
  if ((error as { code?: string }).code === "23505") {
    const { data, error: lookupError } = await supabase
      .from("cart_claims")
      .select("stripe_payment_intent_id")
      .eq("cart_key", key)
      .is("released_at", null)
      .maybeSingle();

    // Fail OPEN, matching the policy below. A swallowed error here made `data`
    // null, so the ownership check returned false and the caller refunded or
    // cancelled the customer's OWN re-drive as a duplicate — while the alert
    // said "duplicate cart detected", pointing ops at a race that never happened.
    if (lookupError) {
      captureBookingError(
        new Error(
          `cart_claims ownership check failed for ${pi} (${lookupError.message}) — proceeding rather than releasing a possibly-legitimate payment`
        ),
        { step: "checkout" }
      );
      return true;
    }

    return data?.stripe_payment_intent_id === pi;
  }

  // Any other DB error: fail OPEN on the duplicate check rather than blocking a
  // legitimate booking. A duplicate is recoverable (refund); a wrongly-refused
  // booking on a healthy cart is a lost customer.
  captureBookingError(
    new Error(`cart_claims insert failed: ${(error as Error).message}`),
    { step: "checkout" }
  );
  return true;
}

async function releaseCart(pi: string) {
  const supabase = await createAdminClient();
  const { error } = await supabase
    .from("cart_claims")
    .update({ released_at: new Date().toISOString() })
    .eq("stripe_payment_intent_id", pi)
    .is("released_at", null);

  // Non-fatal: the booking itself is already settled by the time we release. But
  // a stuck claim blocks this customer from re-booking the same lot and dates for
  // the next 30 minutes, so it must not vanish silently.
  if (error) {
    captureBookingError(
      new Error(`cart_claims release failed for ${pi}: ${error.message}`),
      { step: "checkout" }
    );
  }
}

async function markEmailSent(pi: string) {
  const supabase = await createAdminClient();
  const { error } = await supabase
    .from("pending_bookings")
    .update({ email_sent: true })
    .eq("stripe_payment_intent_id", pi);

  // Non-fatal — the booking exists and the customer HAS their email. A failure
  // here only risks a duplicate confirmation on a later re-drive, which is far
  // better than the alternative, so it is recorded rather than raised.
  if (error) {
    captureBookingError(
      new Error(`email_sent flag not persisted for ${pi}: ${error.message}`),
      { step: "checkout" }
    );
  }
}

// =============================================================================
// The engine
// =============================================================================

export async function createBooking(
  input: CreateBookingInput
): Promise<CreateBookingResult> {
  try {
    return await createBookingInner(input);
  } catch (err) {
    // A durable-state failure means the database could not tell us what is true.
    // It must NEVER surface as a benign business outcome — that is how a degraded
    // Supabase became "another caller holds the mutex" while a charged customer
    // got no booking and no alert. Deliberately does not attempt a further write:
    // the store we would write to is the one that just failed.
    if (err instanceof DurableStateError) {
      capturePaymentError(err, {
        ...(input.stripePaymentIntentId && {
          stripePaymentIntentId: input.stripePaymentIntentId,
        }),
      });
      // RETRYABLE. We failed to read or write our own state — that says nothing
      // about whether the booking can be completed, and the webhook must keep
      // asking Stripe to redeliver until it can.
      return {
        kind: "needs_reconciliation",
        reason: err.message,
        retryable: true,
      };
    }
    throw err;
  }
}

async function createBookingInner(
  input: CreateBookingInput
): Promise<CreateBookingResult> {
  const { source, stripePaymentIntentId } = input;

  // --- Step 0: dev bypass. No PI, no payment state machine. ------------------
  if (!stripePaymentIntentId) {
    if (!input.payload) {
      throw new Error("createBooking requires a payload when there is no PaymentIntent");
    }
    return fulfilOnly(input.payload);
  }

  const pi = await stripe.paymentIntents.retrieve(stripePaymentIntentId, {
    expand: ["latest_charge"],
  });

  // --- Step 1: refund gate (G1) ---------------------------------------------
  // A refund can succeed and the process die before the terminal DB write lands.
  // Without this read, a re-drive would find freed inventory and hand a booking
  // to someone who has already had their money returned.
  const refundState = paymentIntentRefundState(pi);

  if (refundState === "refunded") {
    await markTerminal(
      stripePaymentIntentId,
      "refunded_after_capture",
      "PaymentIntent carries a refund; refusing to fulfil",
      ["pending", "processing"]
    );
    await releaseCart(stripePaymentIntentId);
    return { kind: "already_refunded" };
  }

  if (refundState === "unknown") {
    // Refuse to fulfil — but assert NOTHING. Writing `refunded_after_capture`
    // here would record, permanently and terminally, that money was captured and
    // returned, on the basis of a read that failed. A customer who then completes
    // 3-D Secure and pays would be blocked from their booking forever.
    capturePaymentError(
      new Error(
        `Refund state undeterminable for ${stripePaymentIntentId} (status=${pi.status}, no latest_charge) — refusing to fulfil, leaving the row re-drivable`
      ),
      { stripePaymentIntentId, amount: pi.amount / 100 }
    );
    return {
      kind: "needs_reconciliation",
      reason: "refund state undeterminable",
      retryable: true,
    };
  }

  // --- Step 2: PI must be in an authorized state -----------------------------
  const FULFILLABLE = ["requires_capture", "processing", "succeeded"];
  if (!FULFILLABLE.includes(pi.status)) {
    throw new PaymentNotConfirmedError(pi.status);
  }

  // --- Step 3: idempotency — does a booking already exist? -------------------
  const supabase = await createAdminClient();
  const { data: existing, error: existingError } = await supabase
    .from("bookings")
    .select("reslab_reservation_number")
    .eq("stripe_payment_intent_id", stripePaymentIntentId)
    .maybeSingle();

  // A DB fault here previously read as "no booking exists" and sent the engine on
  // toward a SECOND ResLab reservation. The webhook already applies the correct
  // rule — if you can't tell whether a booking exists, retry rather than risk
  // creating another one.
  if (existingError) {
    throw new DurableStateError("bookings idempotency read", existingError.message);
  }

  if (existing) {
    // Backfill the reservation number as we close the row out. Without it a
    // concurrent caller reaching Step 5 finds `completed` with a NULL number and
    // has to go re-read bookings itself.
    await supabase
      .from("pending_bookings")
      .update({ reslab_reservation_number: existing.reslab_reservation_number })
      .eq("stripe_payment_intent_id", stripePaymentIntentId)
      .is("reslab_reservation_number", null);

    await markTerminal(stripePaymentIntentId, "completed", undefined, [
      "pending",
      "processing",
    ]);
    await releaseCart(stripePaymentIntentId);
    return {
      kind: "already_exists",
      reservationNumber: existing.reslab_reservation_number,
    };
  }

  // --- Step 4: locate or self-create the durable pending row -----------------
  let row = await readPendingRow(stripePaymentIntentId);

  if (!row) {
    if (!input.payload) {
      // Nothing to fulfil from. The customer's card is authorized (or charged)
      // and we cannot reconstruct the reservation: PI metadata carries no
      // vehicle, name, or phone. Escalate loudly rather than guess.
      capturePaymentError(
        new Error(
          `No pending_bookings row for ${stripePaymentIntentId} (source=${source}); cannot fulfil without a payload`
        ),
        { stripePaymentIntentId, amount: pi.amount / 100 }
      );
      return {
        kind: "needs_reconciliation",
        reason: "no pending row and no payload",
        retryable: false,
      };
    }
    // Client path with an older bundle that never staged the row. Self-create so
    // the mutex and resume logic still apply.
    const { error: selfCreateError } = await supabase.from("pending_bookings").insert({
      stripe_payment_intent_id: stripePaymentIntentId,
      location_id: input.payload.locationId,
      costs_token: input.payload.costsToken,
      from_date: input.payload.fromDate,
      to_date: input.payload.toDate,
      parking_type_id: input.payload.parkingTypeId,
      customer: input.payload.customer,
      vehicle: input.payload.vehicle,
      extra_fields: input.payload.extraFields ?? null,
      location_name: input.payload.locationName ?? null,
      location_address: input.payload.locationAddress ?? null,
      airport_code: input.payload.airportCode ?? null,
      subtotal: input.payload.subtotal ?? null,
      tax_total: input.payload.taxTotal ?? null,
      fees_total: input.payload.feesTotal ?? null,
      grand_total: input.payload.grandTotal ?? null,
      triply_service_fee: input.payload.triplyServiceFee ?? null,
      user_id: input.payload.userId ?? null,
      has_protection_plan: input.payload.hasProtectionPlan,
      livemode: pi.livemode,
      status: "pending",
    });

    // 23505 means a concurrent caller staged it first — benign, re-read below.
    if (selfCreateError && (selfCreateError as { code?: string }).code !== "23505") {
      throw new DurableStateError("pending row self-create", selfCreateError.message);
    }

    row = await readPendingRow(stripePaymentIntentId);
    if (!row) {
      return {
        kind: "needs_reconciliation",
        reason: "pending row self-create failed",
        retryable: false,
      };
    }
  }

  // --- Step 5: terminal short-circuit ----------------------------------------
  if (TERMINAL_STATUSES.has(row.status)) {
    switch (row.status) {
      case "completed": {
        // The booking succeeded — another caller finished it between our Step-3
        // read and this line, which is the exact race three concurrent callers
        // exist to survive. Omitting this case fell through to `default` and told
        // a paying customer whose booking WORKED that it had failed, as a
        // terminal screen with no retry.
        if (row.reslab_reservation_number) {
          return {
            kind: "already_exists",
            reservationNumber: row.reslab_reservation_number,
          };
        }
        // NEVER fabricate the number with `?? ""` — that is the silent-default
        // anti-pattern, and it builds `/confirmation/?lot=…`, sending a paying
        // customer to a broken URL. A `completed` row can legitimately lack the
        // number (the Step-3 short-circuit marks completed from a bookings hit),
        // so go and read it.
        const { data: booked, error: bookedError } = await supabase
          .from("bookings")
          .select("reslab_reservation_number")
          .eq("stripe_payment_intent_id", stripePaymentIntentId)
          .maybeSingle();
        if (bookedError) {
          throw new DurableStateError(
            "completed-row booking lookup",
            bookedError.message
          );
        }
        if (booked?.reslab_reservation_number) {
          return {
            kind: "already_exists",
            reservationNumber: booked.reslab_reservation_number,
          };
        }
        capturePaymentError(
          new Error(
            `pending_bookings row for ${stripePaymentIntentId} is 'completed' but carries no reservation number and has no bookings row`
          ),
          { stripePaymentIntentId, amount: pi.amount / 100 }
        );
        return {
          kind: "needs_reconciliation",
          reason: "completed row has no reservation number",
          retryable: false,
        };
      }
      case "expired": {
        // `expired` means "no money was ever taken". If that is false — the
        // PaymentIntent has since succeeded or is holding an authorization — then
        // whatever retired this row was WRONG, and a customer has paid. Never let
        // that pass as a quiet `failed`, which returns 200 and stops Stripe
        // redelivering, leaving a charged customer with no booking and no alert.
        //
        // Defence in depth: the sweep now only expires PaymentIntents that
        // genuinely cannot succeed. This catches the case where that is ever
        // wrong again.
        if (pi.status === "succeeded" || pi.status === "requires_capture") {
          capturePaymentError(
            new Error(
              `PaymentIntent ${stripePaymentIntentId} is ${pi.status} but its pending row was retired as 'expired' — the customer HAS paid and has no booking. Recover manually.`
            ),
            { stripePaymentIntentId, amount: pi.amount / 100 }
          );
          return {
            kind: "needs_reconciliation",
            reason: "expired row for a PaymentIntent that carries money",
            retryable: false,
          };
        }
        return {
          kind: "failed",
          reason: "checkout expired",
          userMessage:
            "This checkout expired and was not completed. You have not been charged — please search again.",
        };
      }
      case "suspected_duplicate":
        return { kind: "suspected_duplicate" };
      case "refunded_sold_out":
      case "released_sold_out":
        return { kind: "sold_out" };
      case "refunded_after_capture":
        return { kind: "already_refunded" };
      case "needs_reconciliation":
      case "capture_ambiguous":
        return {
          kind: "needs_reconciliation",
          reason: `pending row already terminal: ${row.status}`,
          retryable: false,
        };
      default:
        return {
          kind: "failed",
          reason: `pending row already terminal: ${row.status}`,
          userMessage:
            "This booking could not be completed. If you were charged, our team will contact you.",
        };
    }
  }

  // --- Step 6: claim the mutex ------------------------------------------------
  const claimed = await claimPendingRow(stripePaymentIntentId);
  if (!claimed) {
    // Someone else is mid-fulfilment. The webhook caller MUST surface this as a
    // retryable failure so Stripe redelivers — that redelivery is what finishes
    // the job if the current holder dies. (It covers the common case; the sweep
    // cron covers the rest — abandoned rows and post-retry-budget stragglers.)
    return { kind: "in_progress" };
  }

  try {
    // Inside the try: a client payload is already Zod-validated, but a payload
    // reconstructed from the pending row may be invalid (corrupt JSONB, drifted
    // dates). A throw here lands in the catch below and, being neither a
    // DurableStateError nor otherwise self-healing, is marked terminal
    // needs_reconciliation (non-retryable) — the correct outcome for a row that
    // will never parse.
    const payload = input.payload ?? payloadFromPendingRow(claimed);
    return await fulfilClaimed(pi, claimed, payload, source);
  } catch (unexpected) {
    // Any escape from the fulfilment path leaves money in an unknown state.
    // Do NOT release blindly — a reservation may exist.
    const err =
      unexpected instanceof Error ? unexpected : new Error(String(unexpected));

    // ALERT FIRST, THEN WRITE. markTerminal can itself throw (it is one of the
    // helpers that raises DurableStateError), and when the underlying cause was
    // a degraded database it reliably does — which previously meant the alert
    // below never ran and the real cause, including "CHARGED with a live ResLab
    // reservation", never reached Sentry.
    capturePaymentError(err, {
      stripePaymentIntentId,
      amount: pi.amount / 100,
    });

    // A DATABASE fault says nothing about whether the booking can succeed, so it
    // must NOT be written terminal — doing so made the 503 we return pointless,
    // because the redelivery would short-circuit at step 5 on the very status we
    // just wrote. Release and let Stripe re-drive it.
    if (err instanceof DurableStateError) {
      return releaseForRetry(stripePaymentIntentId, err.message);
    }

    try {
      await markTerminal(
        stripePaymentIntentId,
        "needs_reconciliation",
        err.message
      );
    } catch (markError) {
      // The row is stuck in `processing`, so any monitor keyed on
      // needs_reconciliation will miss it. Say so explicitly.
      capturePaymentError(
        new Error(
          `Could not mark ${stripePaymentIntentId} needs_reconciliation after: ${err.message}. The row is STUCK in 'processing' and will not appear in the reconciliation queue.`
        ),
        { stripePaymentIntentId, amount: pi.amount / 100 }
      );
    }

    return { kind: "needs_reconciliation", reason: err.message, retryable: false };
  }
}

/**
 * Everything after the mutex is held. Split out so the caller can wrap it in a
 * single catch that always lands the row on a terminal status.
 */
async function fulfilClaimed(
  pi: Stripe.PaymentIntent,
  row: PendingRow,
  payload: BookingPayload,
  source: BookingSource
): Promise<CreateBookingResult> {
  const piId = pi.id;

  // --- Step 7: resume, or claim the cart --------------------------------------
  //
  // The cart claim is taken FIRST — before the settlement deferral below — and
  // deliberately so. It is a lightweight insert with no money and no ResLab side
  // effects, and holding it is what stops a second PaymentIntent fulfilling the
  // same cart while this one is still settling.
  //
  // Claiming AFTER the deferral reopened the Nadia/Jordan double-charge: an async
  // payment would defer without a claim, the impatient customer would rebook on a
  // new PI, that PI would claim the cart, complete, and RELEASE it on success —
  // and when the original payment finally settled, the webhook found the cart free
  // and created a second real reservation and a second charge.
  const resuming = !!row.reslab_reservation_number;

  if (!resuming) {
    const gotCart = await claimCart(cartKey(payload, pi.livemode), piId, pi.livemode);
    if (!gotCart) {
      const release = await releasePayment(pi);
      if (release.released === "deferred") {
        // This PaymentIntent is itself still settling, so it can be neither
        // cancelled nor refunded yet. Leave it non-terminal and hand the mutex
        // back — holding it would stall the next caller for STALE_CLAIM_MS for no
        // reason. When this PI settles it re-drives, and step 7.9 catches the
        // duplicate durably even if the cart claim has since been released.
        return releaseForRetry(
          piId,
          "lost the cart-claim race while still settling; will re-resolve on settlement"
        );
      }
      await markTerminal(
        piId,
        "suspected_duplicate",
        "another PaymentIntent already owns this cart"
      );
      capturePaymentError(
        new Error(
          `Duplicate cart detected — ${piId} ${release.released} (customer: ${payload.customer.email})`
        ),
        { stripePaymentIntentId: piId, amount: pi.amount / 100 }
      );
      return { kind: "suspected_duplicate" };
    }
  }

  // --- Step 7.5: defer the rest while the payment is still settling ------------
  // Everything past this point is irreversible — a real ResLab reservation, a
  // capture, a booking row, emails. None of it may happen until the money is
  // known to be arriving. Previously this check sat AFTER the ResLab call, so an
  // async (bank-backed) payment created a billable reservation before settlement,
  // and if the payment then failed nothing released it: `payment_failed` only
  // inspects `bookings`, and no booking row exists on this path.
  //
  // The cart claim above is KEPT while deferred — that is what reserves this cart
  // for this PaymentIntent until it settles. It expires on its own after
  // CART_CLAIM_WINDOW_MS, and `payment_intent.canceled` / `payment_failed`
  // release it explicitly.
  if (pi.status === "processing") {
    // Hand the pending-row mutex back, though. Nothing irreversible has happened,
    // so there is no reason to make the next caller wait out the full
    // STALE_CLAIM_MS (90s) to steal a claim we are no longer using — that stalled
    // every async-payment booking and burned a webhook redelivery.
    const supabase = await createAdminClient();
    let handBack = supabase
      .from("pending_bookings")
      .update({ status: "pending", claimed_at: null })
      .eq("stripe_payment_intent_id", piId)
      .eq("status", "processing");

    // Pin to the claim WE took, so we cannot hand back a claim another caller
    // legitimately stole in the meantime. That requires an invocation to outlive
    // STALE_CLAIM_MS (90s), which every route's maxDuration=60 prevents — but the
    // guarantee belongs in the query, not in an undocumented coupling between two
    // constants in different files. claimPendingRow always sets claimed_at, so
    // the null branch is unreachable; it degrades to the status-only guard rather
    // than sending an empty string to a timestamptz column.
    if (row.claimed_at) {
      handBack = handBack.eq("claimed_at", row.claimed_at);
    }

    const { error } = await handBack;
    if (error) throw new DurableStateError("defer claim release", error.message);
    return { kind: "deferred" };
  }

  // NOTE — no timing-independent "already booked this cart?" auto-refund here.
  //
  // A previous revision matched any confirmed booking with the same
  // email + lot + dates within a 7-day window and auto-cancelled/refunded the
  // new PaymentIntent as a duplicate. But email + lot + dates CANNOT tell "the
  // same cart settling twice" from "a genuine second purchase" — every
  // reservation is number_of_spots: 1, so a family parking two cars MUST check
  // out twice with that identical tuple. It refunded those real customers, and
  // had no livemode filter (bookings carries no environment column), so a
  // staging test booking could refund a live customer.
  //
  // Prevention stays where it belongs: the cart_claims lock (CART_CLAIM_WINDOW_MS)
  // stops the realistic rapid double-submit. The only case it misses — an async
  // payment settling AFTER its claim expired and re-booking — is NOT reachable
  // today (no async/BNPL methods are enabled; cards resolve to requires_capture,
  // not a multi-day `processing`). If it ever becomes reachable, the
  // duplicateBookings monitor (detect-payment-anomalies, plate-aware) surfaces it
  // for MANUAL review — an alert, never an automatic refund on a heuristic match.

  // --- Step 8: price + inventory refresh --------------------------------------
  if (!resuming) {
    const check = await refreshCost(pi, payload);
    if (check.blocked) {
      const release = await releasePayment(pi);
      if (release.released === "deferred") return { kind: "deferred" };
      const terminal =
        release.released === "refunded"
          ? check.soldOut
            ? "refunded_sold_out"
            : "refunded_failed"
          : check.soldOut
          ? "released_sold_out"
          : "released_failed";
      await markTerminal(piId, terminal, check.reason);
      await releaseCart(piId);
      capturePaymentError(
        new Error(`Fulfilment blocked before booking: ${check.reason}`),
        { stripePaymentIntentId: piId, amount: pi.amount / 100 }
      );
      return check.soldOut
        ? { kind: "sold_out" }
        : {
            kind: "failed",
            reason: check.reason,
            userMessage: check.userMessage,
          };
    }
    if (check.freshToken) payload.costsToken = check.freshToken;
  }

  // --- Step 9: ResLab reservation ---------------------------------------------
  let reservation: ReslabReservation;

  if (resuming) {
    // A previous attempt created the reservation but died before capture. Adopt
    // it — re-creating would double-book, since ResLab has no idempotency key.
    //
    // RE-FETCH rather than fabricate. This used to construct a two-field stub and
    // cast it to ReslabReservation, which left `history` undefined — so the
    // booking row stored due_at_location = $0, the confirmation email told the
    // customer $0 was due at the lot, and Park Guard enrolment ALWAYS skipped
    // (its address fields come only from history.location). getReservation is a
    // GET and therefore safe to repeat, unlike the POST this path is avoiding.
    try {
      reservation = await reslab.getReservation(row.reslab_reservation_number!);
    } catch (refetchError) {
      // We know a reservation exists but cannot read it back, so we can neither
      // bill it correctly nor enrol Park Guard. Do not guess at the amounts.
      //
      // RETRYABLE, not terminal. This is a GET on a path that never calls
      // createReservation, so re-attempting carries zero double-booking risk —
      // the textbook retryable case. ResLab's transient 502s are documented on
      // this codebase (2026-06-29), and marking terminal here poisoned a fully
      // recoverable booking (reservation live, authorization held) into manual
      // ops while the hold quietly expired.
      capturePaymentError(
        new Error(
          `Resume could not re-read ResLab reservation ${row.reslab_reservation_number} for ${piId}. The reservation EXISTS; do NOT re-create it. Retrying.`
        ),
        { stripePaymentIntentId: piId, amount: pi.amount / 100 }
      );
      return releaseForRetry(
        piId,
        `resume re-fetch failed for ${row.reslab_reservation_number}: ${
          refetchError instanceof Error ? refetchError.message : String(refetchError)
        }`
      );
    }
  } else {
    const supabase = await createAdminClient();
    await supabase
      .from("pending_bookings")
      .update({ reslab_attempt_started_at: new Date().toISOString() })
      .eq("stripe_payment_intent_id", piId);

    try {
      reservation = await createReslabReservation(payload);
    } catch (reslabError) {
      const failure = classifyReslabError(reslabError);

      if (!failure.definitive) {
        // AMBIGUOUS. A reservation may exist. Do not retry, do not release —
        // cancelling a hold for a reservation that DID commit means we owe
        // ResLab with no way to collect. Leave the authorization live and let
        // ops resolve inside the hold window.
        await markTerminal(
          piId,
          "needs_reconciliation",
          `ResLab ambiguous failure: ${
            reslabError instanceof Error ? reslabError.message : String(reslabError)
          }`
        );
        capturePaymentError(
          new Error(
            `AMBIGUOUS ResLab failure for ${piId} — reservation may or may not exist. Authorization left INTACT for manual reconciliation. Customer: ${payload.customer.email}, lot ${payload.locationId}, ${payload.fromDate} to ${payload.toDate}`
          ),
          { stripePaymentIntentId: piId, amount: pi.amount / 100 }
        );
        return {
          kind: "needs_reconciliation",
          reason: "ResLab ambiguous failure",
          retryable: false,
        };
      }

      // DEFINITIVE rejection — nothing was created, money can be released safely.
      const release = await releasePayment(pi);
      if (release.released === "deferred") return { kind: "deferred" };
      const terminal =
        release.released === "refunded"
          ? failure.soldOut
            ? "refunded_sold_out"
            : "refunded_failed"
          : failure.soldOut
          ? "released_sold_out"
          : "released_failed";
      await markTerminal(piId, terminal, failure.userMessage);
      await releaseCart(piId);
      return failure.soldOut
        ? { kind: "sold_out" }
        : {
            kind: "failed",
            reason: "ResLab rejected the reservation",
            userMessage: failure.userMessage,
          };
    }

    // Persist IMMEDIATELY. This single write is what makes a crash in the next
    // few milliseconds recoverable instead of an orphan.
    await recordReslabNumber(piId, reservation.reservation_number);
  }

  // --- Step 10: CAPTURE — the customer's money moves here, and only here ------
  if (pi.status === "requires_capture") {
    try {
      await capturePaymentIntent(piId);
    } catch (captureError) {
      // Stripe can capture successfully and then fail to return the response.
      // Re-retrieve before deciding anything — rolling back on an ambiguous
      // capture result is how you charge someone and delete their booking.
      const fresh = await stripe.paymentIntents
        .retrieve(piId)
        .catch(() => null);

      if (fresh?.status === "succeeded") {
        // The capture actually worked. Carry on; do NOT roll back.
      } else if (fresh?.status === "requires_capture") {
        // Definitively not captured. The reservation exists but is unpaid.
        await markTerminal(
          piId,
          "capture_ambiguous",
          `Capture failed with reservation ${reservation.reservation_number} live`
        );
        capturePaymentError(
          new Error(
            `CAPTURE FAILED after ResLab reservation ${reservation.reservation_number} was created (${piId}). Reservation is live and UNPAID — cancel it or re-attempt capture within the hold window.`
          ),
          { stripePaymentIntentId: piId, amount: pi.amount / 100 }
        );
        return {
          kind: "needs_reconciliation",
          reason: "capture failed after reservation created",
          retryable: false,
        };
      } else {
        await markTerminal(
          piId,
          "capture_ambiguous",
          `Capture result unknown for reservation ${reservation.reservation_number}`
        );
        capturePaymentError(
          new Error(
            `CAPTURE RESULT UNKNOWN for ${piId} with reservation ${reservation.reservation_number} live. Do not roll back without checking Stripe manually.`
          ),
          { stripePaymentIntentId: piId, amount: pi.amount / 100 }
        );
        return {
          kind: "needs_reconciliation",
          reason: "capture result unknown",
          retryable: false,
        };
      }
    }
  }
  // pi.status === "succeeded" — already captured (wallet auto-capture, or a
  // pre-cutover automatic PI). Nothing to do; fall through to persistence.
  //
  // `processing` cannot reach here: it returns `deferred` at step 6.5, before
  // anything irreversible happens.

  // --- Step 11: persist -------------------------------------------------------
  const persisted = await persistBooking(payload, reservation);

  if (persisted.duplicatePaymentIntent) {
    await markTerminal(piId, "completed");
    await releaseCart(piId);
    return {
      kind: "already_exists",
      reservationNumber: reservation.reservation_number,
    };
  }

  if (persisted.bookingInsertFailed) {
    // Money is captured and the reservation is live. A refund here would strand
    // a real ResLab booking the customer will try to use. Escalate instead.
    capturePaymentError(
      new Error(
        `CHARGED with a live ResLab reservation (${reservation.reservation_number}) but no bookings row for ${piId}. Customer WILL arrive at the lot. Retrying; repair manually if it does not clear.`
      ),
      { stripePaymentIntentId: piId, amount: pi.amount / 100 }
    );

    // A constraint violation will be rejected identically on every redelivery.
    // Retrying it burns Stripe's whole ~3-day budget and then parks the row at
    // `pending` with nothing left to re-drive it — and its cart claim stays live,
    // so the customer's next attempt at that lot and those dates gets refunded as
    // a duplicate. Go terminal so the reconciliation queue picks it up instead.
    if (persisted.bookingInsertPermanent) {
      await markTerminal(
        piId,
        "needs_reconciliation",
        "booking row insert rejected permanently (constraint violation) after capture"
      );
      await releaseCart(piId);
      return {
        kind: "needs_reconciliation",
        reason: "booking insert rejected permanently after capture",
        retryable: false,
      };
    }

    // Otherwise RETRYABLE. persistBooking reports Supabase failures as a flag
    // rather than throwing, so the purest database-fault class in the flow never
    // becomes a DurableStateError and used to be written terminal — leaving a
    // charged customer with a real parking spot, no confirmation email, and no
    // admin visibility, repairable only by hand. The architecture already
    // recovers this on a re-drive: step 7 resumes onto the recorded reservation,
    // step 9 re-fetches over a GET, step 10 skips capture because the PI is
    // already succeeded, and step 11 retries the insert.
    return releaseForRetry(piId, "booking row insert failed after capture");
  }

  // --- Step 12: emails — only on a genuinely new booking ----------------------
  if (!row.email_sent) {
    const { customerEmailSent } = await sendBookingEmails(
      payload,
      reservation,
      persisted.pgSyncStatus
    );
    if (customerEmailSent) await markEmailSent(piId);
  }

  await markTerminal(piId, "completed");
  await releaseCart(piId);

  captureBookingSuccessBreadcrumb(source, reservation.reservation_number);

  return {
    kind: "created",
    reservationNumber: reservation.reservation_number,
    reservation: buildReservationResponse(
      payload,
      reservation,
      persisted.pgIdentifier
    ),
  };
}

/**
 * Price and inventory revalidation before we commit.
 *
 * Non-blocking when ResLab is merely unreachable and the existing costs token is
 * still usable — a ResLab wobble shouldn't reject an otherwise-good booking that
 * the customer has already authorized. Blocking when ResLab positively tells us
 * the option is gone, or when the price has risen ABOVE what we authorized:
 * booking at a higher price than the customer agreed to is never acceptable.
 */
async function refreshCost(
  pi: Stripe.PaymentIntent,
  payload: BookingPayload
): Promise<
  | { blocked: false; freshToken?: string }
  | { blocked: true; soldOut: boolean; reason: string; userMessage: string }
> {
  try {
    const cost = await reslab.getCost(payload.locationId, [
      {
        type: "parking",
        reservation_type: "parking",
        type_id: payload.parkingTypeId,
        from_date: payload.fromDate,
        to_date: payload.toDate,
        number_of_spots: 1,
      },
    ]);

    if (cost.reservation.sold_out) {
      return {
        blocked: true,
        soldOut: true,
        reason: "ResLab reports the option sold out at fulfilment time",
        userMessage:
          "This parking option sold out while you were checking out. You have not been charged.",
      };
    }

    // What we would charge now, in the same shape /api/checkout/lot computed it.
    const protectionPremium = payload.hasProtectionPlan
      ? PROTECTION_PLAN.price
      : 0;
    // The promo discount MUST be reapplied here. /api/checkout/lot validates a
    // promo code server-side and subtracts `sub_total * pct/100` BEFORE creating
    // the PaymentIntent, so a recomputation without it always comes out higher
    // than the authorized amount — which tripped the drift guard below and
    // blocked EVERY promo-code booking with a bogus "the price changed" message.
    // Read from PI metadata, not the payload: that is what the charge was based on.
    const rawDiscount = pi.metadata?.discountPercent;
    let discountPercent = 0;
    if (rawDiscount != null && rawDiscount !== "") {
      const parsed = parseFloat(rawDiscount);
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
        // Silently coercing this to 0 would inflate the recomputed total, trip
        // the drift guard below, and tell the customer "the price changed" while
        // releasing their payment — with no signal to us. Same silent-coercion
        // class that num() alerts on above.
        captureBookingError(
          new Error(
            `PI ${pi.id} metadata.discountPercent is unusable (${JSON.stringify(
              rawDiscount
            )}) — the price-drift guard will block this booking`
          ),
          { step: "checkout", airportCode: payload.airportCode }
        );
      } else {
        discountPercent = parsed;
      }
    }
    const promoDiscount =
      discountPercent > 0
        ? cost.reservation.sub_total * (discountPercent / 100)
        : 0;

    const freshDueNow =
      cost.reservation.grand_total +
      (payload.triplyServiceFee || 0) -
      promoDiscount -
      cost.reservation.due_at_location +
      protectionPremium;
    const freshCents = Math.round(freshDueNow * 100);

    // One cent of tolerance for rounding. Anything above the authorized amount
    // means the customer would be booked at a price they never agreed to.
    if (freshCents > pi.amount + 1) {
      return {
        blocked: true,
        soldOut: false,
        reason: `price drift: fresh ${freshCents} cents exceeds authorized ${pi.amount} cents`,
        userMessage:
          "The price for this parking option changed while you were checking out. You have not been charged — please search again.",
      };
    }

    return { blocked: false, freshToken: cost.costs_token };
  } catch (costError) {
    // ResLab unreachable. The customer already has an authorization and a valid
    // token from checkout; proceed and let createReservation be the real test.
    // This is a deliberate non-blocking catch on a money path — documented per
    // the CLAUDE.md error-handling rule. It cannot mask a sold-out lot, because
    // createReservation rejects definitively in that case and releases payment.
    captureBookingError(
      new Error(
        `getCost refresh failed at fulfilment (proceeding on existing token): ${
          costError instanceof Error ? costError.message : String(costError)
        }`
      ),
      { step: "checkout", airportCode: payload.airportCode }
    );
    return { blocked: false };
  }
}

/** DEV_SKIP_PAYMENT path — no PaymentIntent, so no payment state machine. */
async function fulfilOnly(
  payload: BookingPayload
): Promise<CreateBookingResult> {
  const reservation = await createReslabReservation(payload);
  const persisted = await persistBooking(payload, reservation);
  await sendBookingEmails(payload, reservation, persisted.pgSyncStatus);
  return {
    kind: "created",
    reservationNumber: reservation.reservation_number,
    reservation: buildReservationResponse(
      payload,
      reservation,
      persisted.pgIdentifier
    ),
  };
}

function captureBookingSuccessBreadcrumb(
  source: BookingSource,
  reservationNumber: string
) {
  // Which entry point actually completed the booking is the key soak metric for
  // this rehaul: a rising share of `webhook` completions means browsers are
  // dying and the guarantee is doing its job.
  if (source === "webhook" || source === "complete" || source === "sweep") {
    captureBookingError(
      new Error(
        source === "sweep"
          ? `Booking ${reservationNumber} completed by the SWEEP — neither the browser nor the webhook finished it. Investigate why.`
          : `Booking ${reservationNumber} completed via ${source} path (browser did not finish it)`
      ),
      { step: "checkout" }
    );
  }
}
