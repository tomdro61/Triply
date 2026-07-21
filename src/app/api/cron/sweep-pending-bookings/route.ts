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

/** A checkout that has sat un-actioned this long is genuinely abandoned. Well
 *  past any plausible 3-D Secure delay or "let me find another card" detour —
 *  those routinely take tens of minutes, which is why a short window here
 *  expired live checkouts and manufactured orphan charges. */
const ABANDON_AFTER_MS = 72 * 60 * 60_000;

/** Row ceiling per run. NOT a duration guarantee — one createBooking can take
 *  ~30s (the ResLab timeout), so the elapsed-time guard below is what actually
 *  keeps a run inside maxDuration. Leftovers are picked up next tick. */
const MAX_PER_RUN = 25;

/** Stop starting new work past this, leaving headroom for the in-flight one to
 *  finish inside maxDuration=60. */
const RUN_BUDGET_MS = 45_000;

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

    const startedAt = Date.now();
    const result = {
      scanned: stuck?.length ?? 0,
      redriven: 0,
      completed: 0,
      expired: 0,
      escalated: 0,
      stillPending: 0,
      skipped: 0,
      /** Writes that did not land. Any of these makes the run non-ok. */
      failed: 0,
      /** Left for the next tick because the time budget ran out. */
      deferredToNextRun: 0,
    };

    for (const row of stuck ?? []) {
      if (Date.now() - startedAt > RUN_BUDGET_MS) {
        result.deferredToNextRun++;
        continue;
      }
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

      // Retire a row ONLY when its PaymentIntent can never succeed.
      //
      // A Stripe PaymentIntent does NOT auto-expire. It sits in
      // `requires_payment_method` or `requires_action` indefinitely and can
      // succeed hours later — and the checkout form reuses one client secret for
      // the whole session, so "card declined, customer finds another card, pays
      // 20 minutes later" reuses this very PI. Expiring on those statuses wrote a
      // TERMINAL row under a live checkout: the later `succeeded` webhook then
      // found it terminal, returned `failed` with a 200, Stripe stopped
      // redelivering, and the customer was charged with no booking and no alert —
      // the exact orphan this cron exists to prevent, manufactured by the cron.
      //
      // So: `canceled` is the only status that is safe on its own, because a
      // canceled PI genuinely cannot come back.
      const age = Date.now() - Date.parse(row.created_at);
      const cannotSucceed = pi.status === "canceled";
      const longAbandoned =
        age > ABANDON_AFTER_MS &&
        (pi.status === "requires_payment_method" ||
          pi.status === "requires_action" ||
          pi.status === "requires_confirmation");

      if (cannotSucceed || longAbandoned) {
        // For a long-abandoned checkout, CANCEL the PaymentIntent first so it is
        // genuinely incapable of succeeding later. Only then is expiring the row
        // a statement of fact rather than a bet.
        if (longAbandoned) {
          try {
            await stripe.paymentIntents.cancel(piId);
          } catch {
            // Already canceled, or transitioned under us. Re-read next tick
            // rather than expiring a row whose PI might now be live.
            result.skipped++;
            continue;
          }
        }

        const { error: expireErr } = await supabase
          .from("pending_bookings")
          .update({ status: "expired", last_error: `swept: PI ${pi.status}` })
          .eq("stripe_payment_intent_id", piId)
          .in("status", ["pending", "processing"]);

        if (expireErr) {
          // Do NOT release the cart claim when the status write failed — that
          // would leave a live row with its duplicate protection silently gone.
          result.failed++;
          capturePaymentError(
            new Error(`Sweep could not expire ${piId}: ${expireErr.message}`),
            { stripePaymentIntentId: piId }
          );
          continue;
        }

        const { error: cartErr } = await supabase
          .from("cart_claims")
          .update({ released_at: new Date().toISOString() })
          .eq("stripe_payment_intent_id", piId)
          .is("released_at", null);
        if (cartErr) {
          result.failed++;
          capturePaymentError(
            new Error(`Sweep could not release the cart claim for ${piId}: ${cartErr.message}`),
            { stripePaymentIntentId: piId }
          );
        }
        result.expired++;
        continue;
      }

      // Not fulfillable and not old enough to abandon — a checkout still in
      // flight. Leave it entirely alone.
      if (
        pi.status !== "succeeded" &&
        pi.status !== "requires_capture" &&
        pi.status !== "processing"
      ) {
        result.skipped++;
        continue;
      }

      // Money IS in flight. If we've been trying for days, stop re-driving and
      // put a human on it.
      if (age > GIVE_UP_AFTER_MS) {
        const { error: giveUpErr } = await supabase
          .from("pending_bookings")
          .update({
            status: "needs_reconciliation",
            last_error: `swept: unresolved after ${Math.round(age / 86_400_000)}d`,
          })
          .eq("stripe_payment_intent_id", piId)
          .in("status", ["pending", "processing"]);
        if (giveUpErr) result.failed++;
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
      // Source "sweep", not "webhook". A sweep completion means something
      // strictly worse than a dead browser — Stripe's retry budget was exhausted
      // or no webhook ever fired — and laundering it as a routine webhook
      // completion would hide exactly the signal this rollout needs to watch.
      const outcome = await createBooking({ source: "sweep", stripePaymentIntentId: piId });
      if (outcome.kind === "created" || outcome.kind === "already_exists") {
        result.completed++;
      } else if (outcome.kind === "in_progress" || outcome.kind === "deferred") {
        result.stillPending++;
      } else if (outcome.kind === "needs_reconciliation") {
        result.escalated++;
      }
    }

    // A monitor whose failure looks like health is worse than no monitor. If any
    // write did not land, this run is NOT ok, regardless of how tidy the tally
    // reads — otherwise a permanently-failing write shows a permanently green cron.
    if (result.failed > 0) {
      return NextResponse.json(
        { ok: false, error: `${result.failed} sweep write(s) failed`, livemode, ...result },
        { status: 500 }
      );
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
