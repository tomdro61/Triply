/**
 * POST /api/reservations/pending
 *
 * Stages the complete booking payload to `pending_bookings` immediately BEFORE
 * the customer confirms payment. This is what makes the booking survive the
 * browser: after this call, the Stripe webhook can create the reservation
 * server-side even if the customer is redirected to their bank and never
 * returns, closes the tab, or loses connectivity.
 *
 * SECURITY: this endpoint is unauthenticated (the customer is a guest at this
 * point), so it MUST bind the payload to the PaymentIntent. Without that, anyone
 * could stage a row for someone else's PaymentIntent and redirect the
 * confirmation email — and the fulfilment paths trust this row for the ResLab
 * reservation (vehicle, name, phone are not in PI metadata). Every field the
 * PaymentIntent can corroborate is checked; `protectionPlanCode` is DERIVED from
 * PI metadata rather than trusted, because it determines what the customer paid.
 */

import { NextRequest, NextResponse } from "next/server";
import { stripe } from "@/lib/stripe/client";
import { createAdminClient } from "@/lib/supabase/server";
import { pendingBookingSchema } from "@/lib/validation/schemas";
import { capturePaymentError, captureBookingError } from "@/lib/sentry";
import { readProtectionMetadata, STALE_CHECKOUT_MESSAGE } from "@/lib/parkguard/client";
import { readAttributionFromRequest } from "@/lib/attribution/read-request";
import { sessionIdentityFromRequest } from "@/lib/booking/customer-link";

