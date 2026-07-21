/**
 * POST /api/reservations/complete
 *
 * Drives fulfilment for a customer returning from an off-site authentication
 * redirect — 3-D Secure card verification, or a BNPL provider. Stripe sends them
 * to `return_url` with `payment_intent` and `payment_intent_client_secret`
 * appended; until this release that URL was a 404, so the booking code never ran
 * and the customer was charged for nothing. This is that fix.
 *
 * AUTH: the customer is a guest and has no session. The `client_secret` Stripe
 * appends to the return URL is the credential — it is unguessable, scoped to
 * exactly one PaymentIntent, and only the paying customer's browser receives it.
 * Compared in constant time against the value Stripe holds.
 */

import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { stripe } from "@/lib/stripe/client";
import { createAdminClient } from "@/lib/supabase/server";
import {
  createBooking,
  PaymentNotConfirmedError,
} from "@/lib/booking/create-booking";
import { capturePaymentError } from "@/lib/sentry";

export const maxDuration = 60;

function secretsMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // timingSafeEqual throws on length mismatch, which would itself leak length.
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Rebuild the customer's confirmation URL. The `email` param is REQUIRED —
 *  /confirmation's guest branch 403s without it — and is derived server-side
 *  from the PaymentIntent, never taken from the request. */
async function buildConfirmationUrl(
  reservationNumber: string,
  piId: string,
  derivedEmail: string
): Promise<string> {
  const supabase = await createAdminClient();
  const { data } = await supabase
    .from("pending_bookings")
    .select("confirmation_params")
    .eq("stripe_payment_intent_id", piId)
    .maybeSingle();

  const params = new URLSearchParams();
  const stored = (data?.confirmation_params ?? null) as Record<
    string,
    string
  > | null;
  if (stored) {
    for (const [k, v] of Object.entries(stored)) {
      if (k !== "email" && typeof v === "string") params.set(k, v);
    }
  }
  params.set("email", derivedEmail);

  return `/confirmation/${encodeURIComponent(
    reservationNumber
  )}?${params.toString()}`;
}

export async function POST(request: NextRequest) {
  let piId: string | undefined;

  try {
    const body = await request.json();
    piId = typeof body.paymentIntentId === "string" ? body.paymentIntentId : undefined;
    const clientSecret =
      typeof body.clientSecret === "string" ? body.clientSecret : undefined;

    if (!piId || !clientSecret) {
      return NextResponse.json(
        { error: "Missing payment reference" },
        { status: 400 }
      );
    }

    const pi = await stripe.paymentIntents.retrieve(piId);

    if (!pi.client_secret || !secretsMatch(clientSecret, pi.client_secret)) {
      // Not the paying customer. Do not disclose whether the PI exists.
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    // Branch on the status Stripe reports, NEVER on the `redirect_status` query
    // param — that one is attacker-controlled and would let a declined payment
    // render as a success.
    if (
      pi.status === "requires_payment_method" ||
      pi.status === "canceled"
    ) {
      return NextResponse.json({
        state: "payment_failed",
        message:
          "Your payment wasn't completed, so we haven't booked anything and you haven't been charged. You can try again with a different payment method.",
      });
    }

    if (pi.status === "requires_action") {
      return NextResponse.json({
        state: "payment_incomplete",
        message:
          "Your payment still needs to be confirmed with your bank. You have not been charged.",
      });
    }

    const outcome = await createBooking({
      source: "complete",
      stripePaymentIntentId: piId,
    });

    const derivedEmail = (pi.metadata?.customerEmail ?? "").trim();

    switch (outcome.kind) {
      case "created":
      case "already_exists": {
        const reservationNumber =
          outcome.kind === "created"
            ? outcome.reservationNumber
            : outcome.reservationNumber;
        return NextResponse.json({
          state: "booked",
          reservationNumber,
          confirmationUrl: await buildConfirmationUrl(
            reservationNumber,
            piId,
            derivedEmail
          ),
        });
      }

      case "in_progress":
      case "deferred":
        // Still working. The page keeps polling.
        return NextResponse.json({ state: "pending" });

      case "sold_out":
        return NextResponse.json({
          state: "failed",
          message:
            "This parking option sold out while you were confirming payment. You have not been charged.",
        });

      case "suspected_duplicate":
        return NextResponse.json({
          state: "failed",
          message:
            "This booking was already submitted. We've cancelled the duplicate payment — check your email for the original confirmation.",
        });

      case "already_refunded":
        return NextResponse.json({
          state: "failed",
          message:
            "This payment was refunded and can't be used for a booking. Please start a new search.",
        });

      case "needs_reconciliation":
        return NextResponse.json({
          state: "needs_support",
          message:
            "We're confirming your reservation with the parking facility. Our team will email you shortly — please don't rebook.",
        });

      case "failed":
        return NextResponse.json({
          state: "failed",
          message: outcome.userMessage,
        });
    }
  } catch (error) {
    if (error instanceof PaymentNotConfirmedError) {
      return NextResponse.json({
        state: "payment_failed",
        message:
          "Your payment wasn't completed, so we haven't booked anything and you haven't been charged.",
      });
    }

    const wrapped = error instanceof Error ? error : new Error(String(error));
    capturePaymentError(wrapped, { ...(piId && { stripePaymentIntentId: piId }) });

    // Transient — tell the page to keep polling rather than showing a hard
    // failure for what may be a momentary blip on a customer who HAS paid.
    return NextResponse.json({ state: "pending" }, { status: 200 });
  }
}
