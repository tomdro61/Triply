/**
 * Booking fulfilment — ResLab reservation, Supabase persistence, Park Guard
 * enrolment, and notification emails.
 *
 * Extracted verbatim-in-behaviour from POST /api/reservations so the same
 * fulfilment can be driven by all three entry points (the browser, the
 * /checkout/complete redirect-return page, and the Stripe webhook). This module
 * knows NOTHING about payment state — no capture, no refund, no PaymentIntent
 * branching. That lives in create-booking.ts. Keeping them apart is deliberate:
 * money decisions must be readable in one place.
 */

import type { z } from "zod";
import { reslab, stripHtml } from "@/lib/reslab/client";
import type { ReslabReservation } from "@/lib/reslab/client";
import { createAdminClient } from "@/lib/supabase/server";
import { sendBookingConfirmation } from "@/lib/resend/send-booking-confirmation";
import { sendAdminBookingNotification } from "@/lib/resend/send-admin-booking-notification";
import type { reservationSchema } from "@/lib/validation/schemas";
import {
  capturePaymentError,
  captureParkGuardError,
  captureBookingError,
} from "@/lib/sentry";
import { convertTo12Hour } from "@/lib/utils/time";
import {
  parkGuard,
  PROTECTION_PLAN,
  ParkGuardError,
  PARKGUARD_STATUS,
  formatPgDate,
} from "@/lib/parkguard/client";

export type BookingPayload = z.infer<typeof reservationSchema>;

export type PgSyncStatus = "pending" | "synced" | "skipped_missing_data" | null;

export interface PersistResult {
  bookingId: string | null;
  pgIdentifier: string | null;
  pgSyncStatus: PgSyncStatus;
  /** True when the booking row itself failed to insert. Money is already
   *  committed at this point, so the caller must escalate rather than refund. */
  bookingInsertFailed: boolean;
  /** True when that failure will recur identically on every retry — a Postgres
   *  integrity violation (23xxx other than 23505). Retrying those burns Stripe's
   *  entire ~3-day redelivery budget on an insert that can never succeed, and
   *  leaves the pending row parked with nothing left to re-drive it. */
  bookingInsertPermanent: boolean;
  /** Set when the insert lost a race on UNIQUE(stripe_payment_intent_id). */
  duplicatePaymentIntent: boolean;
}

/**
 * Create the reservation at ResLab.
 *
 * Throws on failure. The caller MUST distinguish a definitive rejection (4xx —
 * nothing was created, safe to release the payment) from an ambiguous one
 * (5xx / timeout — a reservation may or may not exist, and ResLab gives us no
 * idempotency key with which to find out). See classifyReslabError.
 */
export async function createReslabReservation(
  payload: BookingPayload
): Promise<ReslabReservation> {
  const { customer, vehicle, extraFields } = payload;

  const apiExtraFields: Record<string, string> = {
    car_make: vehicle.make,
    car_model: vehicle.model,
    car_makemodel: `${vehicle.make} ${vehicle.model}`, // Combined field required by ResLab
    car_color: vehicle.color,
    license_plate: vehicle.licensePlate,
    license_plate_state: vehicle.state,
    ...extraFields,
  };

  const fullName = `${customer.firstName} ${customer.lastName}`;

  return reslab.createReservation({
    location_id: payload.locationId,
    costs_token: payload.costsToken,
    reserved_by: fullName,
    reserved_for: fullName,
    phone: customer.phone,
    email: customer.email,
    items: [
      {
        type: "parking",
        reservation_type: "parking",
        type_id: payload.parkingTypeId,
        from_date: payload.fromDate,
        to_date: payload.toDate,
        number_of_spots: 1,
      },
    ],
    ...apiExtraFields,
  });
}

/**
 * Persist the customer + booking rows, then enrol Park Guard.
 *
 * Never throws — every failure is captured and reported through PersistResult so
 * the payment state machine can decide what to do with money that has already
 * moved. Throwing here would strand the caller mid-transition.
 */
