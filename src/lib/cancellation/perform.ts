import type Stripe from "stripe";
import { createAdminClient } from "@/lib/supabase/server";
import { reslab } from "@/lib/reslab/client";
import {
  stripe,
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
import { isCancellable } from "./eligibility";
import { computeCancellationRefund } from "./refund-math";
import { claimForCancel, releaseClaim, type CancelState } from "./claim";
import { classifyCancelOutcome } from "./reslab-cancel";

/**
 * The self-service cancellation orchestration — the money path. Kept OUT of the
 * route handler so it is unit-testable end-to-end (FakeSupabase + mocked
 * Stripe/ResLab) without Next request plumbing. The route does auth + the
 * RLS-scoped ownership read, then hands the owned booking row here.
 *
 * Order of operations is deliberate and load-bearing (v3.1 §5):
 *   status pre-check → 24h gate → PRE-CLAIM live-PI guard + refund math →
 *   atomic claim → ResLab cancel + classify → Stripe teardown → persist →
 *   Park Guard → email. Everything that computes the refund runs BEFORE the
 *   claim so a dirty-data throw can never leave a claim or a HOLD; the claim is
 *   the last thing before the first side effect (the ResLab cancel).
 */

const ENDPOINT = "/api/user/bookings/[reservationNumber]/cancel";

/** The owned booking row (already ownership-checked via RLS by the route). */
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

export interface CancelResult {
  status: number;
  body: Record<string, unknown>;
}

/** What the Stripe teardown must do, decided BEFORE the claim / any side effect. */
type Teardown =
  | { kind: "refund"; refundCents: number; pgWholesaleCents: number }
  | { kind: "release" }
  | { kind: "none" };

export async function performSelfCancel(
  booking: CancelBookingRow,
  now: number = Date.now(),
): Promise<CancelResult> {
  const reservationNumber = booking.reslab_reservation_number;
  const piId = booking.stripe_payment_intent_id;

  // 1. Status pre-check. Terminal is idempotent success; anything non-confirmed
  //    can't be cancelled online.
  if (booking.status === "cancelled" || booking.status === "refunded") {
    return {
      status: 200,
      body: { alreadyCancelled: true, status: booking.status },
    };
  }
  if (booking.status !== "confirmed") {
    return {
      status: 409,
      body: {
        error: "not_cancellable",
        message: `This reservation is ${booking.status} and can't be cancelled online.`,
      },
    };
  }

  // 2. Airport-local 24h gate (server-side only). Fails CLOSED.
  const gate = isCancellable(booking.check_in, booking.location_timezone, now);
  if (!gate.cancellable) {
    if (gate.reason === "within_24h") {
      return {
        status: 422,
        body: {
          error: "within_24h",
          message:
            "Cancellations are only available more than 24 hours before check-in. Please contact support for help.",
        },
      };
    }
    // Missing/invalid timezone or timestamp — a data problem, not a customer one.
    // Alert and route to support rather than risk a wrong decision.
    captureAPIError(
      new Error(
        `self-cancel gate fail-closed for ${reservationNumber}: ${gate.reason} (check_in=${booking.check_in}, tz=${booking.location_timezone})`,
      ),
      { endpoint: ENDPOINT, method: "POST", statusCode: 422 },
    );
    return {
      status: 422,
      body: {
        error: "unavailable",
        message:
          "We couldn't verify this reservation's cancellation window. Please contact support.",
      },
    };
  }

  // 3. A confirmed booking with no PaymentIntent has no amount source. Under the
  //    atomicity model this shouldn't happen, so treat it as the anomaly it is:
  //    refuse + alert rather than cancel-without-refund (spec §5.6). This also
  //    narrows `piId` to a non-null string for the rest of the function.
  if (!piId) {
    captureAPIError(
      new Error(
        `self-cancel: confirmed booking ${reservationNumber} has no stripe_payment_intent_id — no amount source, refusing`,
      ),
      { endpoint: ENDPOINT, method: "POST", statusCode: 409 },
    );
    return {
      status: 409,
      body: {
        error: "unavailable",
        message:
          "We couldn't verify this reservation's payment. Please contact support.",
      },
    };
  }

  // 4. PRE-CLAIM live-PI guard + refund plan. NO side effects here — this only
  //    reads Stripe and decides the teardown, so a still-settling payment or a
  //    dirty-data refund throw aborts BEFORE we claim or touch ResLab. Retrieve
  //    with `latest_charge` expanded so the refund-state gate and prior-refund
  //    math can read the charge.
  let pi: Stripe.PaymentIntent;
  try {
    pi = await stripe.paymentIntents.retrieve(piId, {
      expand: ["latest_charge"],
    });
  } catch (error) {
    capturePaymentError(
      error instanceof Error ? error : new Error(String(error)),
      { stripePaymentIntentId: piId },
    );
    return {
      status: 503,
      body: {
        error: "payment_lookup_failed",
        message:
          "We couldn't reach the payment processor. Please try again in a moment.",
      },
    };
  }

  // Still settling: amount_received is 0, so the refund math would compute $0 and
  // we'd release the ResLab spot WITHOUT refunding a customer who WILL be charged
  // once capture settles. Refuse until it's terminal.
  if (pi.status === "processing") {
    return {
      status: 409,
      body: {
        error: "payment_settling",
        message:
          "Your payment is still processing. Please try again in a few minutes.",
      },
    };
  }

  // Refund-state gate (G1). "unknown" = a succeeded PI whose charge we can't read
  // — never guess; route to support.
  const refundState = paymentIntentRefundState(pi);
  if (refundState === "unknown") {
    capturePaymentError(
      new Error(
        `self-cancel: refund state undeterminable for ${piId} (status=${pi.status})`,
      ),
      { stripePaymentIntentId: piId },
    );
    return {
      status: 409,
      body: {
        error: "unavailable",
        message:
          "We couldn't verify this reservation's payment. Please contact support.",
      },
    };
  }

  // How much was ALREADY refunded on this PI. Drives the net refund AND — on a
  // stale-reclaim of an already-refunded booking — the persisted 'refunded' vs
  // 'cancelled' status (step 7). Read from the expanded charge, never the
  // non-existent `pi.amount_refunded`.
  const priorRefundedCents =
    pi.latest_charge && typeof pi.latest_charge !== "string"
      ? pi.latest_charge.amount_refunded ?? 0
      : 0;

  let teardown: Teardown = { kind: "none" };
  // Hoisted so the email breakdown can disclose the $6 retained even on the
  // already-refunded replay path (teardown "none", but a refund did happen).
  let pgWholesaleCents = 0;
  if (pi.status === "succeeded") {
    let refundCents: number;
    try {
      ({ refundCents, pgWholesaleCents } = computeCancellationRefund({
        amountReceivedCents: pi.amount_received ?? 0,
        priorRefundedCents,
        protectionPlan: booking.protection_plan,
        protectionPlanPriceDollars: booking.protection_plan_price,
      }));
    } catch (error) {
      // Non-finite refund from dirty data. MUST NOT surface as a bare 500 or
      // reach Stripe (amount: NaN). Nothing has happened yet — safe to abort.
      captureAPIError(
        error instanceof Error ? error : new Error(String(error)),
        { endpoint: ENDPOINT, method: "POST", statusCode: 500 },
      );
      return {
        status: 500,
        body: {
          error: "refund_calc_failed",
          message:
            "We couldn't calculate your refund, so we did NOT cancel your reservation. Please contact support.",
        },
      };
    }
    teardown =
      refundCents > 0
        ? { kind: "refund", refundCents, pgWholesaleCents }
        : { kind: "none" };
  } else if (pi.status === "requires_capture") {
    // Authorized but never captured — nothing was charged; release the hold.
    teardown = { kind: "release" };
  }
  // else canceled / pre-payment — no money moved, teardown stays "none".

  // 4. Atomic claim. From here we hold it: every pre-money abort releases it.
  let claim;
  try {
    claim = await claimForCancel(reservationNumber, now);
  } catch (error) {
    captureAPIError(
      error instanceof Error ? error : new Error(String(error)),
      { endpoint: ENDPOINT, method: "POST", statusCode: 500 },
    );
    return {
      status: 500,
      body: { error: "server_error", message: "Something went wrong. Please try again." },
    };
  }
  if (!claim.claimed) {
    if (claim.reason === "already_terminal") {
      return { status: 200, body: { alreadyCancelled: true } };
    }
    return {
      status: 409,
      body: {
        error: "in_progress",
        message: "This cancellation is already being processed. Please wait a moment.",
      },
    };
  }
  const ownedAt = claim.ownedAt;

  // 5. ResLab cancel + classify (the first side effect).
  let cancelResult:
    | { ok: true; reservation: Awaited<ReturnType<typeof reslab.cancelReservation>> }
    | { ok: false; error: unknown };
  try {
    const reservation = await reslab.cancelReservation(reservationNumber);
    cancelResult = { ok: true, reservation };
  } catch (error) {
    cancelResult = { ok: false, error };
  }
  const outcome = await classifyCancelOutcome(reservationNumber, cancelResult);

  if (outcome.outcome === "refuse") {
    // Reservation still active / cancel rejected → release the claim, refund
    // NOTHING (the spot is still live and billable).
    await safeRelease(reservationNumber, ownedAt);
    captureAPIError(
      new Error(`self-cancel refused for ${reservationNumber}: ${outcome.detail}`),
      { endpoint: ENDPOINT, method: "POST", statusCode: 409 },
    );
    return {
      status: 409,
      body: {
        error: "cannot_cancel",
        message:
          "This reservation can no longer be cancelled online (it may have already started). Please contact support.",
      },
    };
  }

  if (outcome.outcome === "hold") {
    // Ambiguous — KEEP the claim, mark HELD, let the reconciliation cron finish.
    await markCancelState(reservationNumber, ownedAt, "held_reslab_ambiguous");
    captureAPIError(
      new Error(`self-cancel HOLD (ambiguous ResLab) for ${reservationNumber}: ${outcome.detail}`),
      { endpoint: ENDPOINT, method: "POST", statusCode: 202 },
    );
    return {
      status: 202,
      body: {
        status: "processing",
        message: "We're processing your cancellation and will confirm by email shortly.",
      },
    };
  }

  // outcome === "proceed": the ResLab spot IS released. Now the money teardown.

  // 6. Stripe teardown.
  let refundIssuedThisCall = false;
  if (teardown.kind === "refund") {
    try {
      // Reason-independent idempotency key (on the PI alone): a stale-stolen
      // re-drive that re-cancels + re-refunds hits the SAME key → no double refund.
      await createRefundCents(piId, teardown.refundCents, `selfcancel:${piId}`);
      refundIssuedThisCall = true;
    } catch (error) {
      // ResLab is already cancelled but the refund didn't go through. Do NOT
      // report success. Keep the claim + mark refund-pending for the cron/admin.
      capturePaymentError(
        error instanceof Error ? error : new Error(String(error)),
        { stripePaymentIntentId: piId, amount: teardown.refundCents / 100 },
      );
      await markCancelState(reservationNumber, ownedAt, "reslab_cancelled_refund_pending");
      return {
        status: 202,
        body: {
          status: "processing",
          message:
            "Your reservation was cancelled. Your refund is processing and will appear shortly.",
        },
      };
    }
  } else if (teardown.kind === "release") {
    try {
      await cancelPaymentIntent(piId);
    } catch (error) {
      // The auth hold couldn't be released; ResLab is already cancelled. Stripe
      // expires the hold within days on its own — soft failure, log and continue.
      capturePaymentError(
        error instanceof Error ? error : new Error(String(error)),
        { stripePaymentIntentId: piId },
      );
    }
  }

  // 7. The TRUE money outcome. `refunded` is NOT "did I just call Stripe" — it's
  //    "does the customer's money sit refunded". On a stale-reclaim the prior
  //    attempt may have already refunded (refundCents then computed to 0 and we
  //    correctly skipped Stripe), so derive from the PI's actual refunded amount
  //    too — otherwise we'd persist 'cancelled' on a genuinely refunded booking
  //    and corrupt accounting (which trusts status='refunded' to mean money moved).
  const wasRefunded = refundIssuedThisCall || priorRefundedCents > 0;
  const newStatus = wasRefunded ? "refunded" : "cancelled";

  // 8. Persist terminal status (admin client — session UPDATE is RLS-blocked by
  //    migration 012). PINNED to ownedAt like every other claim-holding write, so
  //    a request whose claim was stale-stolen mid-teardown can't clobber the new
  //    owner. `service_fee_refunded: true` because self-cancel ALWAYS returns the
  //    service fee — reconcile.ts reads this to exclude the fee from kept revenue.
  //    `cancel_state: "refund_issued"` is the terminal FSM marker; the money
  //    outcome lives in `status`.
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
  if (updateError) {
    // Money already moved / hold released + ResLab cancelled, but the terminal
    // write failed. Alert loudly; the row stays confirmed+claimed and the cron
    // reconciles. The cancel DID happen, so we still report success.
    captureAPIError(
      new Error(
        `self-cancel: terminal status write failed for ${reservationNumber} after teardown (refunded=${wasRefunded}): ${updateError.message}`,
      ),
      { endpoint: ENDPOINT, method: "POST", statusCode: 500 },
    );
  } else if (!persisted) {
    // Pinned write matched nothing → our claim was stale-stolen mid-teardown. The
    // new owner finalizes (idempotently, via the selfcancel:<pi> key). Don't run
    // PG/email on a row we no longer own; still report success (our money outcome
    // is truthful).
    captureAPIError(
      new Error(
        `self-cancel: terminal write no-op for ${reservationNumber} (claim stale-stolen mid-teardown; new owner finalizes)`,
      ),
      { endpoint: ENDPOINT, method: "POST", statusCode: 200 },
    );
  }

  // 9. Park Guard cancel + clear pg_identifier (best-effort; mirrors admin
  //    route). Gated on OUR successful persist so we never desync PG ahead of our
  //    own row, nor act on a row a new owner now holds. The clear is also pinned.
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
            `self-cancel: pg_identifier not cleared for ${reservationNumber}: ${pgClearError.message}`,
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

  // 10. Cancellation email (best-effort — a send failure never fails the cancel).
  //     The refund figure is the TOTAL returned on the PI (prior refund + this
  //     call), so an already-refunded replay still shows the real amount.
  const totalRefundedCents =
    priorRefundedCents +
    (refundIssuedThisCall && teardown.kind === "refund" ? teardown.refundCents : 0);
  const refundDollars = wasRefunded ? totalRefundedCents / 100 : 0;
  const pgWholesaleDollars = pgWholesaleCents / 100; // hoisted; 0 when no PG / no charge
  const pgPremiumDollars = booking.protection_plan
    ? parseFloat(String(booking.protection_plan_price ?? "0")) || 0
    : 0;
  const protectionPlanRefundDollars =
    wasRefunded && booking.protection_plan
      ? Math.max(0, pgPremiumDollars - pgWholesaleDollars)
      : 0;
  // Invariant (mirrors the admin route): the protection refund can't exceed the
  // total refund — if it does, the withholding math is inconsistent. The email
  // template clamps this render-side and can't alert, so surface it here where
  // Sentry is available, rather than let a broken breakdown ship silently.
  if (wasRefunded && protectionPlanRefundDollars > refundDollars) {
    captureAPIError(
      new Error(
        `self-cancel: protection refund $${protectionPlanRefundDollars} exceeds total refund $${refundDollars} ` +
          `(premium=${pgPremiumDollars}, withheld=${pgWholesaleDollars}) for ${reservationNumber} — withholding math inconsistent`,
      ),
      { endpoint: ENDPOINT, method: "POST", statusCode: 200 },
    );
  }
  const customer = booking.customers;
  // Only email when WE cleanly finalized — a stale-stolen resumer's new owner
  // (or the cron on a failed persist) owns the customer notification instead.
  if (persistedByUs && customer?.email) {
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
        // What the customer got back OF the PG premium (premium minus the $6
        // wholesale withheld) and the $6 retained, so the breakdown reconciles.
        protectionPlanRefund:
          protectionPlanRefundDollars > 0 ? protectionPlanRefundDollars : undefined,
        protectionPlanRetained: pgWholesaleDollars > 0 ? pgWholesaleDollars : undefined,
      });
    } catch (error) {
      captureAPIError(
        error instanceof Error ? error : new Error(String(error)),
        { endpoint: ENDPOINT, method: "POST", statusCode: 200 },
      );
    }
  }

  return {
    status: 200,
    body: {
      status: newStatus,
      refunded: wasRefunded,
      refundAmount: refundDollars,
      message: wasRefunded
        ? "Your reservation was cancelled and your refund is on its way."
        : "Your reservation was cancelled.",
    },
  };
}

