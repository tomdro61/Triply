import type Stripe from "stripe";
import { createAdminClient } from "@/lib/supabase/server";
import {
  createRefundCents,
  cancelPaymentIntent,
  paymentIntentRefundState,
} from "@/lib/stripe/client";
import { parkGuard, ParkGuardError } from "@/lib/parkguard/client";
import { sendCancellationConfirmation } from "@/lib/resend/send-cancellation-confirmation";
import {
  captureAPIError,
  capturePaymentError,
  captureParkGuardError,
} from "@/lib/sentry";
import { computeCancellationRefund } from "./refund-math";
import { markCancelState, type CancelState } from "./claim";

/**
 * The shared money-movement core of a cancellation — the ONLY place that issues a
 * cancel refund, releases a hold, writes the terminal booking status, cancels
 * Park Guard, and emails the customer. Both the customer-facing handler
 * (perform.ts) and the reconciliation cron call it, so the refund math and the
 * durable-state writes can never drift between the two paths.
 *
 * Two steps, so each caller can guard them with its own pre-conditions:
 *   planTeardown()                 — decide WHAT the teardown is (no writes)
 *   finalizeCancelledReservation() — DO it (refund/release → persist → PG → email)
 *
 * finalize MUST be called only once the ResLab reservation is confirmed cancelled
 * (customer path: classifier 'proceed'; cron: state 'reslab_cancelled_refund_pending',
 * or 'held_reslab_ambiguous' after a GET confirms `cancelled`).
 */

/** The owned booking row (ownership already checked by the caller). */
export interface CancelBookingRow {
  id: string;
  status: string;
  reslab_reservation_number: string;
  location_name: string | null;
  location_address: string | null;
  check_in: string;
  check_out: string;
  location_timezone: string | null;
  protection_plan: string | null;
  protection_plan_price: string | number | null;
  pg_identifier: string | null;
  stripe_payment_intent_id: string | null;
  customers: {
    email: string | null;
    first_name: string | null;
    last_name: string | null;
  } | null;
}

/** What the Stripe teardown must do, decided BEFORE any side effect. */
export type Teardown =
  | { kind: "refund"; refundCents: number; pgWholesaleCents: number }
  | { kind: "release" }
  | { kind: "none" };

export type TeardownPlan =
  | {
      ok: true;
      teardown: Teardown;
      /** Already-refunded cents on the PI — drives the net refund AND the
       *  persisted 'refunded' vs 'cancelled' status on a re-drive. */
      priorRefundedCents: number;
      /** $6 PG wholesale withheld; hoisted so the email breakdown can disclose it
       *  even on the already-refunded path (teardown "none"). */
      pgWholesaleCents: number;
    }
  | { ok: false; reason: "processing" | "unknown" | "dirty_refund_math" };

/**
 * Decide the teardown from an already-retrieved, `latest_charge`-expanded PI. No
 * writes, no Sentry — returns `ok:false` for the three states the caller must
 * refuse/skip on (each maps it to its own response + alert): a still-settling PI,
 * an unreadable refund state, or dirty data that makes the refund non-finite.
 */
export function planTeardown(
  pi: Stripe.PaymentIntent,
  booking: Pick<CancelBookingRow, "protection_plan" | "protection_plan_price">,
): TeardownPlan {
  // Still settling → amount_received is 0; refunding/releasing now would drop the
  // spot without refunding a customer who WILL be charged once capture settles.
  if (pi.status === "processing") {
    return { ok: false, reason: "processing" };
  }
  // A succeeded PI whose charge we can't read — never guess.
  if (paymentIntentRefundState(pi) === "unknown") {
    return { ok: false, reason: "unknown" };
  }

  // Read from the expanded charge, never the non-existent `pi.amount_refunded`.
  const priorRefundedCents =
    pi.latest_charge && typeof pi.latest_charge !== "string"
      ? pi.latest_charge.amount_refunded ?? 0
      : 0;

  if (pi.status === "succeeded") {
    let refundCents: number;
    let pgWholesaleCents: number;
    try {
      ({ refundCents, pgWholesaleCents } = computeCancellationRefund({
        amountReceivedCents: pi.amount_received ?? 0,
        priorRefundedCents,
        protectionPlan: booking.protection_plan,
        protectionPlanPriceDollars: booking.protection_plan_price,
      }));
    } catch {
      // Non-finite refund from dirty data — MUST NOT reach Stripe (amount: NaN).
      return { ok: false, reason: "dirty_refund_math" };
    }
    return {
      ok: true,
      priorRefundedCents,
      pgWholesaleCents,
      teardown:
        refundCents > 0
          ? { kind: "refund", refundCents, pgWholesaleCents }
          : { kind: "none" },
    };
  }

  if (pi.status === "requires_capture") {
    // Authorized but never captured — nothing charged; release the hold.
    return { ok: true, priorRefundedCents, pgWholesaleCents: 0, teardown: { kind: "release" } };
  }

  // canceled / pre-payment — no money moved.
  return { ok: true, priorRefundedCents, pgWholesaleCents: 0, teardown: { kind: "none" } };
}