export const maxDuration = 15;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    // A checkout page loaded before the plan-tier deploy still posts the old
    // boolean. Refuse with an actionable message instead of a Zod issue.
    if (body && typeof body === "object" && "hasProtectionPlan" in body) {
      return NextResponse.json({ error: STALE_CHECKOUT_MESSAGE }, { status: 400 });
    }
    const result = pendingBookingSchema.safeParse(body);
    if (!result.success) {
      // This endpoint runs BEFORE confirmPayment — the customer genuinely has
      // not been charged on any failure here. Say so, on every message: the
      // client shows these verbatim, and the reassurance is the whole point of
      // failing closed before the charge.
      return NextResponse.json(
        { error: `${result.error.issues[0].message} — you have not been charged.` },
        { status: 400 }
      );
    }

    const payload = result.data;
    const piId = payload.stripePaymentIntentId;

    const pi = await stripe.paymentIntents.retrieve(piId);
    const meta = pi.metadata ?? {};

    // --- Bind the payload to the PaymentIntent -------------------------------
    // Keys added by this release are checked only WHEN PRESENT: PaymentIntents
    // created before deploy won't carry them, and rejecting those would break
    // every checkout already in flight at cutover.
    const mismatches: string[] = [];

    if (
      meta.customerEmail &&
      meta.customerEmail.trim().toLowerCase() !==
        payload.customer.email.trim().toLowerCase()
    ) {
      mismatches.push("customerEmail");
    }
    if (meta.locationId && Number(meta.locationId) !== payload.locationId) {
      mismatches.push("locationId");
    }
    if (meta.checkin && !payload.fromDate.startsWith(meta.checkin)) {
      mismatches.push("checkin");
    }
    if (meta.checkout && !payload.toDate.startsWith(meta.checkout)) {
      mismatches.push("checkout");
    }
    if (
      meta.parkingTypeId &&
      Number(meta.parkingTypeId) !== payload.parkingTypeId
    ) {
      mismatches.push("parkingTypeId");
    }

    if (mismatches.length > 0) {
      capturePaymentError(
        new Error(
          `Pending-booking staging rejected — payload does not match PaymentIntent metadata: ${mismatches.join(
            ", "
          )}`
        ),
        { stripePaymentIntentId: piId, amount: pi.amount / 100 }
      );
      return NextResponse.json(
        { error: "Booking details do not match this payment — you have not been charged." },
        { status: 400 }
      );
    }

    // Authoritative, not client-supplied: this determines what Stripe charged.
    // The tier code and its price are stamped as a PAIR by /api/checkout/lot
    // and /update-pi (see readProtectionMetadata). Both present → that tier;
    // both absent → no protection. A half pair, an unknown code, or a
    // price-only pair (which only the pre-tier bundle could stamp) is refused:
    // we are still before the charge, and guessing either way would stage a
    // tier other than the one Stripe holds.
    const metaProtection = readProtectionMetadata(meta);
    if (metaProtection.kind === "invalid" || metaProtection.kind === "legacy_plan_a") {
      capturePaymentError(
        new Error(
          `Pending-booking staging rejected — PaymentIntent protection metadata ${
            metaProtection.kind === "invalid"
              ? `is inconsistent: ${metaProtection.detail}`
              : "carries a price but no tier code (pre-tier bundle)"
          }`
        ),
        { stripePaymentIntentId: piId, amount: pi.amount / 100 }
      );
      return NextResponse.json(
        {
          error:
            "Your protection selection couldn't be verified — please choose it again. You have not been charged.",
        },
        { status: 400 }
      );
    }
    const protectionPlanCode =
      metaProtection.kind === "tier" ? metaProtection.code : null;

    // The client's own value must agree with what Stripe holds. It can only
    // differ through a bug or a tampered request: the selector is locked while
    // an /update-pi call is in flight and Pay Now stays disabled until it lands.
    if (payload.protectionPlanCode !== protectionPlanCode) {
      capturePaymentError(
        new Error(
          `Pending-booking staging rejected — client protectionPlanCode ${JSON.stringify(
            payload.protectionPlanCode
          )} does not match PaymentIntent metadata ${JSON.stringify(protectionPlanCode)}`
        ),
        { stripePaymentIntentId: piId, amount: pi.amount / 100 }
      );
      return NextResponse.json(
        {
          error:
            "Your protection selection doesn't match this payment — please choose it again. You have not been charged.",
        },
        { status: 400 }
      );
    }

    // Marketing attribution from the first-party cookie — read AFTER the body
    // and PaymentIntent checks above, never from the client body. Absent/
    // invalid resolve to null / an "invalid" marker; it never blocks staging.
    const attribution = readAttributionFromRequest(request, { stripePaymentIntentId: piId });

    // Identity from the session cookie, never the client body (see
    // customer-link.ts). Staged on the row so the webhook and sweep paths —
    // which have no session — fulfil with the same server-derived id.
    const { identity, reason: identityReason } = await sessionIdentityFromRequest();
    if (payload.userId && payload.userId !== (identity?.userId ?? null)) {
      // Two very different situations, kept apart at triage: the server could
      // not read a session at all (an auth fault or a token race — the
      // customer becomes a guest for this booking), or it read a DIFFERENT
      // user than the body claims (tampering, or a sign-out in another tab).
      captureBookingError(
        new Error(
          identityReason === "auth_error"
            ? `session unreadable; client userId dropped (booking proceeds as guest) pi=${piId}`
            : identity === null
              ? `client sent a userId but no session cookie was present (stale bundle or signed out) pi=${piId}`
              : `client-supplied userId differs from the session user pi=${piId}`
        ),
        { step: "checkout" }
      );
    }
    const sessionUserId = identity?.userId ?? null;

    // --- Refuse to overwrite work already in progress ------------------------
    const supabase = await createAdminClient();

    const { data: existingBooking } = await supabase
      .from("bookings")
      .select("id")
      .eq("stripe_payment_intent_id", piId)
      .maybeSingle();

    if (existingBooking) {
      // Already fulfilled. Staging now would be a no-op at best and could
      // repoint a confirmation at worst.
      return NextResponse.json({ staged: false, reason: "already_booked" });
    }

    // Insert only. An existing row means either a retry of this same staging
    // call or a fulfilment already under way — either way the stored payload
    // wins, so we never clobber a row another caller may be mid-way through.
    const { error: insertError } = await supabase
      .from("pending_bookings")
      .insert({
        stripe_payment_intent_id: piId,
        location_id: payload.locationId,
        costs_token: payload.costsToken,
        from_date: payload.fromDate,
        to_date: payload.toDate,
        parking_type_id: payload.parkingTypeId,
        customer: payload.customer,
        vehicle: payload.vehicle,
        extra_fields: payload.extraFields ?? null,
        confirmation_params: payload.confirmationParams ?? null,
        location_name: payload.locationName ?? null,
        location_address: payload.locationAddress ?? null,
        airport_code: payload.airportCode ?? null,
        subtotal: payload.subtotal ?? null,
        tax_total: payload.taxTotal ?? null,
        fees_total: payload.feesTotal ?? null,
        grand_total: payload.grandTotal ?? null,
        triply_service_fee: payload.triplyServiceFee ?? null,
        user_id: sessionUserId,
        // Written in lockstep: the boolean predates the tier column and is
        // still read by the legacy-row rule in create-booking.ts.
        has_protection_plan: protectionPlanCode !== null,
        protection_plan_code: protectionPlanCode,
        attribution,
        livemode: pi.livemode,
        status: "pending",
      });

    if (insertError) {
      // 23505 = the row already exists: an EARLIER Pay Now attempt on this
      // PaymentIntent (e.g. a declined card). The stored payload stands —
      // except the tier, which the customer may have changed in between; the
      // tier derived above is what Stripe holds NOW. Refresh only those two
      // columns, only while the row is still `pending` (never clobber a row a
      // fulfilment path has claimed). Fulfilment re-derives the tier from the
      // PaymentIntent regardless; this keeps the durable row honest for ops
      // and reconciliation, and keeps the fulfilment-side mismatch alert quiet
      // on this legitimate flow.
      if ((insertError as { code?: string }).code === "23505") {
        const { error: refreshError } = await supabase
          .from("pending_bookings")
          .update({
            protection_plan_code: protectionPlanCode,
            has_protection_plan: protectionPlanCode !== null,
          })
          .eq("stripe_payment_intent_id", piId)
          .eq("status", "pending");
        if (refreshError) {
          // Not fatal: fulfilment trusts the PaymentIntent, not this column.
          capturePaymentError(
            new Error(
              `Pending-booking tier refresh failed on already_staged row: ${refreshError.message}`
            ),
            { stripePaymentIntentId: piId, amount: pi.amount / 100 }
          );
        }
        return NextResponse.json({ staged: true, reason: "already_staged" });
      }
      throw new Error(insertError.message);
    }

    return NextResponse.json({ staged: true });
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    capturePaymentError(err, {});
    // FAIL CLOSED. The client aborts the charge when this call fails, which is
    // the intended trade: a customer who cannot check out is recoverable, a
    // customer charged with no durable record of what they bought is not.
    return NextResponse.json(
      { error: "Could not prepare your booking. Please try again — you have not been charged." },
      { status: 500 }
    );
  }
}