/** The promo the customer redeemed, derived from PI metadata by the caller.
 *  `code` is the redeemed code (uppercased); `discountPercent` is the applied
 *  percent (0 when none); `chargedCents` is `pi.amount` — the REAL amount Stripe
 *  charged, used to derive the discount exactly. Absent on the DEV_SKIP_PAYMENT
 *  path (no PaymentIntent). */
export interface AppliedPromo {
  code: string | null;
  discountPercent: number;
  chargedCents: number;
}

export async function persistBooking(
  payload: BookingPayload,
  reservation: ReslabReservation,
  promo?: AppliedPromo
): Promise<PersistResult> {
  const {
    locationId,
    fromDate,
    toDate,
    customer,
    vehicle,
    locationName,
    locationAddress,
    airportCode,
    subtotal,
    taxTotal,
    feesTotal,
    grandTotal,
    triplyServiceFee,
    userId,
    stripePaymentIntentId,
    hasProtectionPlan,
  } = payload;

  const resHistory = reservation.history?.[0];
  const result: PersistResult = {
    bookingId: null,
    pgIdentifier: null,
    pgSyncStatus: null,
    bookingInsertFailed: false,
    bookingInsertPermanent: false,
    duplicatePaymentIntent: false,
  };

  try {
    const supabase = await createAdminClient();

    // --- Customer upsert -----------------------------------------------------
    let customerId: string;
    let existingCustomer: { id: string } | null = null;

    if (userId) {
      const { data: customerByUserId } = await supabase
        .from("customers")
        .select("id")
        .eq("user_id", userId)
        .single();
      if (customerByUserId) existingCustomer = customerByUserId;
    }

    if (!existingCustomer) {
      const { data: customerByEmail } = await supabase
        .from("customers")
        .select("id")
        .eq("email", customer.email)
        .single();
      if (customerByEmail) existingCustomer = customerByEmail;
    }

    if (existingCustomer) {
      customerId = existingCustomer.id;
      await supabase
        .from("customers")
        .update({
          first_name: customer.firstName,
          last_name: customer.lastName,
          phone: customer.phone,
          ...(userId && { user_id: userId }),
        })
        .eq("id", customerId);
    } else {
      const { data: newCustomer, error: customerError } = await supabase
        .from("customers")
        .insert({
          email: customer.email,
          first_name: customer.firstName,
          last_name: customer.lastName,
          phone: customer.phone,
          ...(userId && { user_id: userId }),
        })
        .select("id")
        .single();

      if (customerError) throw customerError;
      customerId = newCustomer.id;
    }

    const storedSubtotal = subtotal || resHistory?.subtotal || 0;

    // Discount taken off the online charge by the promo, derived from the ACTUAL
    // Stripe charge (`chargedCents`) rather than re-computing percent × subtotal.
    // Re-rounding the discount by itself drifted 1¢ vs Stripe on ~19% of promos
    // (half-cent-boundary subtotals like ".95" at 10%): Stripe subtracts an
    // UNROUNDED discount and rounds the whole total once. Deriving from what was
    // actually charged makes admin "Paid online" (= booking total − due −
    // discount) reconcile to Stripe EXACTLY, by construction.
    const discountPercent = promo?.discountPercent ?? 0;
    let discountAmount = 0;
    if (discountPercent > 0 && promo) {
      const preDiscountOnlineCents = Math.round(
        ((resHistory?.grand_total ?? grandTotal ?? 0) +
          (triplyServiceFee || 0) +
          (hasProtectionPlan ? PROTECTION_PLAN.price : 0) -
          (resHistory?.due_at_location_total || 0)) *
          100
      );
      discountAmount =
        Math.max(0, preDiscountOnlineCents - promo.chargedCents) / 100;
    }
    // Only record the code when a discount was actually applied (an invalid code
    // that was typed but not honored leaves no discount and isn't "used").
    const promoCode = discountAmount > 0 ? promo?.code ?? null : null;

    // --- Booking row ---------------------------------------------------------
    const { data: bookingRow, error: bookingError } = await supabase
      .from("bookings")
      .insert({
        customer_id: customerId,
        reslab_reservation_number: reservation.reservation_number,
        reslab_location_id: locationId,
        location_name:
          locationName || resHistory?.location?.name || `Location ${locationId}`,
        location_address: locationAddress || resHistory?.location?.address || "",
        airport_code: airportCode || "",
        // Literal wall-clock strings. bookings.check_in/check_out are TIMESTAMP
        // (migration 007), NOT TIMESTAMPTZ — no conversion, no Date math.
        check_in: fromDate,
        check_out: toDate,
        subtotal: storedSubtotal,
        tax_total: taxTotal || resHistory?.total_tax || 0,
        fees_total: feesTotal || resHistory?.total_fees || 0,
        // ResLab is source of truth for parking revenue; the client value is
        // only a fallback if ResLab didn't echo it back. The protection premium
        // lives in protection_plan_price so reporting can read them apart.
        grand_total: resHistory?.grand_total ?? grandTotal ?? 0,
        triply_service_fee: triplyServiceFee || 0,
        due_at_location: resHistory?.due_at_location_total || 0,
        // Promo (migration 016). discount_amount is always written (0 = none) so
        // reporting never sees NULL; promo_code only when a discount applied.
        discount_amount: discountAmount,
        ...(promoCode && { promo_code: promoCode }),
        vehicle_info: vehicle,
        status: "confirmed",
        ...(stripePaymentIntentId && {
          stripe_payment_intent_id: stripePaymentIntentId,
        }),
        ...(hasProtectionPlan && {
          protection_plan: PROTECTION_PLAN.name,
          protection_plan_price: PROTECTION_PLAN.price,
        }),
      })
      .select("id")
      .single();

    if (bookingError) {
      // 23505 on stripe_payment_intent_id means a concurrent caller already
      // inserted this booking. That is a SUCCESS for idempotency purposes, not
      // a failure — the customer has their reservation. Distinguish it so the
      // caller doesn't fire a money alert for a race we handled correctly.
      const code = (bookingError as { code?: string }).code;
      const isDuplicate = code === "23505";
      result.duplicatePaymentIntent = isDuplicate;
      result.bookingInsertFailed = !isDuplicate;
      // Postgres class 23 = integrity constraint violation (NOT NULL, FK, CHECK).
      // Deterministic: the same row will be rejected identically every time.
      result.bookingInsertPermanent =
        !isDuplicate && !!code && /^23\d{3}$/.test(code);

      if (!isDuplicate) {
        captureBookingError(
          new Error(`Booking insert failed: ${bookingError.message}`),
          { step: "checkout", airportCode }
        );
        if (hasProtectionPlan) {
          const ctxErr = new Error(
            `Booking insert failed for protection-opted reservation; customer charged for premium but Park Guard not enrolled: ${bookingError.message}`
          );
          captureParkGuardError(ctxErr, {
            reslabReservationNumber: reservation.reservation_number,
            operation: "capture",
          });
          if (stripePaymentIntentId) {
            capturePaymentError(ctxErr, {
              stripePaymentIntentId,
              amount: PROTECTION_PLAN.price,
            });
          }
        }
      }
      return result;
    }

    result.bookingId = bookingRow.id;

    // --- Park Guard (non-blocking) ------------------------------------------
    if (hasProtectionPlan && bookingRow?.id) {
      const pg = await enrolParkGuard(
        payload,
        reservation,
        bookingRow.id,
        supabase
      );
      result.pgIdentifier = pg.pgIdentifier;
      result.pgSyncStatus = pg.pgSyncStatus;
    }

    return result;
  } catch (supabaseError) {
    const sbErr =
      supabaseError instanceof Error
        ? supabaseError
        : new Error(String(supabaseError));
    result.bookingInsertFailed = true;
    captureBookingError(sbErr, { step: "checkout", airportCode });
    if (hasProtectionPlan) {
      const ctxErr = new Error(
        `Supabase save failed for protection-opted reservation; customer charged for premium but Park Guard not enrolled: ${sbErr.message}`
      );
      captureParkGuardError(ctxErr, {
        reslabReservationNumber: reservation.reservation_number,
        operation: "capture",
      });
      if (stripePaymentIntentId) {
        capturePaymentError(ctxErr, {
          stripePaymentIntentId,
          amount: PROTECTION_PLAN.price,
        });
      }
    }
    return result;
  }
}

