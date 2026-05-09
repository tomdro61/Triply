import { NextRequest, NextResponse } from "next/server";
import { stripe } from "@/lib/stripe/client";
import { createAdminClient } from "@/lib/supabase/server";
import { capturePaymentError, captureParkGuardError } from "@/lib/sentry";
import { parkGuard, ParkGuardError } from "@/lib/parkguard/client";
import Stripe from "stripe";

export async function POST(request: NextRequest) {
  const body = await request.text();
  const sig = request.headers.get("stripe-signature");

  if (!sig || !process.env.STRIPE_WEBHOOK_SECRET) {
    return NextResponse.json(
      { error: "Missing signature or webhook secret" },
      { status: 400 }
    );
  }

  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(
      body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("Webhook signature verification failed:", err);
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  const supabase = await createAdminClient();

  switch (event.type) {
    case "payment_intent.succeeded": {
      const paymentIntent = event.data.object as Stripe.PaymentIntent;

      // Look up booking by stripe_payment_intent_id and confirm status
      const { data: booking, error: lookupErr } = await supabase
        .from("bookings")
        .select("id, status")
        .eq("stripe_payment_intent_id", paymentIntent.id)
        .single();

      if (lookupErr && lookupErr.code !== "PGRST116") {
        // PGRST116 = no rows found; that's the race-condition path handled
        // below. Anything else is a real Supabase error worth Sentry-ing.
        capturePaymentError(
          new Error(`Webhook payment_intent.succeeded: lookup failed: ${lookupErr.message}`),
          { stripePaymentIntentId: paymentIntent.id, amount: paymentIntent.amount / 100 }
        );
      }

      if (booking) {
        if (booking.status !== "confirmed") {
          const { error: updateErr } = await supabase
            .from("bookings")
            .update({ status: "confirmed" })
            .eq("id", booking.id);
          if (updateErr) {
            capturePaymentError(
              new Error(`Webhook payment_intent.succeeded: status update failed: ${updateErr.message}`),
              { stripePaymentIntentId: paymentIntent.id, amount: paymentIntent.amount / 100 }
            );
          }
        }
      } else {
        // Race condition: webhook arrived before reservation was created
        // Wait and retry once
        await new Promise((resolve) => setTimeout(resolve, 10000));
        const { data: retryBooking } = await supabase
          .from("bookings")
          .select("id, status")
          .eq("stripe_payment_intent_id", paymentIntent.id)
          .single();

        if (!retryBooking) {
          capturePaymentError(
            new Error("Webhook: payment_intent.succeeded but no booking found after retry"),
            { stripePaymentIntentId: paymentIntent.id, amount: paymentIntent.amount / 100 }
          );
        }
      }
      break;
    }

    case "payment_intent.payment_failed": {
      const paymentIntent = event.data.object as Stripe.PaymentIntent;
      console.error("Payment failed:", paymentIntent.id);

      const { data: booking, error: lookupErr } = await supabase
        .from("bookings")
        .select("id")
        .eq("stripe_payment_intent_id", paymentIntent.id)
        .single();

      if (lookupErr && lookupErr.code !== "PGRST116") {
        capturePaymentError(
          new Error(`Webhook payment_intent.payment_failed: lookup failed: ${lookupErr.message}`),
          { stripePaymentIntentId: paymentIntent.id, amount: paymentIntent.amount / 100 }
        );
      }

      if (booking) {
        const { error: updateErr } = await supabase
          .from("bookings")
          .update({ status: "payment_failed" })
          .eq("id", booking.id);
        if (updateErr) {
          capturePaymentError(
            new Error(`Webhook payment_intent.payment_failed: status update failed: ${updateErr.message}`),
            { stripePaymentIntentId: paymentIntent.id, amount: paymentIntent.amount / 100 }
          );
        }
      }

      capturePaymentError(
        new Error(`Payment failed: ${paymentIntent.last_payment_error?.message || "unknown error"}`),
        { stripePaymentIntentId: paymentIntent.id, amount: paymentIntent.amount / 100 }
      );
      break;
    }

    case "charge.dispute.created": {
      const dispute = event.data.object as Stripe.Dispute;
      const paymentIntentId = typeof dispute.payment_intent === "string"
        ? dispute.payment_intent
        : dispute.payment_intent?.id;

      console.error("Dispute created:", dispute.id, "for PI:", paymentIntentId);

      if (paymentIntentId) {
        const { data: booking, error: lookupErr } = await supabase
          .from("bookings")
          .select("id")
          .eq("stripe_payment_intent_id", paymentIntentId)
          .single();

        if (lookupErr && lookupErr.code !== "PGRST116") {
          capturePaymentError(
            new Error(`Webhook charge.dispute.created: lookup failed: ${lookupErr.message}`),
            { stripePaymentIntentId: paymentIntentId, amount: dispute.amount / 100 }
          );
        }

        if (booking) {
          const { error: updateErr } = await supabase
            .from("bookings")
            .update({ status: "disputed" })
            .eq("id", booking.id);
          if (updateErr) {
            capturePaymentError(
              new Error(`Webhook charge.dispute.created: status update failed: ${updateErr.message}`),
              { stripePaymentIntentId: paymentIntentId, amount: dispute.amount / 100 }
            );
          }
        }
      }

      capturePaymentError(
        new Error(`Dispute created: ${dispute.reason || "unknown"} - amount: ${dispute.amount / 100}`),
        { stripePaymentIntentId: paymentIntentId || "unknown", amount: dispute.amount / 100 }
      );
      break;
    }

    case "charge.refunded": {
      const charge = event.data.object as Stripe.Charge;
      const paymentIntentId = typeof charge.payment_intent === "string"
        ? charge.payment_intent
        : charge.payment_intent?.id;

      // Partial refunds (dispute partial concessions, customer-service goodwill)
      // fire the same charge.refunded event. Don't flip the booking to fully
      // refunded or cancel Park Guard coverage in that case — surface to Sentry
      // for ops to review.
      const isFullRefund = charge.amount_refunded === charge.amount;

      if (paymentIntentId) {
        const { data: booking, error: lookupErr } = await supabase
          .from("bookings")
          .select("id, protection_plan, pg_identifier")
          .eq("stripe_payment_intent_id", paymentIntentId)
          .single();

        if (lookupErr) {
          capturePaymentError(
            new Error(`Webhook charge.refunded: bookings lookup failed: ${lookupErr.message}`),
            { stripePaymentIntentId: paymentIntentId, amount: charge.amount_refunded / 100 }
          );
        }

        if (booking) {
          if (!isFullRefund) {
            // Partial refund — leave booking status alone, don't touch PG.
            capturePaymentError(
              new Error(
                `Partial refund on booking ${booking.id}: $${(charge.amount_refunded / 100).toFixed(2)} of $${(charge.amount / 100).toFixed(2)}`
              ),
              { stripePaymentIntentId: paymentIntentId, amount: charge.amount_refunded / 100 }
            );
            break;
          }

          const { error: updateErr } = await supabase
            .from("bookings")
            .update({ status: "refunded" })
            .eq("id", booking.id);

          if (updateErr) {
            capturePaymentError(
              new Error(`Webhook charge.refunded: status update failed: ${updateErr.message}`),
              { stripePaymentIntentId: paymentIntentId, amount: charge.amount_refunded / 100 }
            );
          }

          // Stripe-side refunds (dashboard, dispute resolution, partner refunds)
          // bypass the admin cancel route. Notify Park Guard so they don't
          // continue billing Triply for coverage on a refunded booking.
          if (booking.protection_plan && !updateErr) {
            try {
              await parkGuard.updateReservation(booking.id, { status: "cancelled" });
            } catch (pgError) {
              captureParkGuardError(
                pgError instanceof Error ? pgError : new Error(String(pgError)),
                {
                  bookingId: booking.id,
                  operation: "update",
                  ...(pgError instanceof ParkGuardError && { statusCode: pgError.statusCode }),
                }
              );
            }
          }
        }
      }
      break;
    }

    default:
      break;
  }

  return NextResponse.json({ received: true });
}
