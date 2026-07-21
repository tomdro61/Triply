import { NextRequest, NextResponse } from "next/server";
import { stripe } from "@/lib/stripe/client";
import { createAdminClient } from "@/lib/supabase/server";
import { capturePaymentError, captureParkGuardError } from "@/lib/sentry";
import { parkGuard, ParkGuardError } from "@/lib/parkguard/client";
import { createBooking } from "@/lib/booking/create-booking";
import Stripe from "stripe";

// This handler now CREATES bookings, so it inherits the full fulfilment budget:
// ResLab, capture, Supabase, Park Guard, and two emails.
export const maxDuration = 60;

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

  // Stripe redelivers on any non-2xx. That retry IS the recovery mechanism for a
  // booking whose first fulfilment attempt died mid-flight, so a transient
  // outcome MUST NOT return 2xx. Terminal outcomes must, or Stripe redelivers a
  // settled event for days.
  let retryable = false;

  switch (event.type) {
    // `amount_capturable_updated` fires when a manual-capture PaymentIntent is
    // authorized — BEFORE any money moves. It is the primary trigger under the
    // new capture model. `succeeded` still fires for wallet methods that
    // auto-capture and for any PaymentIntent created before the cutover, so both
    // drive the same idempotent engine.
    case "payment_intent.succeeded":
    case "payment_intent.amount_capturable_updated": {
      const paymentIntent = event.data.object as Stripe.PaymentIntent;

      const { data: booking, error: lookupErr } = await supabase
        .from("bookings")
        .select("id, status")
        .eq("stripe_payment_intent_id", paymentIntent.id)
        .maybeSingle();

      if (lookupErr) {
        capturePaymentError(
          new Error(`Webhook ${event.type}: lookup failed: ${lookupErr.message}`),
          { stripePaymentIntentId: paymentIntent.id, amount: paymentIntent.amount / 100 }
        );
        // Can't tell whether a booking exists. Retry rather than risk creating
        // a second one.
        retryable = true;
        break;
      }

      if (booking) {
        // Bookings are CREATED with status "confirmed", so an EXISTING booking
        // that is NOT confirmed here was deliberately moved afterward to
        // cancelled / refunded / disputed / completed / payment_failed. A late
        // succeeded event must NOT revert that — the old blind
        // `!== confirmed → confirmed` would silently un-cancel a released,
        // possibly-refunded booking. Alerted for manual review, never overwritten.
        if (booking.status !== "confirmed") {
          capturePaymentError(
            new Error(
              `Webhook ${event.type} fired for booking already in status '${booking.status}' — NOT overwriting to confirmed. If cancelled/refunded, verify the customer's refund.`
            ),
            { stripePaymentIntentId: paymentIntent.id, amount: paymentIntent.amount / 100 }
          );
        }
        break;
      }

      // No booking exists. THIS is the guarantee: create it server-side, from
      // the durable pending row, regardless of what happened to the customer's
      // browser. Replaces the old setTimeout(10s)-then-alert stub, which only
      // ever produced a Sentry event while the customer kept their money gone
      // and their booking non-existent.
      const outcome = await createBooking({
        source: "webhook",
        stripePaymentIntentId: paymentIntent.id,
      });

      // A needs_reconciliation caused by a DATABASE fault is retryable — we
      // couldn't read our own state, which says nothing about the booking. The
      // genuinely terminal ambiguities (ResLab may-or-may-not-have-created, an
      // unknown capture result) set retryable=false and must NOT be redelivered,
      // because retrying those double-books.
      if (
        outcome.kind === "in_progress" ||
        outcome.kind === "deferred" ||
        (outcome.kind === "needs_reconciliation" && outcome.retryable)
      ) {
        // Another caller holds a fresh claim, or the payment is still settling.
        // Returning non-2xx makes Stripe redeliver — and by then the claim will
        // have gone stale and this handler can steal it. That redelivery is what
        // finishes a booking whose browser died holding the mutex.
        retryable = true;
      }
      break;
    }

    // A manual-capture authorization that was cancelled — by us on a teardown
    // path, by Stripe when the hold expired, or from the dashboard. Make sure
    // the pending row doesn't sit in a non-terminal state forever.
    case "payment_intent.canceled": {
      const paymentIntent = event.data.object as Stripe.PaymentIntent;

      const { data: pending } = await supabase
        .from("pending_bookings")
        .select("status, reslab_reservation_number")
        .eq("stripe_payment_intent_id", paymentIntent.id)
        .maybeSingle();

      if (pending && (pending.status === "pending" || pending.status === "processing")) {
        await supabase
          .from("pending_bookings")
          .update({
            status: "failed",
            last_error: "PaymentIntent canceled before fulfilment completed",
          })
          .eq("stripe_payment_intent_id", paymentIntent.id)
          .in("status", ["pending", "processing"]);

        // A cancelled authorization with a live ResLab reservation means we hold
        // inventory we can never charge for. Ops must release it.
        if (pending.reslab_reservation_number) {
          capturePaymentError(
            new Error(
              `PaymentIntent ${paymentIntent.id} was canceled but ResLab reservation ${pending.reslab_reservation_number} exists — release the spot manually.`
            ),
            { stripePaymentIntentId: paymentIntent.id, amount: paymentIntent.amount / 100 }
          );
        }
      }

      await supabase
        .from("cart_claims")
        .update({ released_at: new Date().toISOString() })
        .eq("stripe_payment_intent_id", paymentIntent.id)
        .is("released_at", null);
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
        // TODO: a booking can exist here if capture failed AFTER the reservation
        // was created (see the capture_ambiguous status). This only flips status
        // + alerts — it does NOT release the held ResLab spot or cancel Park
        // Guard, so ops must clean up manually. Mirror the charge.refunded branch
        // (reslab.cancelReservation + parkGuard.updateReservation) to automate it.
      }

      // An async payment that failed while deferred has NO booking row — the
      // engine returns `deferred` before creating anything. What it does leave is
      // a pending row and a cart claim, and the claim would otherwise block this
      // customer from re-booking the same lot and dates for 30 minutes right after
      // their payment failed. Release both.
      const { data: failedPending } = await supabase
        .from("pending_bookings")
        .select("status, reslab_reservation_number")
        .eq("stripe_payment_intent_id", paymentIntent.id)
        .maybeSingle();

      if (
        failedPending &&
        (failedPending.status === "pending" || failedPending.status === "processing")
      ) {
        await supabase
          .from("pending_bookings")
          .update({
            status: "failed",
            last_error: `PaymentIntent failed: ${
              paymentIntent.last_payment_error?.message || "unknown error"
            }`,
          })
          .eq("stripe_payment_intent_id", paymentIntent.id)
          .in("status", ["pending", "processing"]);

        // A reservation with a failed payment is inventory we hold and can never
        // bill for. Should be rare — the deferral runs before ResLab — but if it
        // happens, ops must release the spot.
        if (failedPending.reslab_reservation_number) {
          capturePaymentError(
            new Error(
              `PaymentIntent ${paymentIntent.id} failed but ResLab reservation ${failedPending.reslab_reservation_number} exists — release the spot manually.`
            ),
            { stripePaymentIntentId: paymentIntent.id, amount: paymentIntent.amount / 100 }
          );
        }
      }

      await supabase
        .from("cart_claims")
        .update({ released_at: new Date().toISOString() })
        .eq("stripe_payment_intent_id", paymentIntent.id)
        .is("released_at", null);

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

      const isFullRefund = charge.amount_refunded === charge.amount;

      if (paymentIntentId) {
        const { data: booking, error: lookupErr } = await supabase
          .from("bookings")
          .select("id, protection_plan, protection_plan_price, pg_identifier, pg_sync_status")
          .eq("stripe_payment_intent_id", paymentIntentId)
          .single();

        if (lookupErr && lookupErr.code !== "PGRST116") {
          // PGRST116 = no rows found. Legitimate when a refund fires for a
          // pre-Triply charge or a test-mode payment that never produced a
          // booking row; suppressing keeps the Sentry signal actionable.
          capturePaymentError(
            new Error(`Webhook charge.refunded: bookings lookup failed: ${lookupErr.message}`),
            { stripePaymentIntentId: paymentIntentId, amount: charge.amount_refunded / 100 }
          );
        }

        if (booking) {
          // Did the refunded amount cover the Park Guard premium? If so we
          // must notify PG — they don't observe Stripe refunds and would
          // keep billing Triply for coverage on a refunded premium.
          //
          // Threshold = the price THIS booking was charged
          // (booking.protection_plan_price), never the live constant. If
          // retail has shifted since charge, the live constant would
          // mis-classify partial refunds inside the price-change window
          // (e.g., a $12.99 booking partially refunded $11.50 after a drop
          // to $10.99 would be auto-PG-canceled when it shouldn't be). For
          // legacy dirty rows missing the stored price (migration 011's
          // CHECK blocks new inserts; pre-CHECK rows may still exist), we
          // can't compute the threshold safely — alert ops and skip the
          // auto-cancel branch. PG cancellation, if warranted, gets handled
          // manually.
          const rowPriceCents = booking.protection_plan_price
            ? Math.round(parseFloat(booking.protection_plan_price) * 100)
            : 0;
          const dirtyRow = !!booking.protection_plan && rowPriceCents <= 0;
          if (dirtyRow) {
            captureParkGuardError(
              new Error(
                "Webhook charge.refunded: booking has protection_plan set but no protection_plan_price; skipping auto-cancel (cannot compute refund threshold safely)."
              ),
              { bookingId: booking.id, operation: "update" }
            );
          }
          const refundCoversProtection =
            !!booking.protection_plan &&
            !dirtyRow &&
            charge.amount_refunded >= rowPriceCents;

          if (!isFullRefund) {
            // Partial refund (dispute concession, customer-service goodwill,
            // PG-premium-only refund). Don't flip booking status — parking
            // spot still booked.
            if (refundCoversProtection && booking.pg_identifier) {
              try {
                await parkGuard.updateReservation(booking.id, { status: "cancelled" });
                // Clear pg_identifier so Stripe's at-least-once retry of this
                // event, or further partial refunds, can't re-fire PG cancel.
                // The identifier is preserved in PG's portal and in Sentry
                // from the original capture; clearing it locally is purely
                // for idempotency on subsequent webhook deliveries.
                const { error: clearErr } = await supabase
                  .from("bookings")
                  .update({ pg_identifier: null })
                  .eq("id", booking.id);
                if (clearErr) {
                  captureParkGuardError(
                    new Error(
                      `Webhook partial refund: PG cancelled but pg_identifier clear failed: ${clearErr.message}`
                    ),
                    { bookingId: booking.id, operation: "update" }
                  );
                }
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

            capturePaymentError(
              new Error(
                `Partial refund on booking ${booking.id}: $${(charge.amount_refunded / 100).toFixed(2)} of $${(charge.amount / 100).toFixed(2)}${refundCoversProtection ? " — PG cancellation triggered" : ""}`
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
          // continue billing Triply for a refunded booking. Gated on
          // pg_identifier to avoid re-firing if a prior partial-refund event
          // already cleared it (idempotency).
          if (booking.protection_plan && booking.pg_identifier && !updateErr) {
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
          } else if (
            booking.protection_plan &&
            !booking.pg_identifier &&
            booking.pg_sync_status !== "synced" &&
            !updateErr
          ) {
            // Orphan: customer paid for protection but PG capture never
            // produced an identifier — capture failed or MISSING_DATA
            // happened. Ops needs to verify PG side so the reconciliation
            // script doesn't later re-enroll a refunded booking.
            //
            // Excludes the "captured then cleared by a prior partial-refund
            // event" case, where pg_sync_status stays 'synced' even after
            // pg_identifier is nulled. That state was already handled by
            // the partial-refund branch's PG cancel call.
            captureParkGuardError(
              new Error(
                `Full refund on protection-opted booking ${booking.id} with no pg_identifier — verify PG side has no active enrollment to avoid post-refund billing`
              ),
              { bookingId: booking.id, operation: "update" }
            );
          }
        }
      }
      break;
    }

    default:
      break;
  }

  if (retryable) {
    // NOT an error — a deliberate request for redelivery. Stripe backs off and
    // retries for ~3 days, which is the durable queue that finishes bookings
    // abandoned mid-flight. Every terminal outcome above falls through to the
    // 2xx below so Stripe stops redelivering settled events.
    return NextResponse.json(
      { received: true, retry: true },
      { status: 503 }
    );
  }

  return NextResponse.json({ received: true });
}
