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
 * PaymentIntent can corroborate is checked; `hasProtectionPlan` is DERIVED from
 * PI metadata rather than trusted, because it determines what the customer paid.
 */

import { NextRequest, NextResponse } from "next/server";
import { stripe } from "@/lib/stripe/client";
import { createAdminClient } from "@/lib/supabase/server";
import { pendingBookingSchema } from "@/lib/validation/schemas";
import { capturePaymentError } from "@/lib/sentry";

export const maxDuration = 15;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const result = pendingBookingSchema.safeParse(body);
    if (!result.success) {
      return NextResponse.json(
        { error: result.error.issues[0].message },
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
        { error: "Booking details do not match this payment" },
        { status: 400 }
      );
    }

    // Authoritative, not client-supplied: this determines what Stripe charged.
    const protectionPriceStr = meta.protectionPlanPrice;
    const hasProtectionPlan =
      !!protectionPriceStr && parseFloat(protectionPriceStr) > 0;

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
        user_id: payload.userId ?? null,
        has_protection_plan: hasProtectionPlan,
        livemode: pi.livemode,
        status: "pending",
      });

    if (insertError) {
      // 23505 = the row already exists. Benign: a retry, or the customer
      // re-submitted. The stored payload stands.
      if ((insertError as { code?: string }).code === "23505") {
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
      { error: "Could not prepare your booking. Please try again." },
      { status: 500 }
    );
  }
}
