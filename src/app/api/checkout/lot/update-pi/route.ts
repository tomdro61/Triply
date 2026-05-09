import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import Stripe from "stripe";
import { stripe } from "@/lib/stripe/client";
import { capturePaymentError } from "@/lib/sentry";
import { PROTECTION_PLAN } from "@/lib/parkguard/client";

// Updates an existing PaymentIntent's amount when the customer toggles the
// Parking Protection Yes/No on the payment step. Reads the parking-only
// baseline (in cents) from PI metadata (stamped at creation by
// /api/checkout/lot POST), recomputes the charge, and calls
// stripe.paymentIntents.update.
//
// Refuses to update if the PI is no longer in `requires_payment_method` or
// `requires_confirmation` status — toggling at that point is a stale UI.

const updatePiSchema = z.object({
  paymentIntentId: z.string().startsWith("pi_"),
  hasProtectionPlan: z.boolean(),
});

export async function POST(request: NextRequest) {
  // Hoist outside the try so the catch-all has the ID to attach to Sentry.
  let paymentIntentId: string | undefined;
  let hasProtectionPlan: boolean | undefined;

  try {
    const body = await request.json();
    const result = updatePiSchema.safeParse(body);
    if (!result.success) {
      return NextResponse.json(
        { error: result.error.issues[0].message },
        { status: 400 }
      );
    }

    paymentIntentId = result.data.paymentIntentId;
    hasProtectionPlan = result.data.hasProtectionPlan;

    const pi = await stripe.paymentIntents.retrieve(paymentIntentId);

    if (pi.status !== "requires_payment_method" && pi.status !== "requires_confirmation") {
      // Already paid, processing, or canceled — toggling at this point is a
      // user error or stale UI. Return 409 so the client can surface a
      // distinct "refresh and try again" message.
      return NextResponse.json(
        { error: `PaymentIntent is in status '${pi.status}' and cannot be updated` },
        { status: 409 }
      );
    }

    // parkingOnlyChargeAmount is stored as a string of CENTS (integer-safe).
    // Falling back to dollars-as-string for legacy PIs created before the
    // cents-storage rollout — those callers should restart checkout.
    const parkingOnlyCentsStr = pi.metadata?.parkingOnlyChargeAmountCents;
    const parkingOnlyDollarsStr = pi.metadata?.parkingOnlyChargeAmount;
    if (!parkingOnlyCentsStr && !parkingOnlyDollarsStr) {
      capturePaymentError(
        new Error(`update-pi: parkingOnlyChargeAmount{,Cents} missing from PI metadata`),
        { stripePaymentIntentId: paymentIntentId, amount: pi.amount / 100 }
      );
      return NextResponse.json(
        { error: "Cannot update this payment — baseline amount unavailable. Please restart checkout." },
        { status: 422 }
      );
    }
    const parkingOnlyCents = parkingOnlyCentsStr
      ? parseInt(parkingOnlyCentsStr, 10)
      : Math.round(parseFloat(parkingOnlyDollarsStr || "0") * 100);

    if (!Number.isFinite(parkingOnlyCents) || parkingOnlyCents <= 0) {
      capturePaymentError(
        new Error(`update-pi: parkingOnlyChargeAmount '${parkingOnlyCentsStr || parkingOnlyDollarsStr}' is not a positive number`),
        { stripePaymentIntentId: paymentIntentId, amount: pi.amount / 100 }
      );
      return NextResponse.json(
        { error: "Cannot update this payment — baseline amount invalid. Please restart checkout." },
        { status: 422 }
      );
    }

    const protectionPremiumCents = hasProtectionPlan
      ? Math.round(PROTECTION_PLAN.price * 100)
      : 0;
    const newAmountCents = parkingOnlyCents + protectionPremiumCents;

    // Replace metadata explicitly. Setting protectionPlanPrice to null tells
    // Stripe to delete the key — cleaner than the empty-string sentinel
    // convention which makes downstream "key present" checks ambiguous.
    const updatedMetadata: Stripe.MetadataParam = {
      ...(pi.metadata || {}),
      protectionPlanPrice: protectionPremiumCents > 0
        ? (protectionPremiumCents / 100).toFixed(2)
        : null,
    };

    // No idempotency key here. Naively keying on `yes`/`no` collapses
    // the third call in a Yes→No→Yes sequence (same key as first Yes),
    // returning the cached response without re-applying the amount —
    // PI ends up at the No amount while the client thinks Yes succeeded.
    // Stripe's own update is naturally idempotent for final state: the
    // last call wins, same-amount duplicates are no-ops, and the client
    // sequence-ID guard discards stale responses.
    const updated = await stripe.paymentIntents.update(
      paymentIntentId,
      { amount: newAmountCents, metadata: updatedMetadata }
    );

    return NextResponse.json({
      paymentIntentId: updated.id,
      amount: updated.amount / 100,
      hasProtectionPlan,
    });
  } catch (error) {
    console.error("update-pi error:", error);

    // Stripe 404 (invalid PI ID) is a client error, not a server fault.
    if (
      error instanceof Stripe.errors.StripeInvalidRequestError &&
      error.statusCode === 404
    ) {
      return NextResponse.json(
        { error: "Payment session not found — please refresh and try again" },
        { status: 404 }
      );
    }

    capturePaymentError(
      error instanceof Error ? error : new Error(String(error)),
      { stripePaymentIntentId: paymentIntentId, amount: PROTECTION_PLAN.price }
    );
    return NextResponse.json(
      { error: "Failed to update payment amount" },
      { status: 500 }
    );
  }
}
