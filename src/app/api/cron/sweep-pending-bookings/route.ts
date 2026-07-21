/**
 * GET /api/cron/sweep-pending-bookings
 *
 * Re-drives booking fulfilments that stalled, and retires the ones that never
 * had a payment behind them.
 *
 * WHY THIS EXISTS. The engine's recovery story was originally "Stripe redelivers
 * the webhook, and the stale-claim steal lets the redelivery finish the job."
 * That is true but not sufficient, in three ways found across successive reviews:
 *
 *   1. Stripe's retry budget is finite (~3 days). A row still unresolved after it
 *      expires has nothing left to re-drive it.
 *   2. The client `deferred` path has no webhook at all if the tab closes before
 *      the payment settles.
 *   3. Status `expired` existed in the schema with nothing that ever wrote it, so
 *      abandoned checkouts accumulated as `pending` forever — and their cart
 *      claims with them, which made the customer's next attempt at that lot and
 *      those dates look like a duplicate.
 *
 * Design rule for a MONITOR (inherited from reconcile-payments): its FAILURE must
 * never look like its HEALTHY state. Every failure path here is loud and returns
 * non-ok so Vercel cron alerting fires. Silence means a clean run.
 */

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { stripe } from "@/lib/stripe/client";
import { createBooking } from "@/lib/booking/create-booking";
import { capturePaymentError } from "@/lib/sentry";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Old enough that every in-request path has certainly finished. Comfortably
 *  above STALE_CLAIM_MS (90s) and every route's maxDuration (60s). */
const STALE_AFTER_MS = 15 * 60_000;

/** Don't re-drive forever. Past this, a row is escalated for manual triage
 *  instead — well beyond Stripe's own retry budget. */
const GIVE_UP_AFTER_MS = 4 * 24 * 60 * 60_000;

/** Bounded so one run can't exceed maxDuration. Anything left is picked up next
 *  tick; the count is reported so a persistent backlog is visible. */
const MAX_PER_RUN = 25;

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { ok: false, error: "CRON_SECRET is not configured" },
      { status: 500 }
    );
  }
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const livemode = (process.env.STRIPE_SECRET_KEY || "").startsWith("sk_live_");

  try {
    const supabase = await createAdminClient();
    const staleBefore = new Date(Date.now() - STALE_AFTER_MS).toISOString();

    // Uses idx_pending_bookings_stuck. livemode filtering is mandatory —
    // Triply-prod is shared by staging and production.
    const { data: stuck, error } = await supabase
      .from("pending_bookings")
      .select("stripe_payment_intent_id, status, created_at, reslab_reservation_number")
      .in("status", ["pending", "processing"])
      .eq("livemode", livemode)
      .lt("updated_at", staleBefore)
      .order("created_at", { ascending: true })
      .limit(MAX_PER_RUN);

    if (error) {
      return escalate(`pending_bookings sweep query failed: ${error.message}`);
    }

    const result = {
      scanned: stuck?.length ?? 0,
      redriven: 0,
      completed: 0,
      expired: 0,
      escalated: 0,
      stillPending: 0,
    };

    for (const row of stuck ?? []) {
      const piId = row.stripe_payment_intent_id;

      let pi;
      try {
        pi = await stripe.paymentIntents.retrieve(piId);
      } catch {
        // Can't read the PaymentIntent — leave the row alone rather than guess.
        result.escalated++;
        capturePaymentError(
          new Error(`Sweep could not retrieve PaymentIntent ${piId}; row left untouched`),
          { stripePaymentIntentId: piId }
        );
        continue;
      }

      // Abandoned or declined checkout: no money was ever taken, so there is
      // nothing to fulfil and nothing to alert about. Retire the row and free its
      // cart claim. This is the only writer of `expired`.
      if (
        pi.status === "requires_payment_method" ||
        pi.status === "requires_action" ||
        pi.status === "requires_confirmation" ||
        pi.status === "canceled"
      ) {
        await supabase
          .from("pending_bookings")
          .update({ status: "expired", last_error: `swept: PI ${pi.status}` })
          .eq("stripe_payment_intent_id", piId)
          .in("status", ["pending", "processing"]);
        await supabase
          .from("cart_claims")
          .update({ released_at: new Date().toISOString() })
          .eq("stripe_payment_intent_id", piId)
          .is("released_at", null);
        result.expired++;
        continue;
      }

      // Money IS in flight. If we've been trying for days, stop re-driving and
      // put a human on it.
      const age = Date.now() - Date.parse(row.created_at);
      if (age > GIVE_UP_AFTER_MS) {
        await supabase
          .from("pending_bookings")
          .update({
            status: "needs_reconciliation",
            last_error: `swept: unresolved after ${Math.round(age / 86_400_000)}d`,
          })
          .eq("stripe_payment_intent_id", piId)
          .in("status", ["pending", "processing"]);
        result.escalated++;
        capturePaymentError(
          new Error(
            `Pending booking ${piId} unresolved after ${Math.round(
              age / 86_400_000
            )} days (PI ${pi.status}${
              row.reslab_reservation_number
                ? `, ResLab ${row.reslab_reservation_number} EXISTS`
                : ", no reservation"
            }). Manual recovery required.`
          ),
          { stripePaymentIntentId: piId, amount: pi.amount / 100 }
        );
        continue;
      }

      // Re-drive through the same idempotent engine the webhook uses. It handles
      // the resume path, so a row that already has a reservation number adopts it
      // rather than creating a second one.
      result.redriven++;
      const outcome = await createBooking({ source: "webhook", stripePaymentIntentId: piId });
      if (outcome.kind === "created" || outcome.kind === "already_exists") {
        result.completed++;
      } else if (outcome.kind === "in_progress" || outcome.kind === "deferred") {
        result.stillPending++;
      } else if (outcome.kind === "needs_reconciliation") {
        result.escalated++;
      }
    }

    return NextResponse.json({ ok: true, livemode, ...result });
  } catch (err) {
    return escalate(
      `pending_bookings sweep threw: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

function escalate(message: string) {
  capturePaymentError(new Error(message), {});
  return NextResponse.json({ ok: false, error: message }, { status: 500 });
}
