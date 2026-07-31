import type Stripe from "stripe";
import { stripe } from "@/lib/stripe/client";
import { captureAPIError, capturePaymentError } from "@/lib/sentry";
import { reslab } from "@/lib/reslab/client";
import { isCancellable } from "./eligibility";
import { claimForCancel, releaseClaim, markCancelState } from "./claim";
import { classifyCancelOutcome } from "./reslab-cancel";
import {
  planTeardown,
  finalizeCancelledReservation,
  type CancelBookingRow,
} from "./finalize";

// Re-exported so the route (and tests) can keep importing it from here.
export type { CancelBookingRow } from "./finalize";

/**
 * The customer-facing self-service cancellation orchestration. Kept OUT of the
 * route handler so it is unit-testable end-to-end (FakeSupabase + mocked
 * Stripe/ResLab) without Next request plumbing. The route does auth + the
 * RLS-scoped ownership read, then hands the owned booking row here.
 *
 * Order (v3.1 §5): status pre-check → 24h gate → PRE-CLAIM live-PI guard + refund
 * plan → atomic claim → ResLab cancel + classify → shared finalize (refund →
 * persist → Park Guard → email). Everything that computes the refund runs BEFORE
 * the claim, so a dirty-data throw can never leave a claim/HOLD; the claim is the
 * last thing before the first side effect (the ResLab cancel). The money-movement
 * core (`planTeardown` + `finalizeCancelledReservation`) is SHARED with the
 * reconciliation cron via ./finalize so the two paths can't drift.
 */

const ENDPOINT = "/api/user/bookings/[reservationNumber]/cancel";

export interface CancelResult {
  status: number;
  body: Record<string, unknown>;
}

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
  //    atomicity model this shouldn't happen — refuse + alert rather than
  //    cancel-without-refund (spec §5.6). Narrows `piId` to a non-null string.
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

  // 4. PRE-CLAIM live-PI guard + refund plan. NO side effects — retrieve the PI
  //    (latest_charge expanded) and decide the teardown; a still-settling /
  //    unreadable / dirty PI aborts BEFORE we claim or touch ResLab.
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

  const plan = planTeardown(pi, booking);
  if (!plan.ok) {
    if (plan.reason === "processing") {
      return {
        status: 409,
        body: {
          error: "payment_settling",
          message:
            "Your payment is still processing. Please try again in a few minutes.",
        },
      };
    }
    if (plan.reason === "unknown") {
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
    // dirty_refund_math — non-finite refund; MUST NOT surface as a bare 500.
    captureAPIError(
      new Error(
        `self-cancel: refund math non-finite for ${reservationNumber} (pi ${piId})`,
      ),
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

  // 5. Atomic claim. From here we hold it: every pre-money abort releases it.
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

  // 6. ResLab cancel + classify (the first side effect).
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
    await markCancelState(reservationNumber, ownedAt, "held_reslab_ambiguous", ENDPOINT);
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

  // outcome === "proceed": the ResLab spot IS released. Hand off to the shared
  // money-movement core (identical to the cron's recovery path).
  // 7. Finalize (refund → persist → Park Guard → email).
  const result = await finalizeCancelledReservation({
    booking,
    piId,
    teardown: plan.teardown,
    priorRefundedCents: plan.priorRefundedCents,
    pgWholesaleCents: plan.pgWholesaleCents,
    ownedAt,
    endpoint: ENDPOINT,
  });
  if (result.kind === "refund_pending") {
    return {
      status: 202,
      body: {
        status: "processing",
        message:
          "Your reservation was cancelled. Your refund is processing and will appear shortly.",
      },
    };
  }
  return {
    status: 200,
    body: {
      status: result.status,
      refunded: result.wasRefunded,
      refundAmount: result.refundDollars,
      message: result.wasRefunded
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
