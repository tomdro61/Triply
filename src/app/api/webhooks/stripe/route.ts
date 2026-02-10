import { NextRequest, NextResponse } from "next/server";
import { stripe } from "@/lib/stripe/client";
import { createAdminClient } from "@/lib/supabase/server";
import { capturePaymentError } from "@/lib/sentry";
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
      console.log("Payment succeeded:", paymentIntent.id);

      // Look up booking by stripe_payment_intent_id and confirm status
      const { data: booking } = await supabase
        .from("bookings")
        .select("id, status")
        .eq("stripe_payment_intent_id", paymentIntent.id)
        .single();

      if (booking) {
        if (booking.status !== "confirmed") {
          await supabase
            .from("bookings")
            .update({ status: "confirmed" })
            .eq("id", booking.id);
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

      const { data: booking } = await supabase
        .from("bookings")
        .select("id")
        .eq("stripe_payment_intent_id", paymentIntent.id)
        .single();

      if (booking) {
        await supabase
          .from("bookings")
          .update({ status: "payment_failed" })
          .eq("id", booking.id);
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
        const { data: booking } = await supabase
          .from("bookings")
          .select("id")
          .eq("stripe_payment_intent_id", paymentIntentId)
          .single();

        if (booking) {
          await supabase
            .from("bookings")
            .update({ status: "disputed" })
            .eq("id", booking.id);
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

      console.log("Charge refunded:", charge.id, "for PI:", paymentIntentId);

      if (paymentIntentId) {
        const { data: booking } = await supabase
          .from("bookings")
          .select("id")
          .eq("stripe_payment_intent_id", paymentIntentId)
          .single();

        if (booking) {
          await supabase
            .from("bookings")
            .update({ status: "refunded" })
            .eq("id", booking.id);
        }
      }
      break;
    }

    default:
      console.log("Unhandled event type:", event.type);
  }

  return NextResponse.json({ received: true });
}