/**
 * Park Guard enrolment. Never throws — a PG outage must not fail a paid booking,
 * but every failure is captured for background reconciliation.
 */
async function enrolParkGuard(
  payload: BookingPayload,
  reservation: ReslabReservation,
  bookingId: string,
  supabase: Awaited<ReturnType<typeof createAdminClient>>
): Promise<{ pgIdentifier: string | null; pgSyncStatus: PgSyncStatus }> {
  const { fromDate, toDate, customer, vehicle, locationAddress } = payload;
  const resHistory = reservation.history?.[0];

  try {
    const [startDate, startTime24] = fromDate.split(" ");
    const [endDate, endTime24] = toDate.split(" ");
    // Local components, not toISOString — Vercel runs UTC, so toISOString would
    // shift late-evening ET bookings to the next day's date.
    const todayDate = formatPgDate(new Date());
    const pgLocation = resHistory?.location;

    const pgStreet = pgLocation?.address || locationAddress;
    const pgCity = pgLocation?.city;
    const pgState = pgLocation?.state?.code;
    const pgZip = pgLocation?.zip_code;

    if (!pgStreet || !pgCity || !pgState || !pgZip) {
      // Distinct sentinel so alerting and reconciliation can tell this PERMANENT
      // skip apart from a transient outage. Empty strings would 422 on PG's side
      // and be indistinguishable from a real failure.
      captureParkGuardError(
        new Error(
          `Park Guard capture skipped — required address fields missing: street=${!!pgStreet}, city=${!!pgCity}, state=${!!pgState}, zip=${!!pgZip}`
        ),
        {
          bookingId,
          reslabReservationNumber: reservation.reservation_number,
          operation: "capture",
          statusCode: PARKGUARD_STATUS.MISSING_DATA,
        }
      );
      const { error: skipUpdateErr } = await supabase
        .from("bookings")
        .update({ pg_sync_status: "skipped_missing_data" })
        .eq("id", bookingId);
      if (skipUpdateErr) {
        captureParkGuardError(
          new Error(
            `Failed to persist 'skipped_missing_data' status: ${skipUpdateErr.message}`
          ),
          {
            bookingId,
            reslabReservationNumber: reservation.reservation_number,
            operation: "update",
          }
        );
      }
      return { pgIdentifier: null, pgSyncStatus: "skipped_missing_data" };
    }

    const pgRes = await parkGuard.captureReservation({
      reservation_id: bookingId,
      reservation_start_date: startDate,
      reservation_end_date: endDate,
      booking_date: todayDate,
      parking_street_address: pgStreet,
      parking_city: pgCity,
      parking_state: pgState,
      parking_zipcode: pgZip,
      // PG expects "Plan A"/"Plan B"/"Plan C" codes, not the display name.
      protection_plan: PROTECTION_PLAN.pgPlanCode,
      protection_plan_price: PROTECTION_PLAN.price,
      email: customer.email,
      first_name: customer.firstName,
      last_name: customer.lastName,
      phone_number: customer.phone,
      reservation_start_time: startTime24,
      reservation_end_time: endTime24,
      car_make: vehicle.make,
      car_model: vehicle.model,
      booking_site: new URL(
        process.env.NEXT_PUBLIC_APP_URL || "https://www.triplypro.com"
      ).host,
    });

    const { error: pgUpdateError } = await supabase
      .from("bookings")
      .update({ pg_identifier: pgRes.pg_identifier, pg_sync_status: "synced" })
      .eq("id", bookingId);

    if (pgUpdateError) {
      const isDuplicate = (pgUpdateError as { code?: string }).code === "23505";
      captureParkGuardError(
        new Error(
          `Park Guard captured but local pg_identifier update failed${
            isDuplicate
              ? " (duplicate — pg_identifier already on another row)"
              : ""
          }: ${pgUpdateError.message}`
        ),
        {
          bookingId,
          reslabReservationNumber: reservation.reservation_number,
          operation: "update",
          pgIdentifier: pgRes.pg_identifier,
        }
      );
      // PG holds the enrolment but our row doesn't reflect it — leave sync
      // status null so the email and confirmation page both render "Confirming"
      // until ops repairs the row.
      return { pgIdentifier: pgRes.pg_identifier, pgSyncStatus: null };
    }

    return { pgIdentifier: pgRes.pg_identifier, pgSyncStatus: "synced" };
  } catch (pgError) {
    captureParkGuardError(
      pgError instanceof Error ? pgError : new Error(String(pgError)),
      {
        bookingId,
        reslabReservationNumber: reservation.reservation_number,
        operation: "capture",
        ...(pgError instanceof ParkGuardError && {
          statusCode: pgError.statusCode,
        }),
      }
    );
    return { pgIdentifier: null, pgSyncStatus: null };
  }
}