export interface FinalizeInput {
  booking: CancelBookingRow;
  piId: string;
  teardown: Teardown;
  priorRefundedCents: number;
  pgWholesaleCents: number;
  ownedAt: string;
  /** Sentry endpoint tag — differs between the route and the cron. */
  endpoint: string;
}

export type FinalizeOutcome =
  /** The refund failed after ResLab was cancelled; row marked refund-pending and
   *  the claim kept for the next cron pass. */
  | { kind: "refund_pending" }
  /** Terminal: money outcome resolved, terminal status attempted. */
  | {
      kind: "done";
      status: "refunded" | "cancelled";
      wasRefunded: boolean;
      refundDollars: number;
      /** False when the pinned terminal write didn't land (updateError or
       *  stale-stolen) — the caller decides how to report it. */
      persistedByUs: boolean;
    };

export async function finalizeCancelledReservation(
  input: FinalizeInput,
): Promise<FinalizeOutcome> {
  const {
    booking,
    piId,
    teardown,
    priorRefundedCents,
    pgWholesaleCents,
    ownedAt,
    endpoint,
  } = input;
  const reservationNumber = booking.reslab_reservation_number;

  // 1. Stripe teardown.
  let refundIssuedThisCall = false;
  if (teardown.kind === "refund") {
    try {
      // Reason-independent idempotency key (on the PI alone): a stale-stolen or
      // cron re-drive that re-refunds hits the SAME key → no double refund.
      await createRefundCents(piId, teardown.refundCents, `selfcancel:${piId}`);
      refundIssuedThisCall = true;
    } catch (error) {
      // ResLab is already cancelled but the refund didn't go through. Do NOT
      // report success — keep the claim + mark refund-pending for the cron.
      capturePaymentError(
        error instanceof Error ? error : new Error(String(error)),
        { stripePaymentIntentId: piId, amount: teardown.refundCents / 100 },
      );
      await markCancelState(reservationNumber, ownedAt, "reslab_cancelled_refund_pending", endpoint);
      return { kind: "refund_pending" };
    }
  } else if (teardown.kind === "release") {
    try {
      await cancelPaymentIntent(piId);
    } catch (error) {
      // Hold couldn't be released; ResLab already cancelled. Stripe expires the
      // hold within days on its own — soft failure, log and continue.
      capturePaymentError(
        error instanceof Error ? error : new Error(String(error)),
        { stripePaymentIntentId: piId },
      );
    }
  }

  // 2. TRUE money outcome — "does the customer's money sit refunded", NOT "did I
  //    just call Stripe". On a re-drive the prior attempt may have already
  //    refunded (refundCents then 0, Stripe skipped), so derive from the PI's
  //    actual refunded amount too, or we'd persist 'cancelled' on a refunded row.
  const wasRefunded = refundIssuedThisCall || priorRefundedCents > 0;
  const newStatus: "refunded" | "cancelled" = wasRefunded ? "refunded" : "cancelled";

  // 3. Persist terminal status (admin client — session UPDATE is RLS-blocked by
  //    migration 012). PINNED to ownedAt so a stale-stolen resumer can't clobber
  //    the new owner. service_fee_refunded: true — self-cancel always returns the
  //    fee (reconcile.ts excludes it from kept revenue).
  const admin = await createAdminClient();
  const { data: persisted, error: updateError } = await admin
    .from("bookings")
    .update({
      status: newStatus,
      cancel_state: "refund_issued" satisfies CancelState,
      service_fee_refunded: true,
    })
    .eq("reslab_reservation_number", reservationNumber)
    .eq("cancel_claimed_at", ownedAt)
    .select("id")
    .maybeSingle();
  const persistedByUs = !updateError && !!persisted;
  // Distinguish the two "not persisted by us" cases. A genuine DB fault
  // (updateError) has NO new owner — WE must still notify the customer (the refund
  // landed). A stale-stolen claim (!persisted) DOES have a new owner that
  // re-drives and notifies — so only that case suppresses the email.
  const staleStolenNoOp = !updateError && !persisted;
  if (updateError) {
    captureAPIError(
      new Error(
        `cancel finalize: terminal status write failed for ${reservationNumber} (refunded=${wasRefunded}): ${updateError.message}`,
      ),
      { endpoint, method: "POST", statusCode: 500 },
    );
  } else if (!persisted) {
    captureAPIError(
      new Error(
        `cancel finalize: terminal write no-op for ${reservationNumber} (claim stale-stolen; another owner finalizes)`,
      ),
      { endpoint, method: "POST", statusCode: 200 },
    );
  }

  // 4. Park Guard cancel + clear pg_identifier (best-effort). Gated on OUR persist
  //    so we never desync PG ahead of an unwritten row, nor act on a row a new
  //    owner now holds. The clear is also pinned.
  if (booking.protection_plan && booking.id && persistedByUs) {
    try {
      await parkGuard.updateReservation(booking.id, { status: "cancelled" });
      const { error: pgClearError } = await admin
        .from("bookings")
        .update({ pg_identifier: null })
        .eq("reslab_reservation_number", reservationNumber)
        .eq("cancel_claimed_at", ownedAt);
      if (pgClearError) {
        captureParkGuardError(
          new Error(
            `cancel finalize: pg_identifier not cleared for ${reservationNumber}: ${pgClearError.message}`,
          ),
          { bookingId: booking.id, reslabReservationNumber: reservationNumber, operation: "update" },
        );
      }
    } catch (pgError) {
      const err = pgError instanceof Error ? pgError : new Error(String(pgError));
      captureParkGuardError(err, {
        bookingId: booking.id,
        reslabReservationNumber: reservationNumber,
        operation: "update",
        ...(pgError instanceof ParkGuardError && { statusCode: pgError.statusCode }),
      });
    }
  }

  // 5. Cancellation email (best-effort). Refund figure = TOTAL on the PI (prior +
  //    this call). Skip only for stale-stolen (a new owner emails); on updateError
  //    WE still email — the refund landed and no new owner exists.
  const totalRefundedCents =
    priorRefundedCents +
    (refundIssuedThisCall && teardown.kind === "refund" ? teardown.refundCents : 0);
  const refundDollars = wasRefunded ? totalRefundedCents / 100 : 0;
  const pgWholesaleDollars = pgWholesaleCents / 100; // 0 when no PG / no charge
  const pgPremiumDollars = booking.protection_plan
    ? parseFloat(String(booking.protection_plan_price ?? "0")) || 0
    : 0;
  const protectionPlanRefundDollars =
    wasRefunded && booking.protection_plan
      ? Math.max(0, pgPremiumDollars - pgWholesaleDollars)
      : 0;
  // Invariant (mirrors the admin route): the protection refund can't exceed the
  // total refund — if it does, the withholding math is inconsistent. The email
  // clamps this render-side and can't alert, so surface it here.
  if (wasRefunded && protectionPlanRefundDollars > refundDollars) {
    captureAPIError(
      new Error(
        `cancel finalize: protection refund $${protectionPlanRefundDollars} exceeds total refund $${refundDollars} ` +
          `(premium=${pgPremiumDollars}, withheld=${pgWholesaleDollars}) for ${reservationNumber} — withholding math inconsistent`,
      ),
      { endpoint, method: "POST", statusCode: 200 },
    );
  }
  const customer = booking.customers;
  if (!staleStolenNoOp && customer?.email) {
    try {
      await sendCancellationConfirmation({
        to: customer.email,
        customerName:
          `${customer.first_name || ""} ${customer.last_name || ""}`.trim() || "Customer",
        confirmationNumber: reservationNumber,
        lotName: booking.location_name || "Parking Location",
        lotAddress: booking.location_address || "",
        checkInDate: booking.check_in,
        checkOutDate: booking.check_out,
        refundAmount: refundDollars,
        wasRefunded,
        protectionPlanRefund:
          protectionPlanRefundDollars > 0 ? protectionPlanRefundDollars : undefined,
        protectionPlanRetained: pgWholesaleDollars > 0 ? pgWholesaleDollars : undefined,
      });
    } catch (error) {
      captureAPIError(
        error instanceof Error ? error : new Error(String(error)),
        { endpoint, method: "POST", statusCode: 200 },
      );
    }
  }

  return { kind: "done", status: newStatus, wasRefunded, refundDollars, persistedByUs };
}
