import { NextRequest, NextResponse } from "next/server";
import { stripe } from "@/lib/stripe/client";
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

  switch (event.type) {
    case "payment_intent.succeeded":
      console.log("Payment succeeded:", event.data.object.id);
      break;
    case "payment_intent.payment_failed":
      console.log("Payment failed:", event.data.object.id);
      break;
    default:
      console.log("Unhandled event type:", event.type);
  }

  return NextResponse.json({ received: true });
}