/**
 * Confirmation + admin notification emails.
 *
 * Returns whether the CUSTOMER email sent. The caller persists that on the
 * pending row so a crash between the booking insert and the send doesn't lose
 * the confirmation permanently — booking-by-PI idempotency would otherwise skip
 * the send forever on any re-drive.
 *
 * Unlike the pre-rehaul code, failures go to Sentry rather than console.error:
 * a customer who paid and never got their confirmation is a support incident,
 * and it was previously invisible outside Vercel logs.
 */
export async function sendBookingEmails(
  payload: BookingPayload,
  reservation: ReslabReservation,
  pgSyncStatus: PgSyncStatus
): Promise<{ customerEmailSent: boolean }> {
  const {
    locationId,
    fromDate,
    toDate,
    customer,
    vehicle,
    locationName,
    locationAddress,
    grandTotal,
    triplyServiceFee,
    airportCode,
    hasProtectionPlan,
    stripePaymentIntentId,
  } = payload;

  const resHistory = reservation.history?.[0];
  const resLocation = resHistory?.location;
  const shuttleDetails =
    stripHtml(resLocation?.shuttle_info_details ?? null) || undefined;
  const specialConditions =
    stripHtml(resLocation?.special_conditions ?? null) || undefined;

  const protectionPremium = hasProtectionPlan ? PROTECTION_PLAN.price : 0;
  const totalAmount =
    (resHistory?.grand_total ?? grandTotal ?? 0) +
    (triplyServiceFee || 0) +
    protectionPremium;

  const fullName = `${customer.firstName} ${customer.lastName}`;
  const vehicleInfo = `${vehicle.make} ${vehicle.model} (${vehicle.color}) - ${vehicle.licensePlate}`;

  let customerEmailSent = false;

  try {
    const [checkInDate, checkInTime24] = fromDate.split(" ");
    const [checkOutDate, checkOutTime24] = toDate.split(" ");
    await sendBookingConfirmation({
      to: customer.email,
      customerName: fullName,
      confirmationNumber: reservation.reservation_number,
      lotName: locationName || resLocation?.name || `Location ${locationId}`,
      lotAddress: locationAddress || resLocation?.address || "",
      checkInDate,
      checkOutDate,
      checkInTime: convertTo12Hour(checkInTime24),
      checkOutTime: convertTo12Hour(checkOutTime24),
      totalAmount,
      dueAtLocation: resHistory?.due_at_location_total || 0,
      vehicleInfo,
      shuttleDetails,
      specialConditions,
      ...(hasProtectionPlan && {
        protectionPlan: PROTECTION_PLAN.name,
        protectionPlanPrice: PROTECTION_PLAN.price,
      }),
      pgSyncStatus,
    });
    customerEmailSent = true;
  } catch (emailError) {
    captureBookingError(
      new Error(
        `Confirmation email failed for ${reservation.reservation_number}: ${
          emailError instanceof Error ? emailError.message : String(emailError)
        }`
      ),
      { step: "checkout", airportCode }
    );
    if (stripePaymentIntentId) {
      capturePaymentError(
        new Error(
          `Customer paid but confirmation email did not send (reservation ${reservation.reservation_number})`
        ),
        { stripePaymentIntentId, amount: totalAmount }
      );
    }
  }

  try {
    await sendAdminBookingNotification({
      confirmationNumber: reservation.reservation_number,
      customerName: fullName,
      customerEmail: customer.email,
      customerPhone: customer.phone,
      lotName: locationName || resLocation?.name || `Location ${locationId}`,
      lotAddress: locationAddress || resLocation?.address || "",
      checkInDate: fromDate.split(" ")[0],
      checkOutDate: toDate.split(" ")[0],
      totalAmount,
      dueAtLocation: resHistory?.due_at_location_total || 0,
      vehicleInfo,
      airportCode: airportCode || undefined,
      ...(hasProtectionPlan && {
        protectionPlan: PROTECTION_PLAN.name,
        protectionPlanPrice: PROTECTION_PLAN.price,
      }),
    });
  } catch (adminEmailError) {
    // Internal notification only — never escalated to a money event.
    captureBookingError(
      new Error(
        `Admin notification email failed for ${reservation.reservation_number}: ${
          adminEmailError instanceof Error
            ? adminEmailError.message
            : String(adminEmailError)
        }`
      ),
      { step: "checkout", airportCode }
    );
  }

  return { customerEmailSent };
}

