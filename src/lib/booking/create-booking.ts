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
  paymentIntentHasRefund,
} from "@/lib/stripe/client";
import { capturePaymentError, captureBookingError } from "@/lib/sentry";
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

// =============================================================================
// Result types
// =============================================================================

export type BookingSource = "client" | "complete" | "webhook" | "dev";

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
  /** MONEY MAY BE HELD OR TAKEN and booking state is unknown. Manual ops. */
  | { kind: "needs_reconciliation"; reason: string }
  /** Definitive failure. Payment released; customer not charged. */
  | { kind: "failed"; reason: string; userMessage: string };

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
      if (paymentIntentHasRefund(pi)) return { released: "refunded" };
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

interface PendingRow {
  stripe_payment_intent_id: string;
  status: string;
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

const TERMINAL_STATUSES = new Set([
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
]);

function num(v: string | number | null | undefined): number | undefined {
  if (v === null || v === undefined) return undefined;
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : undefined;
}

function payloadFromPendingRow(row: PendingRow): BookingPayload {
  return {
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
    subtotal: num(row.subtotal),
    taxTotal: num(row.tax_total),
    feesTotal: num(row.fees_total),
    grandTotal: num(row.grand_total),
    triplyServiceFee: num(row.triply_service_fee),
    userId: row.user_id,
    stripePaymentIntentId: row.stripe_payment_intent_id,
    hasProtectionPlan: row.has_protection_plan,
  };
}

/** Cart IDENTITY. Deliberately excludes amount — toggling Park Guard or a ResLab
 *  price refresh changes the amount while the cart is plainly the same cart. */
export function cartKey(payload: BookingPayload): string {
  return [
    payload.customer.email.trim().toLowerCase(),
    payload.locationId,
    payload.fromDate,
    payload.toDate,
    payload.parkingTypeId,
  ].join("|");
}

async function readPendingRow(pi: string): Promise<PendingRow | null> {
  const supabase = await createAdminClient();
  const { data } = await supabase
    .from("pending_bookings")
    .select("*")
    .eq("stripe_payment_intent_id", pi)
    .maybeSingle();
  return (data as PendingRow | null) ?? null;
}

/**
 * Atomic mutex claim. A single UPDATE ... RETURNING — never SELECT-then-UPDATE,
 * which would let two callers both observe `pending` and both proceed.
 *
 * Claimable when the row is fresh (`pending`) or when a previous claim has gone
 * stale (the caller died mid-fulfilment). Stealing a stale claim is what lets
 * Stripe's webhook retry finish a job the browser abandoned — it is the reason
 * this design needs no sweep cron.
 */
async function claimPendingRow(pi: string): Promise<PendingRow | null> {
  const supabase = await createAdminClient();
  const staleBefore = new Date(Date.now() - STALE_CLAIM_MS).toISOString();

  const { data } = await supabase
    .from("pending_bookings")
    .update({ status: "processing", claimed_at: new Date().toISOString() })
    .eq("stripe_payment_intent_id", pi)
    .or(`status.eq.pending,and(status.eq.processing,claimed_at.lt.${staleBefore})`)
    .select("*")
    .maybeSingle();

  return (data as PendingRow | null) ?? null;
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
  status: string,
  lastError?: string,
  /** Statuses this transition may move FROM. Defaults to `processing` only —
   *  i.e. only the caller currently holding the mutex may finish the job, which
   *  is what makes every money-releasing branch fire at most once.
   *
   *  Widened to include `pending` for transitions that run BEFORE the mutex is
   *  claimed (the refund gate and the already-booked short-circuit). Without
   *  that, those rows would be left non-terminal forever and would surface as
   *  false "stuck booking" alerts even though nothing is wrong. */
  fromStatuses: string[] = ["processing"]
): Promise<boolean> {
  const supabase = await createAdminClient();
  const { data } = await supabase
    .from("pending_bookings")
    .update({
      status,
      ...(lastError ? { last_error: lastError.slice(0, 2000) } : {}),
    })
    .eq("stripe_payment_intent_id", pi)
    .in("status", fromStatuses)
    .select("stripe_payment_intent_id")
    .maybeSingle();
  return !!data;
}

async function recordReslabNumber(pi: string, reservationNumber: string) {
  const supabase = await createAdminClient();
  await supabase
    .from("pending_bookings")
    .update({ reslab_reservation_number: reservationNumber })
    .eq("stripe_payment_intent_id", pi);
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
  const expiredBefore = new Date(Date.now() - CART_CLAIM_WINDOW_MS).toISOString();
  await supabase
    .from("cart_claims")
    .update({ released_at: new Date().toISOString() })
    .eq("cart_key", key)
    .is("released_at", null)
    .lt("claimed_at", expiredBefore);

  const { error } = await supabase
    .from("cart_claims")
    .insert({ cart_key: key, stripe_payment_intent_id: pi, livemode });

  if (!error) return true;

  // 23505 = the partial unique index fired: a live claim exists. If it's OURS
  // (a re-drive of the same PI), that's not a duplicate cart.
  if ((error as { code?: string }).code === "23505") {
    const { data } = await supabase
      .from("cart_claims")
      .select("stripe_payment_intent_id")
      .eq("cart_key", key)
      .is("released_at", null)
      .maybeSingle();
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
  await supabase
    .from("cart_claims")
    .update({ released_at: new Date().toISOString() })
    .eq("stripe_payment_intent_id", pi)
    .is("released_at", null);
}

async function markEmailSent(pi: string) {
  const supabase = await createAdminClient();
  await supabase
    .from("pending_bookings")
    .update({ email_sent: true })
    .eq("stripe_payment_intent_id", pi);
}

// =============================================================================
// The engine
// =============================================================================

export async function createBooking(
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
  if (paymentIntentHasRefund(pi)) {
    await markTerminal(
      stripePaymentIntentId,
      "refunded_after_capture",
      "PaymentIntent carries a refund; refusing to fulfil",
      ["pending", "processing"]
    );
    await releaseCart(stripePaymentIntentId);
    return { kind: "already_refunded" };
  }

  // --- Step 2: PI must be in an authorized state -----------------------------
  const FULFILLABLE = ["requires_capture", "processing", "succeeded"];
  if (!FULFILLABLE.includes(pi.status)) {
    throw new PaymentNotConfirmedError(pi.status);
  }

  // --- Step 3: idempotency — does a booking already exist? -------------------
  const supabase = await createAdminClient();
  const { data: existing } = await supabase
    .from("bookings")
    .select("reslab_reservation_number")
    .eq("stripe_payment_intent_id", stripePaymentIntentId)
    .maybeSingle();

  if (existing) {
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
      };
    }
    // Client path with an older bundle that never staged the row. Self-create so
    // the mutex and resume logic still apply.
    await supabase.from("pending_bookings").insert({
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
    row = await readPendingRow(stripePaymentIntentId);
    if (!row) {
      return {
        kind: "needs_reconciliation",
        reason: "pending row self-create failed",
      };
    }
  }

  // --- Step 5: terminal short-circuit ----------------------------------------
  if (TERMINAL_STATUSES.has(row.status)) {
    switch (row.status) {
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
    // the job if the current holder dies, and is why no sweep cron is needed.
    return { kind: "in_progress" };
  }

  const payload = input.payload ?? payloadFromPendingRow(claimed);

  try {
    return await fulfilClaimed(pi, claimed, payload, source);
  } catch (unexpected) {
    // Any escape from the fulfilment path leaves money in an unknown state.
    // Do NOT release blindly — a reservation may exist.
    const err =
      unexpected instanceof Error ? unexpected : new Error(String(unexpected));
    await markTerminal(
      stripePaymentIntentId,
      "needs_reconciliation",
      err.message
    );
    capturePaymentError(err, {
      stripePaymentIntentId,
      amount: pi.amount / 100,
    });
    return { kind: "needs_reconciliation", reason: err.message };
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
  const resuming = !!row.reslab_reservation_number;

  if (!resuming) {
    const gotCart = await claimCart(cartKey(payload), piId, pi.livemode);
    if (!gotCart) {
      const release = await releasePayment(pi);
      if (release.released === "deferred") {
        // Still settling — cannot release yet. Leave non-terminal.
        return { kind: "deferred" };
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
    reservation = {
      reservation_number: row.reslab_reservation_number!,
      cancelled: false,
    } as ReslabReservation;
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
        };
      }
    }
  } else if (pi.status === "processing") {
    // Defer EVERYTHING, not just the capture. Inserting the booking now would
    // satisfy the step-3 idempotency gate on the webhook's re-drive, and the
    // capture would never happen — a booked, authorized, never-charged customer.
    return { kind: "deferred" };
  }
  // pi.status === "succeeded" — already captured (wallet auto-capture, or a
  // pre-cutover automatic PI). Nothing to do; fall through to persistence.

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
    await markTerminal(
      piId,
      "needs_reconciliation",
      "booking row insert failed after capture"
    );
    capturePaymentError(
      new Error(
        `CHARGED with a live ResLab reservation (${reservation.reservation_number}) but no bookings row for ${piId}. Customer WILL arrive at the lot. Repair the row manually.`
      ),
      { stripePaymentIntentId: piId, amount: pi.amount / 100 }
    );
    return {
      kind: "needs_reconciliation",
      reason: "booking insert failed after capture",
    };
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
    const freshDueNow =
      cost.reservation.grand_total +
      (payload.triplyServiceFee || 0) -
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
  if (source === "webhook" || source === "complete") {
    captureBookingError(
      new Error(
        `Booking ${reservationNumber} completed via ${source} path (browser did not finish it)`
      ),
      { step: "checkout" }
    );
  }
}
