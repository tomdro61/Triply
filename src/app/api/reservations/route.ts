/**
 * POST /api/reservations
 *
 * The browser's entry point into booking fulfilment. All of the logic that used
 * to live here — ResLab, Supabase, Park Guard, emails — now lives in
 * @/lib/booking/create-booking, shared with the /checkout/complete return page
 * and the Stripe webhook so that a booking gets created no matter which of the
 * three survives.
 *
 * This file's only job is mapping the engine's outcome to an HTTP response.
 */

import { NextRequest, NextResponse } from "next/server";
import { reservationSchema } from "@/lib/validation/schemas";
import {
  createBooking,
  PaymentNotConfirmedError,
} from "@/lib/booking/create-booking";
import { capturePaymentError } from "@/lib/sentry";

// ResLab's own call is allowed up to 30s, and Park Guard, Supabase, and two
// emails run after it. The Vercel default (15s on Pro) could kill this
// invocation mid-write, leaving a live ResLab reservation with no booking row —
// an orphan indistinguishable from a timeout. The two other ResLab-touching
// routes already declare 60.
export const maxDuration = 60;

const DEV_SKIP_PAYMENT =
  process.env.NODE_ENV === "development" &&
  process.env.NEXT_PUBLIC_DEV_SKIP_PAYMENT === "true";

export async function POST(request: NextRequest) {
  let stripePaymentIntentId: string | undefined;

  try {
    const body = await request.json();

    const result = reservationSchema.safeParse(body);
    if (!result.success) {
      return NextResponse.json(
        { error: result.error.issues[0].message },
        { status: 400 }
      );
    }

    const payload = result.data;
    stripePaymentIntentId = payload.stripePaymentIntentId;

    if (!DEV_SKIP_PAYMENT && !stripePaymentIntentId) {
      return NextResponse.json(
        { error: "Payment verification required" },
        { status: 400 }
      );
    }

    const outcome = await createBooking({
      source: DEV_SKIP_PAYMENT ? "dev" : "client",
      stripePaymentIntentId: DEV_SKIP_PAYMENT
        ? null
        : stripePaymentIntentId ?? null,
      payload,
    });

    switch (outcome.kind) {
      case "created":
        return NextResponse.json({
          success: true,
          reservation: outcome.reservation,
        });

      case "already_exists":
        // Previously a 409. A replay is not an error — the customer has a
        // reservation and needs to be sent to it, not shown a failure.
        return NextResponse.json({
          success: true,
          reservation: { reservationNumber: outcome.reservationNumber },
        });

      case "in_progress":
      case "deferred":
        // Another path (usually the webhook) is completing this booking, or the
        // payment is still settling. The client sends the customer to
        // /checkout/complete, which polls until the reservation appears.
        return NextResponse.json(
          {
            pending: true,
            message: "We're finalising your booking.",
          },
          { status: 202 }
        );

      case "sold_out":
        return NextResponse.json(
          {
            error:
              "This parking option sold out while you were checking out. You have not been charged.",
          },
          { status: 409 }
        );

      case "suspected_duplicate":
        return NextResponse.json(
          {
            error:
              "It looks like this booking was already submitted. We've cancelled the duplicate payment — check your email for the original confirmation.",
          },
          { status: 409 }
        );

      case "already_refunded":
        return NextResponse.json(
          {
            error:
              "This payment was refunded and can't be used for a booking. Please start a new search.",
          },
          { status: 409 }
        );

      case "needs_reconciliation":
        // Money is held or taken and the booking state is genuinely unknown.
        // Never tell the customer "not charged" here — that's the one claim we
        // cannot make. Ops has a loud Sentry alert with the details.
        return NextResponse.json(
          {
            error:
              "We're confirming your reservation with the parking facility. Our team will email you shortly — please don't rebook.",
            needsSupport: true,
          },
          { status: 502 }
        );

      case "failed":
        return NextResponse.json(
          { error: outcome.userMessage },
          { status: 409 }
        );
    }
  } catch (error) {
    if (error instanceof PaymentNotConfirmedError) {
      capturePaymentError(error, {
        ...(stripePaymentIntentId && { stripePaymentIntentId }),
      });
      return NextResponse.json(
        { error: "Payment has not been completed" },
        { status: 402 }
      );
    }

    const wrapped = error instanceof Error ? error : new Error(String(error));
    capturePaymentError(wrapped, {
      ...(stripePaymentIntentId && { stripePaymentIntentId }),
    });

    return NextResponse.json(
      { error: "Failed to create reservation. Please try again." },
      { status: 500 }
    );
  }
}