/** Release the claim on a pre-money abort; a failure here is logged, not fatal. */
async function safeRelease(reservationNumber: string, ownedAt: string): Promise<void> {
  try {
    await releaseClaim(reservationNumber, ownedAt);
  } catch (error) {
    captureAPIError(
      error instanceof Error ? error : new Error(String(error)),
      { endpoint: ENDPOINT, method: "POST", statusCode: 409 },
    );
  }
}

/**
 * Set a HOLD `cancel_state` PINNED to `ownedAt`, so a request whose claim was
 * stale-stolen can't overwrite the new owner's state. Keeps `cancel_claimed_at`
 * as-is (still ownedAt) so the reconciliation cron finds the row.
 */
async function markCancelState(
  reservationNumber: string,
  ownedAt: string,
  state: "held_reslab_ambiguous" | "reslab_cancelled_refund_pending",
): Promise<void> {
  const admin = await createAdminClient();
  const { error } = await admin
    .from("bookings")
    .update({ cancel_state: state })
    .eq("reslab_reservation_number", reservationNumber)
    .eq("cancel_claimed_at", ownedAt);
  if (error) {
    captureAPIError(
      new Error(
        `self-cancel: failed to mark ${state} for ${reservationNumber}: ${error.message}`,
      ),
      { endpoint: ENDPOINT, method: "POST", statusCode: 500 },
    );
  }
}
