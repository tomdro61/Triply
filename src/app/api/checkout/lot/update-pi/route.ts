import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import Stripe from "stripe";
import { stripe } from "@/lib/stripe/client";
import { capturePaymentError } from "@/lib/sentry";
import {
  getProtectionPlan,
  protectionMetadataPatch,
  protectionPremiumCents,
  STALE_CHECKOUT_MESSAGE,
} from "@/lib/parkguard/client";
import { protectionPlanCodeSchema } from "@/lib/validation/schemas";

// Updates an existing PaymentIntent's amount when the customer picks a Parking
// Protection tier (Plan A / B / C) or "no protection" on the payment step.
// Reads the parking-only baseline (in cents) from PI metadata (stamped at
// creation by /api/checkout/lot POST), recomputes the charge, and calls
// stripe.paymentIntents.update.
//
// Refuses to update if the PI is no longer in `requires_payment_method` or
// `requires_confirmation` status — toggling at that point is a stale UI.

const updatePiSchema = z.object({
  paymentIntentId: z.string().startsWith("pi_"),
  // "A" | "B" | "C" = tier, null = no protection. Required key (see
  // validation/schemas.ts) — an omitted key is a client bug, not a decline.
  protectionPlanCode: protectionPlanCodeSchema,
});

export async function POST(request: NextRequest) {
  // Hoisted outside the try so the catch-all has them to attach to Sentry.
  let paymentIntentId: string | undefined;
  let premiumForSentry = 0;

  try {
    const body = await request.json();
    // A checkout page loaded before the plan-tier deploy still posts the old
    // boolean. Refuse with an actionable message instead of a Zod issue the
    // customer can't act on (the selector would otherwise stay locked).
    if (body && typeof body === "object" && "hasProtectionPlan" in body) {
      return NextResponse.json({ error: STALE_CHECKOUT_MESSAGE }, { status: 400 });
    }
    const result = updatePiSchema.safeParse(body);
    if (!result.success) {
      return NextResponse.json(
        { error: result.error.issues[0].message },
        { status: 400 }
      );
    }

    paymentIntentId = result.data.paymentIntentId;
    const protectionPlan = getProtectionPlan(result.data.protectionPlanCode);
    premiumForSentry = protectionPlan?.price ?? 0;

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

    const newAmountCents = parkingOnlyCents + protectionPremiumCents(protectionPlan);

    // Replace metadata explicitly. The tier code and its price are written as
    // a PAIR and deleted as a pair — a null value tells Stripe to drop the key
    // (cleaner than an empty-string sentinel, which makes downstream "key
    // present" checks ambiguous). /api/reservations/pending stages the tier
    // from this pair and fulfilment books exactly what it says; both treat a
    // half-present pair as an integrity error, never as "no protection".
    const updatedMetadata: Stripe.MetadataParam = {
      ...(pi.metadata || {}),
      ...protectionMetadataPatch(protectionPlan),
    };

    // No idempotency key here. Naively keying on the tier collapses the third
    // call in an A→none→A sequence (same key as the first A), returning the
    // cached response without re-applying the amount — the PI ends up at the
    // "none" amount while the client thinks A succeeded. Stripe's own update is
    // naturally idempotent for final state: the last call wins, same-amount
    // duplicates are no-ops, and the client's sequence-ID guard discards stale
    // responses (the selector is also disabled while a request is in flight).
    const updated = await stripe.paymentIntents.update(
      paymentIntentId,
      { amount: newAmountCents, metadata: updatedMetadata }
    );

    return NextResponse.json({
      paymentIntentId: updated.id,
      amount: updated.amount / 100,
      protectionPlanCode: protectionPlan?.code ?? null,
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
      { stripePaymentIntentId: paymentIntentId, amount: premiumForSentry }
    );
    return NextResponse.json(
      { error: "Failed to update payment amount" },
      { status: 500 }
    );
  }
}