/**
 * Shape the API response for a successfully created booking.
 */
export function buildReservationResponse(
  payload: BookingPayload,
  reservation: ReslabReservation,
  pgIdentifier: string | null
) {
  const resHistory = reservation.history?.[0];
  const resLocation = resHistory?.location;
  const protectionPremium = payload.hasProtectionPlan
    ? PROTECTION_PLAN.price
    : 0;
  const shuttleDetails =
    stripHtml(resLocation?.shuttle_info_details ?? null) || undefined;
  const specialConditions =
    stripHtml(resLocation?.special_conditions ?? null) || undefined;

  return {
    id: resHistory?.id || reservation.reservation_number,
    reservationNumber: reservation.reservation_number,
    status: reservation.cancelled ? "cancelled" : "confirmed",
    grandTotal:
      (resHistory?.grand_total ?? payload.grandTotal ?? 0) +
      (payload.triplyServiceFee || 0) +
      protectionPremium,
    serviceFee: payload.triplyServiceFee || 0,
    protectionPlan: payload.hasProtectionPlan ? PROTECTION_PLAN.name : null,
    protectionPlanPrice: protectionPremium,
    pgIdentifier,
    dueNow:
      (resHistory?.grand_total || 0) +
      (payload.triplyServiceFee || 0) +
      protectionPremium -
      (resHistory?.due_at_location_total || 0),
    dueAtLocation: resHistory?.due_at_location_total || 0,
    customer: {
      firstName: payload.customer.firstName,
      lastName: payload.customer.lastName,
      email: payload.customer.email,
      phone: payload.customer.phone,
    },
    items:
      resHistory?.dates?.map((date) => ({
        type: "parking",
        fromDate: date.from_date,
        toDate: date.to_date,
        numberOfDays: null,
        numberOfSpots: 1,
      })) || [],
    location: resLocation
      ? {
          id: resLocation.id,
          name: resLocation.name,
          address: resLocation.address,
          city: resLocation.city,
          state: resLocation.state?.code,
          zipCode: resLocation.zip_code,
          phone: resLocation.phone,
          shuttleDetails,
          specialConditions,
        }
      : null,
  };
}
